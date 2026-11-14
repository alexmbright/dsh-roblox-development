/**
 * Scoped Roblox workspace containment runtime.
 *
 * Mounts the model-facing shell tool (`@deepseek-ai/dsh-tool-pwsh` or
 * `@deepseek-ai/dsh-tool-bash`, resolved from `profileContext.installAnchor`)
 * inside a `ctx.isolate('shell')` child whose `shell` service is a plain
 * delegate over the real executor. The delegate redirects routine toolchain
 * writes into `<sandboxPolicy.workspaceRoot>/.dsh/roblox` via the per-command
 * env overlay plus an in-shell bootstrap preamble. Exact pinned executables
 * run in place from the existing machine installation; no project copies.
 *
 * Hard rules honored here:
 * - The workspace root comes ONLY from the per-command
 *   `spec.sandboxPolicy.workspaceRoot` (never cwd / process.cwd()).
 * - No host filesystem writes at all: local state directories are created by
 *   the sandboxed shell preamble; host access is read-only (pin discovery).
 * - Read-only mode performs no setup writes; it reports a missing-cache
 *   diagnostic instead.
 * - Symlink/reparse state fails before command execution rather than silently
 *   reverting to a profile-writing environment.
 * - The child fiber is never awaited inside `apply`.
 * - The lune guardrail is UX-only (fail-fast with an actionable message); the
 *   sandbox is the security boundary. No claim is made that environment
 *   redirection fixes Windows KnownFolders lookups.
 *
 * @module workspace-runtime
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildPreamble,
  composeCommand,
  findNearestManifest,
  isPreambleMarked,
  overlayEnv,
  parseToolPins,
  pathFlavorOf,
  selectPinnedExecutables,
  stateLayout,
  toolExecutionPlan,
  validateStateContainment,
  workspaceRootOf,
} from './workspace-env.js';

export const name = 'roblox-workspace-runtime';
export const inject = ['shell', 'profileContext', 'tools', 'systemPrompt'];

const TOOL_MODULES = {
  pwsh: '@deepseek-ai/dsh-tool-pwsh',
  bash: '@deepseek-ai/dsh-tool-bash',
};

const CONTAINMENT_NOTE = 'Roblox workspace containment is active for shell commands: home/config/cache/temp environment '
  + '(HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP/TMP, XDG_*, npm, cargo/rustup, rokit/aftman, wally/pesde, python caches) '
  + 'is redirected into `.dsh/roblox` under the sandbox workspace root, and the shell preamble seeds those directories and '
  + 'seeds a workspace-local `roblox.yml` next to the nearest in-workspace `selene.toml` using native shell file operations (no system Node). Shared toolchain setup is plugin-owned; inspect failures with roblox_setup_status, never install tools through a model shell. Exact pinned installed toolchain binaries run directly from the '
  + 'read-only global tool storage, with their directories prepended to PATH; no per-project executable copies. Lune `setup`, `repl`, bare invocation, and cross-target '
  + '`build --target` fail fast with an actionable message: the Windows KnownFolders API has no environment override '
  + '(UX guardrail only — the sandbox is the security boundary). DSH runner-internal temp/logging stays outside the '
  + 'workspace (Host implementation boundary).';

/**
 * Resolve and import the shell tool module from the profile install anchor.
 * Windows prefers the pwsh tool, POSIX the bash tool; the other is a fallback.
 * @returns `{ module, dialect, specifier, resolved }`.
 * @throws when neither candidate resolves — an unsupported shell tool set is
 *   reported loudly instead of silently dropping the shell tool.
 */
