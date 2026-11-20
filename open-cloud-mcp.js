/** Start the pinned Studio MCP with optional, live DSH credential templates. */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';

export const NAMES = Object.freeze({
  apiKey: 'ROBLOX_OPEN_CLOUD_API_KEY',
  creatorUserId: 'ROBLOX_CREATOR_USER_ID',
  creatorGroupId: 'ROBLOX_CREATOR_GROUP_ID',
});
const refs = new Set(Object.values(NAMES));
const packageName = '@chrrxs/robloxstudio-mcp';

export const inject = ['loader', 'tools'];

/** Resolve from the installed bundle first, or from the profile for a linked checkout. */
export function studioArgs(profileDir, bundleUrl = import.meta.url) {
  const bootstrap = fileURLToPath(new URL('./open-cloud-bootstrap.mjs', import.meta.url));
  try { accessSync(bootstrap); }
  catch { throw new Error('The Roblox Open Cloud bootstrap is missing; reinstall Roblox development.'); }
  const anchors = [bundleUrl];
  if (profileDir) anchors.push(join(profileDir, 'package.json'));
  for (const anchor of anchors) {
    try { return [bootstrap, createRequire(anchor).resolve(packageName), '--auto-install-plugin']; }
    catch (error) { if (error?.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error(`${packageName} is missing; reinstall Roblox development with its dependencies.`);
}

/** rc.5's MCP resolver accepts an empty string, but parks the whole connection on undefined. */
function optionalCredentials(ctx, getHostProvider) {
  ctx.provide('credentials', {
    async resolve(ref) {
      if (!refs.has(ref)) return undefined;
      return await getHostProvider()?.resolve(ref) ?? { value: '', source: 'roblox-optional' };
    },
  });
}

export async function apply(ctx, config = {}) {
  const loader = ctx.get('loader');
  const mcp = loader.unwrapExports(await loader.import('@deepseek-ai/dsh-mcp-client'));
  const useBootstrap = config.args == null;
  const args = config.args ?? studioArgs(ctx.get('profileContext')?.dir);
  // This realm is unique even when old and new preset revisions coexist. Keep the bridge and
  // unrelated MCPs on the real provider; only this MCP can see the optional-value adapter.
  const scoped = ctx.isolate('credentials');
  await scoped.plugin(optionalCredentials, () => ctx.get('credentials')).await();
  // Stored changes are already broadcast by DSH. Also refresh if the provider itself activates
  // late or goes away; that lifecycle change need not emit per-reference events of its own.
  ctx.on('internal/service', name => {
    if (name === 'credentials') for (const ref of refs) ctx.emit('credentials/reference-updated', ref);
  });
  await scoped.plugin(mcp, {
    serverName: 'robloxstudio',
    transport: 'stdio',
    command: process.execPath,
    args,
    ...(config.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: config.startupTimeoutMs }),
    toolCallTimeoutMs: 120000,
    failOnStartupError: false,
    reconnect: { enabled: false },
    expandTemplates: true,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      // The rc.5 ambient scrub does not cover creator IDs. Override all three with
      // empty strings for arbitrary fixture args rather than passing stored or ambient values.
      ...Object.fromEntries([...refs].map(ref => [ref, useBootstrap ? '${credential:' + ref + '}' : ''])),
      // Preloads/HTTP debug can observe credentials before or outside the bootstrap.
      ...(useBootstrap ? { NODE_OPTIONS: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '' } : {}),
    },
  }).await();
}
