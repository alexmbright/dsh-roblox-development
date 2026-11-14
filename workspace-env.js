/**
 * Pure helpers for scoped Roblox workspace containment.
 *
 * Every function here is deterministic: platform and path flavor come from the
 * inputs (the per-command `sandboxPolicy.workspaceRoot` and an explicit
 * platform), never from `process.cwd()` or ambient state. Filesystem access is
 * confined to small injected `fsLike` seams so the tests stay hermetic.
 *
 * Containment model:
 * - Toolchain and cache state lives under `<workspaceRoot>/.dsh/roblox`.
 * - The caller environment map (`ShellExecSpec.env`) is overlaid: every
 *   case-variant of a managed name is removed first, then the canonical name is
 *   appended (Windows env blocks are case-insensitive; duplicate variants are
 *   undefined behavior at process creation).
 * - PATH is preserved and exact installed pinned tool directories are
 *   prepended. Executables are never copied into projects.
 * - The shell preamble re-asserts the same values inside the spawned shell,
 *   after the sandbox runner started (the Windows ACL runner overrides
 *   TEMP/TMP to its own private temp after the spec overlay). It also creates
 *   the owned directories and calls `scripts/prepare-workspace.mjs`. All of it
 *   rides on line 1 after `; ` separators (same pattern as the executor's
 *   ENCODING_PREAMBLE) so the original command's error line numbers are
 *   preserved exactly.
 *
 * This module never claims a security boundary. The lune guardrail is a UX
 * fail-fast only; the sandbox is the boundary.
 *
 * @module workspace-env
 */

import path from 'node:path';

/** Marker riding at the front of a composed command, per dialect. */
const PREAMBLE_MARKER = {
  pwsh: '<# dsh-roblox containment preamble #>',
  bash: ": 'dsh-roblox containment preamble'",
};

/**
 * Managed environment names and where their values point inside the state
 * directory (`<workspaceRoot>/.dsh/roblox`). `kind: 'file'` entries are file
 * paths whose parent directory must exist. HOMEDRIVE/HOMEPATH are added
 * dynamically for win32 flavor from the HOME split.
 */
export const OWNED_ENV = [
  { name: 'HOME', rel: 'home', kind: 'dir' },
  { name: 'USERPROFILE', rel: 'home', kind: 'dir' },
  { name: 'LOCALAPPDATA', rel: 'localappdata', kind: 'dir' },
  { name: 'APPDATA', rel: 'appdata', kind: 'dir' },
  { name: 'TEMP', rel: 'tmp', kind: 'dir' },
  { name: 'TMP', rel: 'tmp', kind: 'dir' },
  { name: 'TMPDIR', rel: 'tmp', kind: 'dir' },
  { name: 'XDG_CACHE_HOME', rel: 'xdg/cache', kind: 'dir' },
  { name: 'XDG_CONFIG_HOME', rel: 'xdg/config', kind: 'dir' },
  { name: 'XDG_DATA_HOME', rel: 'xdg/data', kind: 'dir' },
  { name: 'XDG_STATE_HOME', rel: 'xdg/state', kind: 'dir' },
  { name: 'npm_config_cache', rel: 'npm/cache', kind: 'dir' },
  { name: 'npm_config_userconfig', rel: 'npm/npmrc', kind: 'file' },
  { name: 'CARGO_HOME', rel: 'cargo', kind: 'dir' },
  { name: 'RUSTUP_HOME', rel: 'rustup', kind: 'dir' },
  { name: 'ROKIT_ROOT', rel: 'rokit', kind: 'dir' },
  { name: 'ROKIT_HOME', rel: 'rokit', kind: 'dir' },
  { name: 'AFTMAN_HOME', rel: 'aftman', kind: 'dir' },
  { name: 'WALLY_HOME', rel: 'wally', kind: 'dir' },
  { name: 'PESDE_HOME', rel: 'pesde', kind: 'dir' },
  { name: 'PYTHONPYCACHEPREFIX', rel: 'pycache', kind: 'dir' },
  { name: 'PIP_CACHE_DIR', rel: 'pip-cache', kind: 'dir' },
];

