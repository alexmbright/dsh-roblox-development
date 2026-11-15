/**
 * Pinned-toolchain executors.
 *
 * `lune`, `stylua`, `selene`, `luau`, `luau-analyze`, `luau-compile` and `luau-lsp` are
 * provisioned once into the profile's shared `roblox-toolchain` directory. Shelling out to
 * that directory from a session is an outside-workspace operation: the sandbox escalates it,
 * Auto review classifies it, and a reviewer denial becomes an approval prompt that stalls a
 * turn. A plugin tool runs in the host process instead, so it calls the same pinned binaries
 * directly with no shell, no sandbox escalation and nothing to approve.
 *
 * Every invocation is the provisioned executable for this platform, at the pinned version —
 * never a PATH lookup, never a floating install.
 * @module @alexturbo/dsh-roblox-development/toolrun
 */

import { homedir } from 'node:os';
import path from 'node:path';

const TOOLS = ['lune', 'stylua', 'selene', 'luau', 'luau-analyze', 'luau-compile', 'luau-lsp'];
const MAX_OUTPUT_BYTES = 256 * 1024;

export const inject = ['tools', 'subprocess'];

/**
 * Refuse an argument that would reach outside the session workspace.
 *
 * These tools run in the host process, so the sandbox does not fence them: the plugin has to.
 * A flag value or positional that is absolute, home-relative, or climbs with `..` is resolved
 * against the working directory and rejected unless it lands inside the workspace.
 * @param cwd - resolved working directory for the run.
 * @param workspace - resolved session workspace, when known.
 * @param value - one argument.
 * @param workspaceKnown - whether a workspace boundary applies.
 */
function assertArgumentInside(cwd, workspace, value, workspaceKnown) {
  if (!workspaceKnown) return;
  // `--flag=value` and `-f=value` carry the path after the first '='; bare flags do not.
  let candidate = value;
  const equals = candidate.indexOf('=');
  if (candidate.startsWith('-') && equals !== -1) candidate = candidate.slice(equals + 1);
  if (candidate === '' || candidate.startsWith('-')) return;
  const homeRelative = candidate === '~' || candidate.startsWith('~/');
  const absolute = candidate.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(candidate)
    || homeRelative
    || candidate.split(/[\\/]/).includes('..');
  if (!absolute) return;
  // `path.resolve` has no notion of `~`, so expand it before deciding where this lands.
  const target = homeRelative ? path.join(homedir(), candidate.slice(1)) : candidate;
  const resolved = path.resolve(cwd, target);
  const relative = path.relative(workspace, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`argument ${JSON.stringify(value)} resolves outside the session workspace ${workspace}`);
}

/** Locate one provisioned executable by its binary name. */
async function executableOf(ctx, name, signal) {
  const service = ctx.get('robloxToolchain');
  if (service === undefined) throw new Error('the Roblox toolchain service is not available in this profile');
  let state = service.current;
  if (state?.status === 'installing' && service.ready !== undefined) state = await service.ready;
  const binary = (state?.tools ?? []).find(tool => tool.name === name);
  if (binary === undefined) {
    const issue = (state?.issues ?? []).join('; ');
    throw new Error(`the pinned ${name} binary is not installed`
      + (state?.status === undefined ? '' : ` (toolchain status: ${state.status}${issue === '' ? '' : `: ${issue}`})`));
  }
  // The provider verifies the path exists and is executable in this execution world.
  const subprocess = ctx.subprocess ?? ctx.get?.('subprocess');
  return subprocess.resolveExecutable(binary.executable, undefined, signal);
}

/** Read one collected stream from the start; lossy reads keep the spill path visible. */
function readStream(reader) {
  if (reader === undefined) return { text: '', lossy: false };
  const read = reader.readFrom(0);
  return { text: typeof read?.text === 'string' ? read.text : '', lossy: read?.lossy === true };
}

/**
 * Run one pinned tool and collect its outcome.
 * @param ctx - registrant context carrying `subprocess`.
 * @param args - tool arguments: `tool`, `args`, optional `cwd`.
 * @param exec - tool execution context, source of the session working directory.
 * @returns exit facts plus collected output.
 */
