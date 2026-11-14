/**
 * Hermetic tests for scoped Roblox workspace containment.
 *
 * Runs with `node --test --test-isolation=none tests/workspace-env.test.mjs`
 * (no child-process spawn: the sandbox blocks named-pipe stdio).
 * Filesystem seams are faked except for two temp-tree integration tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OWNED_ENV,
  buildPreamble,
  composeCommand,
  findNearestManifest,
  isPreambleMarked,
  overlayEnv,
  parseToolPins,
  pathFlavorOf,
  quoteBash,
  quotePwsh,
  selectPinnedExecutables,
  stateLayout,
  toolExecutionPlan,
  validateStateContainment,
  workspaceRootOf,
} from '../workspace-env.js';
import {
  apply,
  createShellDelegate,
  discoverToolPlan,
  loadToolModule,
} from '../workspace-runtime.js';

const W = String.raw`C:\ws`;
const HOME_DIR = String.raw`C:\ws\.dsh\roblox\home`;
const TMP_DIR = String.raw`C:\ws\.dsh\roblox\tmp`;
const TOOLS_BIN = String.raw`C:\ws\.dsh\roblox\tools\bin`;
const LOCAL_APP_DATA = String.raw`C:\fixture-home\AppData\Local`;

/** Fake fs where nothing exists and realpath is the identity. */
function happyFs() {
  const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const realpathSync = (p) => p;
  realpathSync.native = (p) => p;
  return {
    lstatSync: () => { throw missing('x'); },
    statSync: () => { throw missing('x'); },
    readdirSync: () => [],
    readFileSync: () => { throw missing('x'); },
    existsSync: () => false,
    realpathSync,
  };
}