/** Single-quote a value for PowerShell (inside `'...'`). */
export function quotePwsh(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Single-quote a value for POSIX shells (inside `'...'`). */
export function quoteBash(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Path flavor of a root string: 'win32' for drive-letter/UNC roots, else 'posix'. */
export function pathFlavorOf(root) {
  return /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\') ? 'win32' : 'posix';
}

/**
 * Resolve the per-command workspace root from a resolved `ShellExecSpec`.
 * The root comes ONLY from the per-command `sandboxPolicy.workspaceRoot` —
 * never from `spec.workdir` or `process.cwd()` — and must be an absolute path.
 * @param spec - a resolved shell execution spec (or anything with sandboxPolicy).
 * @returns the absolute workspace root, or undefined when absent/unusable.
 */
export function workspaceRootOf(spec) {
  const root = spec?.sandboxPolicy?.workspaceRoot;
  if (typeof root !== 'string' || root.trim() === '') return undefined;
  const flavor = pathFlavorOf(root);
  const absolute = flavor === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
    : root.startsWith('/');
  return absolute ? root : undefined;
}

/**
 * The owned state layout for one workspace root: absolute env values, the
 * writable state directories that must exist (no executable directory).
 * @param workspaceRoot - absolute per-command sandbox workspace root.
 * @returns {{flavor: string, P: typeof path.win32, stateRoot: string, home: string,
 *   values: Record<string, string>, dirs: string[]}}
 */
export function stateLayout(workspaceRoot) {
  const flavor = pathFlavorOf(workspaceRoot);
  const P = flavor === 'win32' ? path.win32 : path.posix;
  const stateRoot = P.join(workspaceRoot, '.dsh', 'roblox');
  const values = {};
  const dirs = new Set([stateRoot]);
  for (const { name, rel, kind } of OWNED_ENV) {
    const abs = P.join(stateRoot, ...rel.split('/'));
    values[name] = abs;
    dirs.add(kind === 'file' ? P.dirname(abs) : abs);
  }
  if (flavor === 'win32') {
    const parsed = path.win32.parse(values.HOME);
    if (parsed.root !== '' && !values.HOME.startsWith('\\\\')) {
      const drive = parsed.root.replace(/[\\/]$/, '');
      values.HOMEDRIVE = drive;
      values.HOMEPATH = values.HOME.slice(drive.length);
    }
  }
  return { flavor, P, stateRoot, home: values.HOME, values, dirs: [...dirs] };
}

/**
 * Overlay a caller environment map with the managed containment values.
 *
 * ALL case-variants of managed names (including PATH) in `baseEnv` are removed
 * BEFORE the canonical names are appended, so no env block ever carries
 * duplicate case-variants. PATH is only touched when `toolDirs` is non-empty;
 * its value is `toolDirs.join(delimiter)` plus the original PATH
 * (`originalPath` wins over a PATH found in `baseEnv`).
 *
 * @param baseEnv - the caller's ordinary env map (`ShellExecSpec.env`).
 * @param opts - `{ layout, toolDirs?, originalPath? }`.
 * @returns {{ env: Record<string, string>, removed: string[] }}
 */
export function overlayEnv(baseEnv = {}, { layout, toolDirs = [], originalPath } = {}) {
  const caseInsensitive = layout.flavor === 'win32';
  const keyOf = (k) => (caseInsensitive ? k.toUpperCase() : k);
  const managed = new Set(Object.keys(layout.values).map(keyOf));
  const pathManaged = toolDirs.length > 0;
  const isManaged = (key) => managed.has(keyOf(key)) || (pathManaged && keyOf(key) === 'PATH');
  const env = {};
  const removed = [];
  let callerPath;
  for (const [key, value] of Object.entries(baseEnv)) {
    if (isManaged(key)) {
      removed.push(key);
      if (keyOf(key) === 'PATH') callerPath = value;
    } else {
      env[key] = value;
    }
  }
  for (const [name, value] of Object.entries(layout.values)) env[name] = value;
  if (pathManaged) {
    const original = originalPath ?? callerPath ?? '';
    env.PATH = [...toolDirs, original].filter((s) => typeof s === 'string' && s !== '').join(layout.P.delimiter);
  }
  return { env, removed };
}

function pwshStatements({ layout, env, writable, prepare, lune, checkMissingState, warnings = [], blockedTools = [], aliases = [] }) {
  const parts = [PREAMBLE_MARKER.pwsh];
  for (const warning of warnings) parts.push(`Write-Warning ${quotePwsh(warning)}`);
  for (const tool of aliases) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool.name)) parts.push(`function ${tool.name} { & ${quotePwsh(tool.executable)} @args }`);
  for (const name of blockedTools) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) parts.push(`function ${name} { Write-Error ${quotePwsh(`Roblox tool ${name} is unavailable at its exact pin. See roblox_setup_status / project pin warning; do not request Full access.`)}; exit 64 }`);
  if (writable) {
    parts.push(
      `try { New-Item -ItemType Directory -Force -Path ${layout.dirs.map(quotePwsh).join(',')} | Out-Null } `
      + `catch { Write-Warning ('dsh-roblox containment setup: ' + $_.Exception.Message) }`,
    );
  }
  for (const [name, value] of Object.entries(env)) parts.push(`$env:${name} = ${quotePwsh(value)}`);
  if (checkMissingState) {
    parts.push(
      `if (-not (Test-Path -LiteralPath ${quotePwsh(layout.stateRoot)})) `
      + `{ Write-Warning ('dsh-roblox: workspace state ' + ${quotePwsh(layout.stateRoot)} + ' is not initialized (read-only mode); tool caches are unavailable until a workspace-write command runs') }`,
    );
  }
  if (writable && Array.isArray(prepare?.seeds)) {
    for (const seed of prepare.seeds) parts.push(`if (-not (Test-Path -LiteralPath ${quotePwsh(seed.destination)})) { Copy-Item -LiteralPath ${quotePwsh(seed.source)} -Destination ${quotePwsh(seed.destination)} -ErrorAction Stop }`);
  }
  if (writable && prepare && typeof prepare.node === 'string' && typeof prepare.script === 'string') {
    const args = [prepare.script, ...(prepare.args ?? [])].map(quotePwsh).join(' ');
    parts.push(
      `try { $__dshrbEran = $env:ELECTRON_RUN_AS_NODE; $env:ELECTRON_RUN_AS_NODE = '1'; `
      + `& ${quotePwsh(prepare.node)} ${args}; $__dshrbRc = $LASTEXITCODE; `
      + `$env:ELECTRON_RUN_AS_NODE = $__dshrbEran; `
      + `if ($__dshrbRc -ne 0) { Write-Warning ('dsh-roblox prepare-workspace.mjs exit ' + $__dshrbRc) } } `
      + `catch { Write-Warning ('dsh-roblox prepare-workspace.mjs: ' + $_.Exception.Message) }`,
    );
  }
  if (lune && typeof lune.dest === 'string') {
    parts.push(
      `function lune { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest); `
      + `$sub = ''; if ($Rest.Count -gt 0) { $sub = $Rest[0] }; $t = $false; `
      + `foreach ($a in $Rest) { if ($a -eq '--target' -or $a -eq '-t' -or $a -like '--target=*' -or $a -like '-t=*') { $t = $true } }; `
      + `if ($sub -eq '' -or $sub -eq 'setup' -or $sub -eq 'repl' -or ($sub -eq 'build' -and $t)) { `
      + `Write-Error ('dsh-roblox: lune ' + $sub + ' is unsupported inside the workspace containment (Windows KnownFolders has no environment override). `
      + `Use lune run <script>, or a native lune build without --target. UX guardrail only, not a security boundary.'); exit 64 }; `
      + `& ${quotePwsh(lune.dest)} @Rest }`,
    );
  }
  return parts.join('; ');
}