export async function loadToolModule(installAnchor, platform = process.platform, importer) {
  const load = importer ?? ((url) => import(url));
  const order = platform === 'win32' ? ['pwsh', 'bash'] : ['bash', 'pwsh'];
  const require_ = createRequire(installAnchor);
  for (const kind of order) {
    const specifier = TOOL_MODULES[kind];
    let resolved;
    try {
      resolved = require_.resolve(specifier);
    } catch {
      continue;
    }
    try {
      const module = await load(pathToFileURL(resolved).href);
      return { module: module ?? {}, dialect: kind, specifier, resolved };
    } catch {
      continue;
    }
  }
  throw new Error(
    `roblox-workspace-runtime: unsupported shell tool set — cannot resolve ${order.map((k) => TOOL_MODULES[k]).join(' or ')} `
    + `from installAnchor ${installAnchor}`,
  );
}

function readFileText(fsLike, p) {
  try {
    return fsLike.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function fileExists(fsLike, p) {
  try {
    return fsLike.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Depth-limited tool-storage listing: `owner/repo/version/file` relative paths. */
function listStore(fsLike, storageRoot) {
  const out = [];
  const walk = (dir, rel, depth) => {
    let entries;
    try {
      entries = fsLike.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < 3) walk(path.join(dir, entry.name), nextRel, depth + 1);
      } else {
        out.push(nextRel);
      }
    }
  };
  walk(storageRoot, '', 0);
  return out;
}

/**
 * Read-only discovery of the pinned toolchain plan for one workdir:
 * the nearest `rokit.toml`/`aftman.toml` inside the workspace root wins,
 * otherwise the global manifests under the ORIGINAL home. Pins resolve
 * against the global tool storage by exact version. No writes.
 * @returns `{ toolDirs, tools, lune, manifest, diagnostics }`.
 */
export function discoverToolPlan({ workdir, root, originalEnv = process.env, fsLike = fs, platform = process.platform }) {
  const flavor = pathFlavorOf(root);
  const P = flavor === 'win32' ? path.win32 : path.posix;
  const home = (platform === 'win32' ? originalEnv.USERPROFILE : originalEnv.HOME)
    ?? originalEnv.HOME ?? originalEnv.USERPROFILE ?? '';
  const empty = { toolDirs: [], tools: [], lune: null, manifest: null, diagnostics: [] };
  if (!home) return empty;
  let manifest;
  let storageRoot;
  const project = findNearestManifest(workdir, root, ['rokit.toml', 'aftman.toml'], fsLike);
  if (project !== undefined) {
    manifest = project;
    storageRoot = project.endsWith('aftman.toml')
      ? P.join(home, '.aftman', 'tool-storage')
      : P.join(home, '.rokit', 'tool-storage');
  } else {
    const candidates = [
      [P.join(home, '.rokit', 'rokit.toml'), P.join(home, '.rokit', 'tool-storage')],
      [P.join(home, '.aftman', 'aftman.toml'), P.join(home, '.aftman', 'tool-storage')],
    ];
    const found = candidates.find(([m]) => fileExists(fsLike, m));
    if (found === undefined) return empty;
    [manifest, storageRoot] = found;
  }
  const text = readFileText(fsLike, manifest);
  if (text === undefined) return empty;
  const pins = parseToolPins(text);
  if (pins.length === 0) return { ...empty, manifest };
  const storeListing = listStore(fsLike, storageRoot);
  const { executables, diagnostics } = selectPinnedExecutables({ pins, storeListing, platform });
  const { tools, toolDirs } = toolExecutionPlan(executables, { storageRoot, flavor });
  const luneTool = tools.find(tool => tool.name.toLowerCase() === 'lune');
  return {
    toolDirs,
    tools,
    lune: luneTool === undefined ? null : { dest: luneTool.executable },
    manifest,
    diagnostics,
  };
}

/** Resolve each project pin separately; managed defaults remain available for unpinned tools. */
export function selectManagedPlan({ managed, workdir, root, originalEnv = process.env, fsLike = fs, platform = process.platform }) {
  const manifest = findNearestManifest(workdir, root, ['rokit.toml', 'aftman.toml'], fsLike);
  const pins = manifest ? parseToolPins(readFileText(fsLike, manifest) ?? '') : [];
  const sameVersion = (left, right) => left.replace(/^v/, '').replace(/\.0$/, '') === right.replace(/^v/, '').replace(/\.0$/, '');
  const expectedRepos = { lune: 'lune-org/lune', stylua: 'johnnymorganz/stylua', selene: 'kampfkarren/selene', luau: 'luau-lang/luau', 'luau-lsp': 'johnnymorganz/luau-lsp' };
  const tools = [...managed.tools];
  const warnings = [], blockedTools = [];
  let local;
  for (const pin of pins) {
    const name = pin.repo.toLowerCase() === 'stylua' ? 'stylua' : pin.repo.toLowerCase();
    const canonical = `${pin.owner}/${pin.repo}`.toLowerCase();
    const bundled = expectedRepos[name] === canonical && managed.tools.find(tool => tool.name === name && sameVersion(tool.version, pin.version));
    if (bundled) {
      if (pin.alias.toLowerCase() !== name) tools.push({ ...bundled, name: pin.alias });
      continue;
    }
    local ??= discoverToolPlan({ workdir, root, originalEnv, fsLike, platform });
    const installed = local.tools.find(tool => tool.name.toLowerCase() === pin.alias.toLowerCase() && sameVersion(tool.version, pin.version));
    if (!installed) {
      warnings.push(`Project pin ${pin.alias}=${pin.owner}/${pin.repo}@${pin.version} is not installed. The bundle only provisions its release pins; request a separate setup change, not Full access.`);
      blockedTools.push(pin.alias);
      continue;
    }
    const index = tools.findIndex(tool => tool.name.toLowerCase() === installed.name.toLowerCase());
    if (index === -1) tools.push(installed); else tools[index] = installed;
  }
  const P = platform === 'win32' ? path.win32 : path.posix;
  return { tools, toolDirs: [...new Set(tools.map(tool => P.dirname(tool.executable)))],
    lune: tools.some(tool => tool.name === 'lune') ? {dest: tools.find(tool => tool.name === 'lune').executable} : null,
    diagnostics: [], warnings, blockedTools,
    aliases: tools.filter(tool => !managed.tools.some(defaultTool => defaultTool.name === tool.name) && pins.some(pin => pin.alias === tool.name)),
    manifest: manifest ?? null };
}

/** Discover only workspace-contained Selene configs, without a Node child process. */
export function discoverStandardSeeds({ root, workdir, source, config, fsLike = fs }) {
  const P = pathFlavorOf(root) === 'win32' ? path.win32 : path.posix;
  const inside = target => { const rel = P.relative(root, target); return rel === '' || (rel !== '..' && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel)); };
  if (!inside(workdir)) throw new Error('Selene preparation workdir is outside the workspace.');
  const directories = [];
  if (config) directories.push(P.dirname(P.resolve(workdir, config)));
  else for (let current = workdir; ; current = P.dirname(current)) {
    if (fileExists(fsLike, P.join(current, 'selene.toml'))) directories.push(current);
    if (current === root) break;
  }
  return [...new Set(directories)].flatMap(directory => {
    if (!inside(directory)) throw new Error('Selene config is outside the workspace.');
    for (let current = directory; ; current = P.dirname(current)) {
      if (fsLike.lstatSync(current).isSymbolicLink()) throw new Error('Selene config path is redirected.');
      if (current === root) break;
    }
    const destination = P.join(directory, 'roblox.yml');
    return fileExists(fsLike, destination) ? [] : [{ source, destination }];
  });
}

/**
 * Build the wrapping shell delegate over the real executor. Pure wiring:
 * all containment behavior is delegated to `workspace-env` helpers so tests
 * can drive it with a fake shell and a fake fs.
 *
 * @param base - the real `ctx.shell` executor (`resolve`, `execute`, `sandboxMode`).
 * @param options - `{ platform?, dialect, originalEnv?, fsLike?, toolPlanFor?, prepare?, logger? }`
 *   where `prepare` is `{ nodePath, script, config? }` (null disables the
 *   prepare-workspace call) and `toolPlanFor(workdir, root)` overrides pin
 *   discovery (tests).
 * @returns the public shell delegate `{ sandboxMode, resolve, execute, diagnostics }`.
 */
export function createShellDelegate(base, options = {}) {
  const {
    platform = process.platform,
    dialect,
    originalEnv = process.env,
    fsLike = fs,
    toolPlanFor,
    prepare = null,
    logger,
  } = options;
  const diagnostics = [];
  const note = (code, detail) => {
    diagnostics.push(detail === undefined ? { code } : { code, detail });
    try {
      logger?.warn?.(`roblox-workspace-runtime: ${code}${detail === undefined ? '' : ` (${detail})`}`);
    } catch { /* logging must never break execution */ }
  };
  const supported = dialect === 'pwsh' || dialect === 'bash';
  if (!supported) note('unsupported-dialect', String(dialect));
  // Re-read pins per execution: a manifest change during a session must not
  // silently keep using an older version cached by the standing preset.
  const planFor = toolPlanFor ?? ((workdir, root) =>
    discoverToolPlan({ workdir, root, originalEnv, fsLike, platform }));

  /** Compute the containment overlay for one resolved spec, or why passthrough applies. */
  function contain(spec, toleratePending = false) {
    if (!supported) return { kind: 'passthrough', reason: 'unsupported-dialect' };
    const root = workspaceRootOf(spec);
    if (root === undefined) return { kind: 'passthrough', reason: 'no-workspace-root' };
    const check = validateStateContainment(root, fsLike);
    if (!check.ok) return { kind: 'passthrough', reason: 'state-escape', detail: check.reason };
    const mode = spec.sandboxPolicy?.mode;
    const writable = mode === 'workspace-write' || mode === 'danger-full-access';
    const layout = stateLayout(root);
    let plan;
    try { plan = planFor(spec.workdir, root); }
    catch (error) {
      if (!toleratePending) throw error;
      plan = { tools: [], toolDirs: [], lune: null, warnings: [`Roblox tool planning failed: ${error.message}. Routine filesystem commands remain available; inspect the project manifest before using tools.`], blockedTools: ['lune','stylua','selene','luau','luau-analyze','luau-compile','luau-lsp'] };
    }
    const originalPath = originalEnv.PATH ?? originalEnv.Path ?? originalEnv.path;
    const { env } = overlayEnv(spec.env ?? {}, { layout, toolDirs: plan.toolDirs, originalPath });
    return { kind: 'contained', root, layout, plan, env, writable };
  }

  function prepareArgs(root, spec) {
    if (typeof prepare?.seedSource === 'string') {
      return { seeds: discoverStandardSeeds({ root, workdir: spec.workdir ?? root, source: prepare.seedSource, config: prepare.config, fsLike }) };
    }
    if (prepare === null || typeof prepare.script !== 'string' || typeof prepare.nodePath !== 'string') return null;
    const localAppData = originalEnv.LOCALAPPDATA ?? originalEnv.LocalAppData ?? '';
    const args = [root, spec.workdir ?? root, localAppData];
    if (prepare.config !== undefined && prepare.config !== null && prepare.config !== '') args.push(String(prepare.config));
    return { node: prepare.nodePath, script: prepare.script, args };
  }

  return {
    diagnostics,
    get sandboxMode() {
      return base.sandboxMode;
    },
    resolve(request) {
      const spec = base.resolve(request);
      const c = contain(spec, true);
      return c.kind === 'contained' ? { ...spec, env: c.env } : spec;
    },
    execute(spec) {
      const c = contain(spec, true);
      if (c.kind !== 'contained') {
        note(c.reason, c.detail);
        if (c.reason === 'state-escape') {
          throw new Error(`Roblox workspace containment cannot initialize safely: ${c.detail}. Repair the local state path; no command was executed.`);
        }
        return base.execute(spec);
      }
      const marked = isPreambleMarked(spec.command, dialect);
      const env = c.env;
      const command = marked
        ? spec.command
        : composeCommand(buildPreamble({
          dialect,
          layout: c.layout,
          env,
          writable: c.writable,
          prepare: c.writable ? prepareArgs(c.root, spec) : null,
          lune: c.plan.blockedTools?.includes('lune') ? null : c.plan.lune,
          warnings: c.plan.warnings,
          blockedTools: c.plan.blockedTools,
          aliases: c.plan.aliases,
          checkMissingState: !c.writable,
        }), spec.command);
      return base.execute({ ...spec, env, command });
    },
  };
}

/**
 * Plugin entry. Wires the isolated shell scope and mounts the shell tool
 * module inside it. The returned child fiber from `child.plugin` is
 * deliberately NOT awaited.
 */
export async function apply(ctx, config = {}) {
  const base = ctx.shell;
  if (base === undefined || typeof base.resolve !== 'function' || typeof base.execute !== 'function') {
    throw new Error('roblox-workspace-runtime: ctx.shell executor is missing or incomplete');
  }
  const installAnchor = ctx.profileContext?.installAnchor;
  if (typeof installAnchor !== 'string' || installAnchor === '') {
    throw new Error('roblox-workspace-runtime: ctx.profileContext.installAnchor is unavailable');
  }
  const platform = config.platform ?? process.platform;
  const fsLike = config.fsLike ?? fs;
  const originalEnv = config.originalEnv ?? process.env;
  const { module: toolModule, dialect } = await loadToolModule(installAnchor, platform, config.importModule);

  const seedSource = fileURLToPath(new URL('./vendor/selene/roblox.yml', import.meta.url));
  const prepare = { seedSource, config: config.prepareConfig };
  // Mount immediately, even while setup is offline/pending. Read current state
  // on each command; a failed setup is a normal tool error, not a failed fiber.
  const managedPlan = (workdir, root) => {
    const managed = config.managedTools ?? ctx.get?.('robloxToolchain')?.current ?? ctx.robloxToolchain?.current;
    if (!managed || managed.status !== 'ready') return { tools: [], toolDirs: [], lune: null,
      warnings: [`Roblox toolchain is ${managed?.status ?? 'unavailable'}: ${(managed?.issues ?? []).join('; ')}. Use roblox_setup_status. If installing, first setup is still running; if failed, restore connectivity then re-enable this plugin or restart DSH. Do not request Full access.`],
      blockedTools: ['lune','stylua','selene','luau','luau-analyze','luau-compile','luau-lsp'] };
    return selectManagedPlan({ managed, workdir, root, originalEnv, fsLike, platform });
  };

  const delegate = createShellDelegate(base, {
    platform,
    dialect,
    originalEnv,
    fsLike,
    prepare,
    logger: ctx.logger,
    toolPlanFor: config.toolPlanFor ?? managedPlan,
  });

  // The user requested workspace-contained runs, not repeated full-access
  // retries. This deny-only policy changes no permissions and runs before the
  // shell tool's escalation approval path.
  ctx.tools.guard(exec => {
    if ((exec.name === 'pwsh' || exec.name === 'bash')
      && exec.arguments?.sandbox_permissions === 'danger-full-access') {
      return 'Roblox mode keeps shell tools workspace-contained. Full-access shell retries are disabled; use workspace-local tool state or report the concrete unsupported operation without asking for repeated approval.';
    }
    return undefined;
  });

  if (ctx.systemPrompt !== undefined && typeof ctx.systemPrompt.section === 'function') {
    try {
      const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
        ? ctx.systemPrompt.getSectionOrder('TOOL_PWSH')
        : 0;
      ctx.systemPrompt.section({ name: 'roblox-workspace-containment', order, text: CONTAINMENT_NOTE });
    } catch { /* the note is informational; never block mounting */ }
  }

  const child = ctx.isolate('shell');
  child.provide('shell', delegate);
  // Mount the tool inside the isolated scope; do NOT await the child fiber.
  child.plugin(toolModule.default ?? toolModule, {});
}