/** Fake fs where one path is a symlink/reparse point. */
function symlinkFs(linkPath) {
  const base = happyFs();
  return {
    ...base,
    lstatSync: (p) => {
      if (String(p).toLowerCase() === String(linkPath).toLowerCase()) {
        return { isSymbolicLink: () => true, isDirectory: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

/** Fake fs where one existing directory resolves outside the workspace. */
function escapeFs(existingDir, resolvesTo) {
  const base = happyFs();
  return {
    ...base,
    lstatSync: (p) => {
      if (String(p).toLowerCase() === String(existingDir).toLowerCase()) {
        return { isSymbolicLink: () => false, isDirectory: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    realpathSync: Object.assign((p) => (String(p).toLowerCase() === String(existingDir).toLowerCase() ? resolvesTo : p), {
      native: (p) => (String(p).toLowerCase() === String(existingDir).toLowerCase() ? resolvesTo : p),
    }),
  };
}

function fakeShell() {
  const resolved = [];
  const executed = [];
  return {
    sandboxMode: 'workspace-write',
    resolved,
    executed,
    resolve(request) {
      resolved.push(request);
      const spec = {
        command: request.command,
        workdir: request.workdir ?? String.raw`C:\default`,
        timeoutMs: request.timeoutMs ?? 1000,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 100,
        sandboxPolicy: request.sandboxPolicy,
      };
      if (request.signal !== undefined) spec.signal = request.signal;
      if (request.stdin !== undefined) spec.stdin = request.stdin;
      if (request.env !== undefined) spec.env = request.env;
      if (request.dshEnv !== undefined) spec.dshEnv = request.dshEnv;
      return spec;
    },
    async execute(spec) {
      executed.push(spec);
      return { result: async () => ({}) };
    },
  };
}

const planStub = {
  toolDirs: [TOOLS_BIN],
  copies: [{
    name: 'selene',
    version: '0.32.0',
    sourceAbs: String.raw`C:\fixture-home\.rokit\tool-storage\kampfkarren\selene\0.32.0\selene.exe`,
    destAbs: TOOLS_BIN + String.raw`\selene.exe`,
    verAbs: TOOLS_BIN + String.raw`\selene.exe.dshver`,
  }],
  lune: null,
  manifest: null,
  diagnostics: [],
};

function delegateFor(base, over = {}) {
  return createShellDelegate(base, {
    platform: 'win32',
    dialect: 'pwsh',
    originalEnv: { PATH: String.raw`C:\orig`, LOCALAPPDATA: LOCAL_APP_DATA, USERPROFILE: String.raw`C:\fixture-home` },
    fsLike: happyFs(),
    toolPlanFor: () => planStub,
    prepare: {
      nodePath: String.raw`C:\node.exe`,
      script: String.raw`C:\bundle\scripts\prepare-workspace.mjs`,
    },
    ...over,
  });
}

// ---------------------------------------------------------------- workspace roots

test('workspaceRootOf takes the root only from the per-command sandboxPolicy', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: W };
  assert.equal(workspaceRootOf({ sandboxPolicy: policy, workdir: String.raw`D:\other` }), W);
  // workdir / process cwd must never become the containment root
  assert.equal(workspaceRootOf({ workdir: W }), undefined);
  assert.equal(workspaceRootOf({}), undefined);
  assert.equal(workspaceRootOf({ sandboxPolicy: { workspaceRoot: '' } }), undefined);
  assert.equal(workspaceRootOf({ sandboxPolicy: { workspaceRoot: 'relative/path' } }), undefined);
  assert.equal(workspaceRootOf(undefined), undefined);
});

test('pathFlavorOf classifies drive-letter/UNC vs posix roots', () => {
  assert.equal(pathFlavorOf(String.raw`C:\ws`), 'win32');
  assert.equal(pathFlavorOf(String.raw`\\server\share\ws`), 'win32');
  assert.equal(pathFlavorOf('/ws'), 'posix');
});

// ---------------------------------------------------------------- state layout

test('stateLayout maps every owned env name under <root>/.dsh/roblox (win32)', () => {
  const layout = stateLayout(W);
  assert.equal(layout.stateRoot, String.raw`C:\ws\.dsh\roblox`);
  for (const { name, rel } of OWNED_ENV) {
    assert.equal(layout.values[name], String.raw`C:\ws\.dsh\roblox` + '\\' + rel.split('/').join('\\'), name);
    if (name !== 'npm_config_userconfig') {
      assert.ok(layout.values[name].startsWith(layout.stateRoot), name);
    }
  }
  // the user-named list is fully covered
  for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    'npm_config_cache', 'npm_config_userconfig', 'CARGO_HOME', 'RUSTUP_HOME',
    'ROKIT_ROOT', 'AFTMAN_HOME', 'WALLY_HOME', 'PESDE_HOME', 'PYTHONPYCACHEPREFIX', 'PIP_CACHE_DIR']) {
    assert.ok(layout.values[name], name);
  }
  // Windows home split is covered too
  assert.equal(layout.values.HOMEDRIVE, 'C:');
  assert.equal(layout.values.HOMEPATH, String.raw`\ws\.dsh\roblox\home`);
  assert.equal(layout.home, HOME_DIR);
  assert.ok(layout.dirs.includes(TMP_DIR));
  assert.ok(layout.dirs.includes(HOME_DIR));
  assert.equal(layout.toolsBin, undefined, 'no project-local executable directory');
});

test('stateLayout posix uses forward slashes and no HOMEDRIVE split', () => {
  const layout = stateLayout('/ws');
  assert.equal(layout.stateRoot, '/ws/.dsh/roblox');
  assert.equal(layout.values.HOME, '/ws/.dsh/roblox/home');
  assert.equal(layout.values.HOMEDRIVE, undefined);
});

// ---------------------------------------------------------------- env overlay

test('overlayEnv filters ALL caller case-variants before appending canonical values (win32)', () => {
  const layout = stateLayout(W);
  const { env, removed } = overlayEnv(
    { Home: 'x', HOME: 'y', home: 'z', TEMP: 't', Foo: 'f', Path: String.raw`a;b` },
    { layout, toolDirs: [TOOLS_BIN], originalPath: String.raw`C:\orig` },
  );
  assert.deepEqual(removed.sort(), ['HOME', 'Home', 'Path', 'TEMP', 'home'].sort());
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'Home'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'home'), false);
  assert.equal(env.HOME, HOME_DIR);
  assert.equal(env.TEMP, TMP_DIR);
  assert.equal(env.Foo, 'f');
  assert.equal(env.PATH, TOOLS_BIN + ';' + String.raw`C:\orig`);
});

test('overlayEnv PATH prepend falls back to the caller PATH and preserves unrelated vars', () => {
  const layout = stateLayout(W);
  const { env } = overlayEnv({ Path: String.raw`a;b`, SystemRoot: String.raw`C:\Windows` }, { layout, toolDirs: [TOOLS_BIN] });
  assert.equal(env.PATH, TOOLS_BIN + ';' + String.raw`a;b`);
  assert.equal(env.SystemRoot, String.raw`C:\Windows`);
});

test('overlayEnv leaves PATH untouched when there are no tool dirs', () => {
  const layout = stateLayout(W);
  const { env, removed } = overlayEnv({ Path: String.raw`a;b` }, { layout, toolDirs: [] });
  assert.equal(env.Path, String.raw`a;b`);
  assert.ok(!removed.includes('Path'));
});

test('overlayEnv posix filters exact names only (case-sensitive env)', () => {
  const layout = stateLayout('/ws');
  const { env, removed } = overlayEnv({ home: 'z', HOME: 'y', FOO: 'f' }, { layout, toolDirs: ['/ws/.dsh/roblox/tools/bin'], originalPath: '/usr/bin' });
  assert.equal(env.home, 'z'); // different variable on POSIX
  assert.equal(env.HOME, '/ws/.dsh/roblox/home');
  assert.deepEqual(removed, ['HOME']);
  assert.equal(env.PATH, '/ws/.dsh/roblox/tools/bin:/usr/bin');
  assert.equal(env.FOO, 'f');
});

// ---------------------------------------------------------------- preamble

function pwshOpts(over = {}) {
  const layout = stateLayout(W);
  const { env } = overlayEnv({ FOO: '1' }, { layout, toolDirs: [TOOLS_BIN], originalPath: String.raw`C:\orig` });
  return {
    dialect: 'pwsh',
    layout,
    env,
    writable: true,
    copies: planStub.copies,
    prepare: {
      node: String.raw`C:\node.exe`,
      script: String.raw`C:\bundle\scripts\prepare-workspace.mjs`,
      args: [W, String.raw`C:\ws\proj`, LOCAL_APP_DATA],
    },
    lune: { dest: TOOLS_BIN + String.raw`\lune.exe` },
    checkMissingState: false,
    ...over,
  };
}

test('pwsh preamble bootstraps state, re-asserts env post-runner, prepares, and guards lune', () => {
  const p = buildPreamble(pwshOpts());
  assert.ok(p.startsWith('<# dsh-roblox containment preamble #>'));
  assert.ok(!p.includes('\n'), 'preamble must ride on line 1 to keep error line numbers');
  // writable setup
  assert.ok(p.includes('New-Item -ItemType Directory -Force'));
  assert.ok(p.includes(`'${TMP_DIR}'`));
  // env re-assertion AFTER runner startup (fixes ACL-runner TEMP/TMP override)
  assert.ok(p.includes(`$env:TEMP = '${TMP_DIR}'`));
  assert.ok(p.includes(`$env:TMP = '${TMP_DIR}'`));
  assert.ok(p.includes(`$env:TMPDIR = '${TMP_DIR}'`));
  assert.ok(p.includes(`$env:HOME = '${HOME_DIR}'`));
  assert.ok(p.includes(`$env:PATH = '${TOOLS_BIN};C:\\orig'`));
  // Executables run in place; even legacy copy-plan input must not copy.
  assert.ok(!p.includes('Copy-Item'));
  assert.ok(!p.includes('.dshver'));
  // prepare-workspace.mjs invocation (positional contract)
  assert.ok(p.includes(`& 'C:\\node.exe' 'C:\\bundle\\scripts\\prepare-workspace.mjs' '${W}' 'C:\\ws\\proj' '${LOCAL_APP_DATA}'`));
  assert.ok(p.includes("ELECTRON_RUN_AS_NODE = '1'"));
  // lune guardrail: UX fail-fast only
  assert.ok(p.includes('function lune'));
  assert.ok(p.includes("eq 'setup'"));
  assert.ok(p.includes("eq 'repl'"));
  assert.ok(p.includes('--target'));
  assert.ok(p.includes('exit 64'));
  assert.ok(p.includes('@Rest'));
  assert.ok(p.includes('UX guardrail only'));
});

test('pwsh read-only preamble writes nothing and reports the missing cache', () => {
  const p = buildPreamble(pwshOpts({ writable: false, copies: [], prepare: null, checkMissingState: true }));
  assert.ok(!p.includes('New-Item'), 'read-only must not mkdir');
  assert.ok(!p.includes('Copy-Item'), 'read-only must not copy');
  assert.ok(!p.includes('prepare-workspace.mjs'), 'read-only must not run prepare');
  assert.ok(p.includes('not initialized (read-only mode)'));
  assert.ok(p.includes(`$env:HOME = '${HOME_DIR}'`), 'env containment still applies');
});

test('bash preamble mirrors the pwsh bootstrap', () => {
  const opts = pwshOpts({ dialect: 'bash' });
  const p = buildPreamble(opts);
  assert.ok(p.startsWith(": 'dsh-roblox containment preamble'"));
  assert.ok(!p.includes('\n'));
  assert.ok(p.includes('mkdir -p'));
  assert.ok(p.includes(`export HOME='${HOME_DIR}'`));
  assert.ok(p.includes(`export PATH='${TOOLS_BIN};C:\\orig'`));
  assert.ok(p.includes("ELECTRON_RUN_AS_NODE=1"));
  assert.ok(p.includes('prepare-workspace.mjs'));
  assert.ok(p.includes('lune() {'));
  assert.ok(p.includes('exit 64'));
});

test('preamble quoting escapes embedded quotes per dialect', () => {
  assert.equal(quotePwsh(String.raw`C:\w's dir`), String.raw`'C:\w''s dir'`);
  assert.equal(quoteBash(String.raw`C:\w's dir`), String.raw`'C:\w'\''s dir'`);
  const layout = stateLayout(String.raw`C:\w's`);
  const p = buildPreamble({ dialect: 'pwsh', layout, env: { HOME: layout.values.HOME }, writable: false, copies: [], prepare: null, lune: null });
  assert.ok(p.includes("$env:HOME = 'C:\\w''s\\.dsh\\roblox\\home'"), 'pwsh doubles embedded single quotes');
  const b = buildPreamble({ dialect: 'bash', layout, env: { HOME: layout.values.HOME }, writable: false, copies: [], prepare: null, lune: null });
  assert.ok(b.includes(String.raw`w'\''s`), 'bash escapes embedded single quotes');
});

test('buildPreamble rejects unknown dialects', () => {
  assert.throws(() => buildPreamble({ dialect: 'csh', layout: stateLayout(W), env: {} }), /unsupported preamble dialect/);
});

test('composeCommand keeps the preamble on line 1 and isPreambleMarked detects it', () => {
  const p = buildPreamble(pwshOpts());
  const composed = composeCommand(p, "Get-ChildItem\nSecond-Line");
  assert.ok(composed.endsWith("Get-ChildItem\nSecond-Line"));
  assert.ok(isPreambleMarked(composed, 'pwsh'));
  assert.equal(isPreambleMarked('Get-ChildItem', 'pwsh'), false);
  assert.equal(isPreambleMarked(composed, 'bash'), false);
  assert.equal(composed.slice(0, p.length), p);
});

// ---------------------------------------------------------------- tool pins

test('parseToolPins reads the real rokit/aftman [tools] format', () => {
  const pins = parseToolPins([
    '# comment',
    '',
    '[tools]',
    'lune = "lune-org/lune@0.11.1"',
    'selene = "Kampfkarren/selene@0.32.0"',
    'StyLua = \'JohnnyMorganz/StyLua@2.6.0\'',
    'luau-lsp = "JohnnyMorganz/luau-lsp@1.70.1"',
    '',
    '[other]',
    'ignored = "x/y@1.0.0"',
  ].join('\n'));
  assert.deepEqual(pins, [
    { alias: 'lune', owner: 'lune-org', repo: 'lune', version: '0.11.1' },
    { alias: 'selene', owner: 'Kampfkarren', repo: 'selene', version: '0.32.0' },
    { alias: 'StyLua', owner: 'JohnnyMorganz', repo: 'StyLua', version: '2.6.0' },
    { alias: 'luau-lsp', owner: 'JohnnyMorganz', repo: 'luau-lsp', version: '1.70.1' },
  ]);
});

const STORE = [
  'Kampfkarren/selene/0.31.0/selene.exe',
  'Kampfkarren/selene/0.32.0/selene.exe',
  'lune-org/lune/0.11.1/lune.exe',
  'johnnymorganz/stylua/2.6.0/stylua.exe',
];

test('selectPinnedExecutables picks the EXACT pinned version, never the latest', () => {
  const { executables, diagnostics } = selectPinnedExecutables({
    pins: [
      { alias: 'selene', owner: 'Kampfkarren', repo: 'selene', version: '0.31.0' },
      { alias: 'lune', owner: 'lune-org', repo: 'lune', version: '0.11.1' },
    ],
    storeListing: STORE,
    platform: 'win32',
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(executables[0].exeRelPath, 'Kampfkarren/selene/0.31.0/selene.exe');
  assert.equal(executables[1].exeRelPath, 'lune-org/lune/0.11.1/lune.exe');
});

test('selectPinnedExecutables never silently falls back across versions', () => {
  const { executables, diagnostics } = selectPinnedExecutables({
    pins: [{ alias: 'selene', owner: 'Kampfkarren', repo: 'selene', version: '0.33.0' }],
    storeListing: STORE,
    platform: 'win32',
  });
  assert.deepEqual(executables, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'tool-version-not-found');
  assert.equal(diagnostics[0].version, '0.33.0');
});

test('selectPinnedExecutables tolerates a leading v and matches exe names case-insensitively on win32', () => {
  const { executables } = selectPinnedExecutables({
    pins: [
      { alias: 'StyLua', owner: 'JohnnyMorganz', repo: 'StyLua', version: '2.6.0' },
      { alias: 'x', owner: 'o', repo: 'x', version: '1.2.3' },
    ],
    storeListing: [...STORE, 'o/x/v1.2.3/x.exe'],
    platform: 'win32',
  });
  assert.equal(executables[0].exeRelPath, 'johnnymorganz/stylua/2.6.0/stylua.exe');
  assert.equal(executables[1].exeRelPath, 'o/x/v1.2.3/x.exe');
});

test('selectPinnedExecutables reports a missing executable instead of guessing', () => {
  const { executables, diagnostics } = selectPinnedExecutables({
    pins: [{ alias: 'selene', owner: 'Kampfkarren', repo: 'selene', version: '0.32.0' }],
    storeListing: ['Kampfkarren/selene/0.32.0/readme.txt', 'Kampfkarren/selene/0.32.0/other.exe', 'Kampfkarren/selene/0.32.0/more.exe'],
    platform: 'win32',
  });
  assert.deepEqual(executables, []);
  assert.equal(diagnostics[0].code, 'tool-executable-not-found');
});

test('toolExecutionPlan uses exact installed executables without project copies', () => {
  const { executables } = selectPinnedExecutables({
    pins: [{ alias: 'selene', owner: 'Kampfkarren', repo: 'selene', version: '0.32.0' }],
    storeListing: STORE,
    platform: 'win32',
  });
  const plan = toolExecutionPlan(executables, {
    storageRoot: String.raw`C:\fixture-home\.rokit\tool-storage`,
  });
  assert.equal(plan.tools.length, 1);
  assert.equal(plan.tools[0].executable, String.raw`C:\fixture-home\.rokit\tool-storage\Kampfkarren\selene\0.32.0\selene.exe`);
  assert.equal(plan.tools[0].version, '0.32.0');
  assert.deepEqual(plan.toolDirs, [String.raw`C:\fixture-home\.rokit\tool-storage\Kampfkarren\selene\0.32.0`]);
  assert.equal(plan.copies, undefined);
});

// ---------------------------------------------------------------- containment checks

test('validateStateContainment accepts plain state paths', () => {
  assert.deepEqual(validateStateContainment(W, happyFs()), { ok: true });
});

test('validateStateContainment rejects symlink/reparse state before any setup', () => {
  const r = validateStateContainment(W, symlinkFs(String.raw`C:\ws\.dsh`));
  assert.equal(r.ok, false);
  assert.match(r.reason, /symlink\/reparse/);
});

test('validateStateContainment rejects state resolving outside the workspace', () => {
  const r = validateStateContainment(W, escapeFs(String.raw`C:\ws\.dsh`, String.raw`D:\elsewhere\.dsh`));
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside workspace root/);
});

test('validateStateContainment fails closed when the root is unreadable', () => {
  const fsLike = happyFs();
  fsLike.realpathSync = Object.assign(() => { throw new Error('EACCES'); }, { native: () => { throw new Error('EACCES'); } });
  const r = validateStateContainment(W, fsLike);
  assert.equal(r.ok, false);
  assert.match(r.reason, /workspace root unreadable/);
});

test('findNearestManifest walks to the nearest manifest inside the root and never above it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-manifest-'));
  try {
    const root = path.join(base, 'ws');
    const sub = path.join(root, 'proj', 'nested');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(base, 'above'), { recursive: true });
    fs.writeFileSync(path.join(root, 'rokit.toml'), '[tools]\n');
    fs.writeFileSync(path.join(sub, 'rokit.toml'), '[tools]\n');
    fs.writeFileSync(path.join(base, 'above', 'rokit.toml'), '[tools]\n');
    assert.equal(findNearestManifest(sub, root, ['rokit.toml'], fs), path.join(sub, 'rokit.toml'));
    assert.equal(findNearestManifest(path.join(root, 'proj'), root, ['rokit.toml'], fs), path.join(root, 'rokit.toml'));
    assert.equal(findNearestManifest(root, root, ['aftman.toml'], fs), undefined);
    // a manifest ABOVE the root is never reached
    assert.equal(findNearestManifest(root, root, ['nope.toml'], fs), undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- delegate: fake shell

test('delegate resolve overlays env and preserves root/policy/args/signal exactly', () => {
  const base = fakeShell();
  const delegate = delegateFor(base);
  const ac = new AbortController();
  const policy = { mode: 'workspace-write', workspaceRoot: W };
  const out = delegate.resolve({
    command: 'echo hi',
    workdir: String.raw`C:\ws\proj`,
    timeoutMs: 500,
    onExpiry: 'none',
    stdoutMaxBytes: 42,
    signal: ac.signal,
    stdin: 'abc',
    env: { FOO: '1', Home: 'x' },
    dshEnv: { DSH_SHELL: 'pwsh' },
    sandboxPolicy: policy,
  });
  assert.equal(out.command, 'echo hi', 'resolve must not rewrite the command');
  assert.equal(out.workdir, String.raw`C:\ws\proj`);
  assert.equal(out.timeoutMs, 500);
  assert.equal(out.onExpiry, 'none');
  assert.equal(out.stdoutMaxBytes, 42);
  assert.equal(out.signal, ac.signal);
  assert.equal(out.stdin, 'abc');
  assert.deepEqual(out.dshEnv, { DSH_SHELL: 'pwsh' });
  assert.equal(out.sandboxPolicy, policy);
  assert.equal(out.sandboxPolicy.workspaceRoot, W);
  // env containment: canonical values, case-variants gone, PATH prepended
  assert.equal(out.env.HOME, HOME_DIR);
  assert.equal(out.env.TEMP, TMP_DIR);
  assert.equal(out.env.FOO, '1');
  assert.equal(Object.prototype.hasOwnProperty.call(out.env, 'Home'), false);
  assert.equal(out.env.PATH, TOOLS_BIN + ';' + String.raw`C:\orig`);
  assert.equal(delegate.sandboxMode, base.sandboxMode);
});

test('delegate execute composes the preamble once and passes the untouched spec through', async () => {
  const base = fakeShell();
  const delegate = delegateFor(base);
  const ac = new AbortController();
  const spec = delegate.resolve({
    command: 'echo hi',
    workdir: String.raw`C:\ws\proj`,
    signal: ac.signal,
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: W },
  });
  await delegate.execute(spec);
  assert.equal(base.executed.length, 1);
  const sent = base.executed[0];
  assert.ok(isPreambleMarked(sent.command, 'pwsh'));
  assert.ok(sent.command.endsWith('; echo hi'));
  assert.ok(sent.command.includes('New-Item'), 'write mode bootstraps directories');
  assert.ok(sent.command.includes('prepare-workspace.mjs'), 'write mode prepares');
  assert.equal(sent.signal, ac.signal);
  assert.equal(sent.workdir, spec.workdir);
  assert.equal(sent.timeoutMs, spec.timeoutMs);
  assert.equal(sent.sandboxPolicy.workspaceRoot, W);
  assert.deepEqual(sent.env, spec.env, 'execute re-applies the overlay idempotently');
  // second execute of the composed command must not stack preambles
  await delegate.execute({ ...spec, command: sent.command });
  assert.equal(base.executed.length, 2);
  assert.equal(base.executed[1].command, sent.command);
});

test('delegate execute in read-only mode performs no setup writes', async () => {
  const base = fakeShell();
  const delegate = delegateFor(base);
  const spec = delegate.resolve({
    command: 'Get-ChildItem',
    sandboxPolicy: { mode: 'read-only', workspaceRoot: W },
  });
  await delegate.execute(spec);
  const sent = base.executed[0];
  assert.ok(isPreambleMarked(sent.command, 'pwsh'));
  assert.ok(!sent.command.includes('New-Item'));
  assert.ok(!sent.command.includes('Copy-Item'));
  assert.ok(!sent.command.includes('prepare-workspace.mjs'));
  assert.ok(sent.command.includes('not initialized (read-only mode)'));
  assert.ok(sent.command.includes(`$env:HOME = '${HOME_DIR}'`));
});

test('delegate passes through without a sandboxPolicy and reports it', async () => {
  const base = fakeShell();
  const delegate = delegateFor(base);
  const spec = delegate.resolve({ command: 'echo hi', env: { FOO: '1' } });
  assert.equal(spec.env.FOO, '1');
  await delegate.execute(spec);
  assert.equal(base.executed[0].command, 'echo hi', 'no containment without a workspace root');
  assert.ok(delegate.diagnostics.some((d) => d.code === 'no-workspace-root'));
});

test('delegate fails before command execution on symlinked state', async () => {
  const base = fakeShell();
  const delegate = delegateFor(base, { fsLike: symlinkFs(String.raw`C:\ws\.dsh`) });
  const spec = delegate.resolve({
    command: 'echo hi',
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: W },
  });
  assert.equal(spec.env, undefined, 'escape must not even overlay env');
  assert.throws(() => delegate.execute(spec), /no command was executed/);
  assert.equal(base.executed.length, 0);
  assert.ok(delegate.diagnostics.some((d) => d.code === 'state-escape'));
});

test('delegate reports unsupported terminals and stays transparent', async () => {
  const base = fakeShell();
  const delegate = delegateFor(base, { dialect: 'csh' });
  const spec = delegate.resolve({
    command: 'echo hi',
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: W },
  });
  await delegate.execute(spec);
  assert.equal(base.executed[0].command, 'echo hi');
  assert.ok(delegate.diagnostics.some((d) => d.code === 'unsupported-dialect'));
});