function bashStatements({ layout, env, writable, prepare, lune, checkMissingState, warnings = [], blockedTools = [], aliases = [] }) {
  const parts = [PREAMBLE_MARKER.bash];
  for (const warning of warnings) parts.push(`echo ${quoteBash(warning)} >&2`);
  for (const tool of aliases) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(tool.name)) parts.push(`function ${tool.name}() { ${quoteBash(tool.executable)} "$@"; }`);
  for (const name of blockedTools) if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) parts.push(`function ${name}() { echo ${quoteBash(`Roblox tool ${name} is unavailable at its exact pin. See roblox_setup_status / project pin warning; do not request Full access.`)} >&2; return 64; }`);
  if (writable) {
    parts.push(`mkdir -p ${layout.dirs.map(quoteBash).join(' ')} 2>/dev/null || echo 'dsh-roblox containment setup: mkdir failed' >&2`);
  }
  for (const [name, value] of Object.entries(env)) parts.push(`export ${name}=${quoteBash(value)}`);
  if (checkMissingState) {
    parts.push(
      `if [ ! -d ${quoteBash(layout.stateRoot)} ]; then `
      + `echo ${quoteBash(`dsh-roblox: workspace state ${layout.stateRoot} is not initialized (read-only mode); tool caches are unavailable until a workspace-write command runs`)} >&2; fi`,
    );
  }
  if (writable && Array.isArray(prepare?.seeds)) {
    for (const seed of prepare.seeds) parts.push(`if [ ! -e ${quoteBash(seed.destination)} ]; then cp -n ${quoteBash(seed.source)} ${quoteBash(seed.destination)} || return 1 2>/dev/null || exit 1; fi`);
  }
  if (writable && prepare && typeof prepare.node === 'string' && typeof prepare.script === 'string') {
    const args = [prepare.script, ...(prepare.args ?? [])].map(quoteBash).join(' ');
    parts.push(
      `__dshrbEran="\${ELECTRON_RUN_AS_NODE-}"; export ELECTRON_RUN_AS_NODE=1; `
      + `${quoteBash(prepare.node)} ${args}; __dshrbRc=$?; `
      + `if [ -n "$__dshrbEran" ]; then export ELECTRON_RUN_AS_NODE="$__dshrbEran"; else unset ELECTRON_RUN_AS_NODE; fi; `
      + `if [ "$__dshrbRc" -ne 0 ]; then echo "dsh-roblox prepare-workspace.mjs exit $__dshrbRc" >&2; fi`,
    );
  }
  if (lune && typeof lune.dest === 'string') {
    parts.push(
      `lune() { local sub="\${1:-}"; local t=0; local a; for a in "$@"; do `
      + `case "$a" in --target|-t|--target=*|-t=*) t=1 ;; esac; done; `
      + `if [ -z "$sub" ] || [ "$sub" = setup ] || [ "$sub" = repl ] || { [ "$sub" = build ] && [ "$t" = 1 ]; }; then `
      + `echo ${quoteBash("dsh-roblox: lune ${sub} is unsupported inside the workspace containment (Windows KnownFolders has no environment override). Use lune run <script>, or a native lune build without --target. UX guardrail only, not a security boundary.")} >&2; `
      + `exit 64; fi; ${quoteBash(lune.dest)} "$@"; }`,
    );
  }
  return parts.join('; ');
}

