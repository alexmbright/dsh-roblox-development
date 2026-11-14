import { readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureToolchain, inspectToolchain } from './provision.mjs';

export const name = 'roblox-toolchain';
export const inject = ['profileContext', 'tools'];
export const LOCK = JSON.parse(readFileSync(new URL('./lock.json', import.meta.url), 'utf8'));

/** Profile-owned bootstrap, once per immutable tool version. Never a model-shell escalation. */
export function apply(ctx) {
  const directory = ctx.profileContext?.dir;
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Roblox toolchain needs a DSH profile directory.');
  const root = path.join(directory, 'roblox-toolchain');
  const controller = new AbortController();
  let state = { status: 'installing', installRoot: root, tools: [], issues: [] };
  let settled;
  ctx.effect(() => async () => {
    controller.abort();
    await settled;
  });
  const service = {
    get current() { return state; },
    async inspect() {
      if (state.status === 'installing') return state;
      try { state = await inspectToolchain({ root, manifest: LOCK }); }
      catch (error) { state = { status: 'failed', installRoot: root, tools: [], issues: [error.message] }; }
      return state;
    },
    get ready() { return settled; },
  };
  ctx.provide('robloxToolchain', service);
  ctx.tools.register({
    name: 'roblox_setup_status',
    description: 'Read shared Roblox toolchain setup status and pinned executable paths. Does not install, download, mutate shared files or operate Studio.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { status: {type:'string'}, installRoot: {type:'string'}, tools: {type:'array',items:{type:'object',properties:{name:{type:'string'},version:{type:'string'},executable:{type:'string'}},required:['name','version','executable'],additionalProperties:false}}, issues:{type:'array',items:{type:'string'}}},required:['status','installRoot','tools','issues'],additionalProperties:false },
      render: (_args, value) => [{type:'text',text:JSON.stringify(value)}],
    },
    execute: async () => service.current,
    isConcurrencySafe: () => true,
  });
  // Always settle: offline or corrupt installs remain inspectable rather than
  // taking down the whole profile or repeatedly prompting a game worker.
  settled = (async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await ensureToolchain({ root, manifest: LOCK, signal: controller.signal,
        onProgress: progress => ctx.logger?.info?.(`Roblox toolchain: ${progress.name ?? ''} ${progress.status ?? ''}`),
      }); }
      catch (error) {
        if (controller.signal.aborted || attempt >= 2 || !['DOWNLOAD_FAILED', 'LOCK_TIMEOUT', 'EBUSY', 'EACCES', 'EPERM', undefined].includes(error.code)) throw error;
        await delay(1000 * (attempt + 1), undefined, {signal:controller.signal});
      }
    }
  })().then(result => { state = result; return state; }, error => {
    const detail = error.cause?.message ? `${error.message}: ${error.cause.message}` : error.message;
    state = { status: 'failed', installRoot: root, tools: [], issues: [detail] };
    ctx.logger?.warn?.(`Roblox toolchain setup failed: ${error.message}`);
    return state;
  });
}