// ---------------------------------------------------------------- runtime wiring

function fixtureToolTree(dir, names) {
  for (const [pkg, body] of Object.entries(names)) {
    const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${pkg}`, type: 'module', main: 'index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), body);
  }
}

function fakeCtx(base) {
  const calls = [];
  let fiberAwaited = false;
  const child = {
    provide: (n, v) => calls.push(['provide', n, v]),
    plugin: (m, c) => {
      calls.push(['plugin', m, c]);
      return {
        then() {
          fiberAwaited = true;
          throw new Error('child fiber must not be awaited');
        },
      };
    },
  };
  const ctx = {
    shell: base,
    profileContext: { installAnchor: '' },
    isolate: (n) => {
      calls.push(['isolate', n]);
      return child;
    },
    systemPrompt: {
      section: (s) => calls.push(['section', s]),
      getSectionOrder: () => 7,
    },
    subprocess: { resolveExecutable: async () => 'node' },
    tools: { guard: g => calls.push(['guard', g]) },
    logger: { warn: (m) => calls.push(['warn', m]) },
  };
  return { ctx, calls, wasFiberAwaited: () => fiberAwaited };
}

test('loadToolModule resolves pwsh-first on win32 and falls back to bash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-tools-'));
  try {
    fixtureToolTree(dir, {
      'dsh-tool-pwsh': "export default { marker: 'pwsh-tool' };\n",
      'dsh-tool-bash': "export default { marker: 'bash-tool' };\n",
    });
    const anchor = path.join(dir, 'anchor.mjs');
    const pwsh = await loadToolModule(anchor, 'win32');
    assert.equal(pwsh.dialect, 'pwsh');
    assert.equal(pwsh.module.default.marker, 'pwsh-tool');
    const bash = await loadToolModule(anchor, 'linux');
    assert.equal(bash.dialect, 'bash');
    assert.equal(bash.module.default.marker, 'bash-tool');
    const fallback = await loadToolModule(anchor, 'win32', async (url) => import(`${url}?fallback`));
    assert.equal(fallback.dialect, 'pwsh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadToolModule reports an unsupported shell tool set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-empty-'));
  try {
    await assert.rejects(
      () => loadToolModule(path.join(dir, 'anchor.mjs'), 'win32'),
      /unsupported shell tool set/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply isolates shell, provides the delegate, and mounts the tool without awaiting the fiber', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-apply-'));
  try {
    fixtureToolTree(dir, { 'dsh-tool-pwsh': "export default { marker: 'pwsh-tool' };\n" });
    const base = fakeShell();
    const { ctx, calls, wasFiberAwaited } = fakeCtx(base);
    ctx.profileContext.installAnchor = path.join(dir, 'anchor.mjs');
    await apply(ctx, { platform: 'win32', fsLike: happyFs() });
    assert.equal(wasFiberAwaited(), false);
    const isolateAt = calls.findIndex((c) => c[0] === 'isolate');
    const provideAt = calls.findIndex((c) => c[0] === 'provide');
    const pluginAt = calls.findIndex((c) => c[0] === 'plugin');
    assert.ok(isolateAt >= 0 && calls[isolateAt][1] === 'shell');
    assert.ok(provideAt > isolateAt, 'provide happens inside the isolated scope');
    assert.ok(pluginAt > provideAt, 'the tool mounts after the delegate is provided');
    const [, name, delegate] = calls[provideAt];
    assert.equal(name, 'shell');
    assert.equal(typeof delegate.resolve, 'function');
    assert.equal(typeof delegate.execute, 'function');
    assert.equal(delegate.sandboxMode, base.sandboxMode);
    const [, module, config] = calls[pluginAt];
    assert.equal(module.marker, 'pwsh-tool', 'default export wins');
    assert.deepEqual(config, {});
    const section = calls.find((c) => c[0] === 'section');
    assert.equal(section[1].name, 'roblox-workspace-containment');
    assert.match(section[1].text, /KnownFolders/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply reports an unusable anchor and a missing executor', async () => {
  const base = fakeShell();
  const { ctx } = fakeCtx(base);
  await assert.rejects(() => apply(ctx, {}), /installAnchor/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-noanchor-'));
  try {
    const { ctx: ctx2 } = fakeCtx(base);
    ctx2.profileContext.installAnchor = path.join(dir, 'anchor.mjs');
    await assert.rejects(() => apply(ctx2, { platform: 'win32' }), /unsupported shell tool set/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- plan discovery

test('discoverToolPlan runs exact installed pins without project duplication', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roblox-plan-'));
  try {
    const home = path.join(base, 'home');
    const root = path.join(base, 'ws');
    const workdir = path.join(root, 'proj');
    fs.mkdirSync(workdir, { recursive: true });
    fs.mkdirSync(path.join(home, '.rokit', 'tool-storage', 'Kampfkarren', 'selene', '0.32.0'), { recursive: true });
    fs.mkdirSync(path.join(home, '.rokit', 'tool-storage', 'lune-org', 'lune', '0.11.1'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rokit', 'tool-storage', 'Kampfkarren', 'selene', '0.32.0', 'selene.exe'), 'x');
    fs.writeFileSync(path.join(home, '.rokit', 'tool-storage', 'lune-org', 'lune', '0.11.1', 'lune.exe'), 'x');
    fs.writeFileSync(path.join(home, '.rokit', 'rokit.toml'), [
      '[tools]',
      'lune = "lune-org/lune@0.11.1"',
      'selene = "Kampfkarren/selene@0.32.0"',
    ].join('\n'));
    const plan = discoverToolPlan({
      workdir,
      root,
      originalEnv: { USERPROFILE: home, PATH: String.raw`C:\orig` },
      fsLike: fs,
      platform: 'win32',
    });
    assert.equal(plan.toolDirs.length, 2);
    assert.ok(plan.toolDirs.every(dir => dir.startsWith(path.join(home, '.rokit', 'tool-storage'))));
    assert.equal(plan.tools.length, 2);
    assert.equal(plan.copies, undefined);
    const selene = plan.tools.find(tool => tool.name === 'selene');
    assert.ok(selene.executable.endsWith(path.join('Kampfkarren', 'selene', '0.32.0', 'selene.exe')));
    assert.equal(plan.lune.dest, plan.tools.find(tool => tool.name === 'lune').executable);
    // a project manifest inside the root wins over the global one
    fs.writeFileSync(path.join(root, 'rokit.toml'), '[tools]\nselene = "Kampfkarren/selene@0.32.0"\n');
    const projectPlan = discoverToolPlan({
      workdir,
      root,
      originalEnv: { USERPROFILE: home },
      fsLike: fs,
      platform: 'win32',
    });
    assert.equal(projectPlan.tools.length, 1);
    assert.equal(projectPlan.lune, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