/**
 * Build the containment preamble for one dialect.
 *
 * The output is ONE line (statements joined with `; `) so it can ride before
 * the original command without shifting the original command's error line
 * numbers. It never contains `exit` outside the lune guardrail's fail-fast
 * branch and never changes what the original command computes — bootstrap and
 * environment only.
 *
 * @param opts - `{ dialect: 'pwsh'|'bash', layout, env, writable, prepare?, lune?, checkMissingState? }`.
 *   `env` is the overlayEnv result to re-assert inside the shell (post-runner).
 *   `prepare` is `{ node, script, args? }`. `lune` is `{ dest }` or null.
 * @returns the preamble string (no trailing separator).
 */
export function buildPreamble(opts) {
  const { dialect } = opts;
  if (dialect === 'pwsh') return pwshStatements(opts);
  if (dialect === 'bash') return bashStatements(opts);
  throw new Error(`workspace-env: unsupported preamble dialect ${JSON.stringify(dialect)}`);
}

/**
 * Compose the final command: preamble statements first (line 1, `; `
 * separated), then the original command verbatim.
 */
export function composeCommand(preamble, command) {
  return `${preamble}; ${command}`;
}

/** Whether a command already carries this dialect's containment preamble. */
export function isPreambleMarked(command, dialect) {
  const marker = PREAMBLE_MARKER[dialect];
  return typeof marker === 'string' && typeof command === 'string' && command.startsWith(marker);
}