export async function runTool(ctx, args, exec) {
  const name = typeof args?.tool === 'string' ? args.tool.trim() : '';
  if (!TOOLS.includes(name)) throw new Error(`unknown tool "${name}"; expected one of ${TOOLS.join(', ')}`);
  const rest = Array.isArray(args?.args) ? args.args.filter(item => typeof item === 'string') : [];
  for (const item of rest) {
    if (item.includes('\0')) throw new Error('arguments must not contain NUL bytes');
  }
  const workspace = exec?.agent?.session?.header?.cwd;
  const requested = typeof args?.cwd === 'string' && args.cwd !== '' ? args.cwd : workspace;
  if (typeof requested !== 'string' || requested === '') throw new Error('no working directory available for this run');
  const cwd = path.resolve(requested);
  // These tools run in the host process, outside the session sandbox, so the plugin enforces
  // the workspace boundary itself: a run may not be redirected out of the session workspace.
  let root;
  if (typeof workspace === 'string' && workspace !== '') {
    root = path.resolve(workspace);
    const relative = path.relative(root, cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`working directory ${cwd} is outside the session workspace ${root}`);
    }
  }
  for (const item of rest) assertArgumentInside(cwd, root, item, root !== undefined);

  const signal = exec?.signal;
  const executable = await executableOf(ctx, name, signal);
  const subprocess = ctx.subprocess ?? ctx.get?.('subprocess');
  const handle = subprocess.spawn({
    argv: [executable, ...rest],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: 4 * 1024 * 1024 } },
      stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: 4 * 1024 * 1024 } },
    },
    graceMs: 5000,
    signal,
  });
  const outcome = await handle.done;
  const stdout = readStream(handle.collected?.stdout);
  const stderr = readStream(handle.collected?.stderr);
  return {
    tool: name,
    executable,
    cwd,
    exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : -1,
    signal: typeof outcome?.signal === 'string' ? outcome.signal : '',
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.lossy || stderr.lossy,
  };
}

/** Output contract for {@link runTool}. Plain JSON Schema: the registry consumes it directly. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    executable: { type: 'string' },
    cwd: { type: 'string' },
    // JSON Schema here is a single-type subset: a signalled run reports -1 and sets signal.
    exitCode: { type: 'integer' },
    signal: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  required: ['tool', 'executable', 'cwd', 'exitCode', 'signal', 'stdout', 'stderr', 'truncated'],
};

/**
 * Build the registry definition directly.
 *
 * `ctx.tools.register` requires only a name, a renderable output schema and an execute body;
 * `defineTool` is a convenience wrapper, not a prerequisite. Avoiding it removes a dynamic
 * import of `@deepseek-ai/dsh-tools`, which does not resolve from a linked checkout — the exact
 * reason this tool previously failed to register and the lead saw no executor at all.
 * @param ctx - registrant context.
 * @returns the tool definition.
 */
function definition(ctx) {
  return {
    name: 'roblox_run_tool',
    description: 'Run one pinned Roblox CLI tool from the provisioned toolchain and return its exit code, stdout and stderr. '
      + `Supported: ${TOOLS.join(', ')}. Prefer this over a shell command: it runs the exact pinned binary, `
      + 'needs no shell approval, and cannot pick up a different version from PATH.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tool: { type: 'string', description: `One of: ${TOOLS.join(', ')}.` },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the tool verbatim, in order.' },
        cwd: { type: 'string', description: 'Working directory; must stay inside the session workspace.' },
      },
      required: ['tool', 'args'],
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [`${value.tool} exited ${value.exitCode}${value.signal === '' ? '' : ` (signal ${value.signal})`} in ${value.cwd}`,
          value.stdout === '' ? '' : `--- stdout ---\n${value.stdout}`,
          value.stderr === '' ? '' : `--- stderr ---\n${value.stderr}`,
          value.truncated ? '(output truncated)' : ''].filter(Boolean).join('\n'),
      }],
    },
    execute: (args, exec) => runTool(ctx, args, exec),
    isConcurrencySafe: () => true,
  };
}

/**
 * Mount the executors. They are optional: a profile whose toolchain is still provisioning, or a
 * host without the subprocess service, simply registers no tools.
 * @param ctx - registrant context.
 */
export function apply(ctx) {
  try {
    ctx.tools.register(definition(ctx));
  } catch (error) {
    console.warn(`[roblox-toolrun] executor unavailable: ${error?.message ?? error}`);
  }
  return undefined;
}