/**
 * Validate that the owned state path cannot escape the workspace through a
 * symlink/reparse point. Every existing component between the workspace root
 * and `<root>/.dsh/roblox` must be a real directory (junctions/symlinks are
 * rejected), and the deepest existing prefix must resolve inside the resolved
 * workspace root. Missing components are fine — the sandboxed preamble creates
 * them.
 * @param workspaceRoot - absolute workspace root.
 * @param fsLike - `{ lstatSync, realpathSync }` (realpathSync.native preferred).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateStateContainment(workspaceRoot, fsLike = {}) {
  const flavor = pathFlavorOf(workspaceRoot);
  const P = flavor === 'win32' ? path.win32 : path.posix;
  const realpath = (p) => {
    const fn = fsLike.realpathSync;
    if (typeof fn !== 'function') throw new Error('realpathSync unavailable');
    return typeof fn.native === 'function' ? fn.native(p) : fn(p);
  };
  const root = P.normalize(workspaceRoot);
  const { stateRoot } = stateLayout(workspaceRoot);
  let rootReal;
  try {
    rootReal = P.normalize(realpath(root));
  } catch (error) {
    return { ok: false, reason: `workspace root unreadable: ${String(error)}` };
  }
  const rel = P.relative(root, stateRoot);
  let current = root;
  for (const component of rel.split(P.sep).filter(Boolean)) {
    current = P.join(current, component);
    let st;
    try {
      st = fsLike.lstatSync(current);
    } catch {
      break; // not existing yet: the sandboxed preamble creates it
    }
    if (st.isSymbolicLink()) return { ok: false, reason: `state path component ${current} is a symlink/reparse point` };
    if (!st.isDirectory()) return { ok: false, reason: `state path component ${current} is not a directory` };
  }
  let deepest = stateRoot;
  for (;;) {
    try {
      fsLike.lstatSync(deepest);
      break;
    } catch {
      const parent = P.dirname(deepest);
      if (parent === deepest || deepest === root) {
        deepest = root;
        break;
      }
      deepest = parent;
    }
  }
  let real;
  try {
    real = P.normalize(realpath(deepest));
  } catch (error) {
    return { ok: false, reason: `state path unresolvable: ${String(error)}` };
  }
  const inside = real === rootReal
    || real.startsWith(rootReal.endsWith(P.sep) ? rootReal : rootReal + P.sep);
  return inside ? { ok: true } : { ok: false, reason: `state path resolves to ${real}, outside workspace root ${rootReal}` };
}

/**
 * Find the nearest manifest file among `names` by walking from `workdir` up to
 * and including `root`, never above the root.
 * @returns the manifest path, or undefined when none exists inside the root.
 */
export function findNearestManifest(workdir, root, names, fsLike = {}) {
  if (typeof workdir !== 'string' || workdir === '' || typeof root !== 'string' || root === '') return undefined;
  const flavor = pathFlavorOf(root);
  const P = flavor === 'win32' ? path.win32 : path.posix;
  const lower = (p) => (flavor === 'win32' ? p.toLowerCase() : p);
  const rootNorm = P.normalize(root);
  const inside = (p) => lower(p) === lower(rootNorm)
    || lower(p).startsWith(lower(rootNorm).endsWith(P.sep) ? lower(rootNorm) : lower(rootNorm) + P.sep);
  let dir = P.normalize(workdir);
  if (!inside(dir)) return undefined;
  for (;;) {
    for (const name of names) {
      const candidate = P.join(dir, name);
      try {
        if (fsLike.statSync(candidate).isFile()) return candidate;
      } catch { /* keep looking */ }
    }
    if (lower(dir) === lower(rootNorm)) return undefined;
    const parent = P.dirname(dir);
    if (parent === dir || !inside(parent)) return undefined;
    dir = parent;
  }
}

/**
 * Parse the `[tools]` section of a rokit.toml / aftman.toml manifest.
 * Format: `alias = "owner/repo@version"` (single quotes tolerated).
 * @returns an array of `{ alias, owner, repo, version }` pins, in file order.
 */
export function parseToolPins(text) {
  const pins = [];
  let inTools = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const section = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (section) {
      inTools = section[1] === 'tools';
      continue;
    }
    if (!inTools) continue;
    const m = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9._-]+)\s*=\s*"([^"]*)"$/)
      ?? line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9._-]+)\s*=\s*'([^']*)'$/);
    if (!m) continue;
    const alias = m[1].replace(/^["']|["']$/g, '');
    const sm = m[2].match(/^([^/@\s]+)\/([^/@\s]+)@(.+)$/);
    if (!sm) continue;
    pins.push({ alias, owner: sm[1], repo: sm[2], version: sm[3] });
  }
  return pins;
}

/**
 * Select the exact pinned executables from a tool-storage listing.
 *
 * Selection is EXACT-pin only: the store must contain `owner/repo/<version>/`
 * with an executable matching the repo or alias name (a sole `*.exe` in the
 * version directory is accepted on win32). A leading `v` on the version
 * spelling is tolerated (same version, cosmetic). There is NO silent
 * latest-version fallback: an unresolvable pin yields a diagnostic and no
 * executable.
 *
 * @param opts - `{ pins, storeListing, platform }` where `storeListing` is an
 *   array of relative paths like `owner/repo/version/name.exe`.
 * @returns {{ executables: Array<{alias, owner, repo, version, exeRelPath, exeName}>, diagnostics: Array<object> }}
 */
export function selectPinnedExecutables({ pins = [], storeListing = [], platform = 'win32' } = {}) {
  const ci = platform === 'win32';
  const ext = platform === 'win32' ? '.exe' : '';
  const norm = (s) => (ci ? s.toLowerCase() : s);
  const stripV = (s) => s.replace(/^v/i, '');
  const executables = [];
  const diagnostics = [];
  for (const pin of pins) {
    const dirKey = norm(`${pin.owner}/${pin.repo}`);
    const files = [];
    let versionSpelling;
    let dirSpelling;
    for (const entry of storeListing) {
      const parts = String(entry).split('/');
      if (parts.length < 4) continue;
      if (norm(`${parts[0]}/${parts[1]}`) !== dirKey) continue;
      if (norm(parts[2]) !== norm(pin.version) && stripV(norm(parts[2])) !== stripV(norm(pin.version))) continue;
      versionSpelling = parts[2];
      dirSpelling = `${parts[0]}/${parts[1]}`;
      files.push(parts.slice(3).join('/'));
    }
    if (files.length === 0) {
      diagnostics.push({ code: 'tool-version-not-found', alias: pin.alias, key: `${pin.owner}/${pin.repo}`, version: pin.version });
      continue;
    }
    const wanted = [norm(pin.repo + ext), norm(pin.alias + ext), norm(pin.repo), norm(pin.alias)];
    let exe = files.find((f) => wanted.includes(norm(f)));
    if (exe === undefined) {
      const candidates = ext ? files.filter((f) => norm(f).endsWith('.exe')) : files;
      if (candidates.length === 1) exe = candidates[0];
    }
    if (exe === undefined) {
      diagnostics.push({ code: 'tool-executable-not-found', alias: pin.alias, key: `${pin.owner}/${pin.repo}`, version: pin.version });
      continue;
    }
    executables.push({
      alias: pin.alias,
      owner: pin.owner,
      repo: pin.repo,
      version: versionSpelling,
      exeRelPath: `${dirSpelling}/${versionSpelling}/${exe}`,
      exeName: exe,
    });
  }
  return { executables, diagnostics };
}

/** Run exact pinned binaries in place. No downloads, copies, links or writes. */
export function toolExecutionPlan(executables = [], { storageRoot, flavor = pathFlavorOf(storageRoot) } = {}) {
  const P = flavor === 'win32' ? path.win32 : path.posix;
  const tools = executables.map(x => ({
    name: x.exeName.replace(/\.exe$/i, ''),
    version: x.version,
    executable: P.join(storageRoot, ...x.exeRelPath.split('/')),
  }));
  return { tools, toolDirs: [...new Set(tools.map(tool => P.dirname(tool.executable)))] };
}
