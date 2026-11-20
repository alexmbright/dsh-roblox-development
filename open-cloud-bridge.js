/**
 * Browser bridge for the "Roblox Open Cloud" settings section.
 *
 * Three same-origin loopback routes on the existing web carrier, the same posture as the routing
 * panel's bridge. Values go to DSH's credential store and nowhere else; no response ever carries
 * a value back, only whether each one is set and where it comes from.
 * - POST /api/roblox-open-cloud/read   `{}`: per-field status.
 * - POST /api/roblox-open-cloud/write  `{ field, value }`: store one value, then apply it live.
 * - POST /api/roblox-open-cloud/clear  `{ field }`: remove one stored value, then apply it live.
 * @module @alexturbo/dsh-roblox-development/open-cloud-bridge
 */
import { readJson, writeJson, rejectBrowserRequest } from './http-bridge.js';
import { NAMES } from './open-cloud-mcp.js';

export const PREFIX = '/api/roblox-open-cloud';

/** What each editable field is, how it is validated, and which credential holds it. */
export const FIELDS = Object.freeze({
  apiKey: {
    name: NAMES.apiKey,
    // Open Cloud keys are one long opaque token; reject anything that cannot be pasted as one.
    check: value => (value.length >= 20 && value.length <= 4096 && !/\s/.test(value)
      ? undefined
      : 'The API key must be one token of at least 20 characters with no spaces or line breaks.'),
  },
  creatorUserId: {
    name: NAMES.creatorUserId,
    check: value => (/^[1-9][0-9]{0,18}$/.test(value) ? undefined : 'The creator user ID must be a number.'),
  },
  creatorGroupId: {
    name: NAMES.creatorGroupId,
    check: value => (/^[1-9][0-9]{0,18}$/.test(value) ? undefined : 'The creator group ID must be a number.'),
  },
});

/**
 * Status for every field: never the value.
 * @param credentials - the DSH credential service.
 * @returns per-field `{ configured, source, writable }`; never include a masked preview.
 */
export async function status(credentials) {
  const out = {};
  for (const [field, spec] of Object.entries(FIELDS)) {
    const info = await credentials.describe(spec.name);
    out[field] = {
      configured: info?.configured === true,
      source: info?.source,
      writable: info?.writable !== false,
    };
  }
  return out;
}

/** Build the exact routes this bridge serves. */
export function buildOpenCloudRoutes(ctx) {
  const credentials = () => ctx.get('credentials');
  const post = handler => async (req, res) => {
    if (rejectBrowserRequest(ctx, req, res)) return;
    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' }); return; }
    if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      writeJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'JSON required' });
      return;
    }
    try {
      const store = credentials();
      if (store === undefined) {
        writeJson(res, 503, { ok: false, code: 'no-credential-store', message: 'This profile has no credential store, so the key cannot be saved.' });
        return;
      }
      await handler(req, res, store);
    } catch {
      // Messages from the store can echo a rejected value's context; keep the response generic.
      writeJson(res, 500, { ok: false, code: 'internal', message: 'The credential store rejected the request.' });
      console.warn('[roblox-open-cloud] credential store request failed');
    }
  };
  const field = (body, res) => {
    const spec = typeof body.field === 'string' && Object.hasOwn(FIELDS, body.field) ? FIELDS[body.field] : undefined;
    if (spec === undefined) writeJson(res, 400, { ok: false, code: 'unknown-field', message: 'unknown field' });
    return spec;
  };
  const body = async (req, res) => {
    const parsed = await readJson(req);
    if (parsed === undefined) writeJson(res, 400, { ok: false, code: 'malformed', message: 'malformed JSON body' });
    return parsed;
  };
  return [
    {
      kind: 'exact',
      path: `${PREFIX}/read`,
      handler: post(async (req, res, store) => {
        if (await body(req, res) === undefined) return;
        writeJson(res, 200, { ok: true, fields: await status(store) });
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/write`,
      handler: post(async (req, res, store) => {
        const parsed = await body(req, res);
        if (parsed === undefined) return;
        const spec = field(parsed, res);
        if (spec === undefined) return;
        const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
        const problem = value === '' ? 'Enter a value to save.' : spec.check(value);
        if (problem !== undefined) { writeJson(res, 400, { ok: false, code: 'invalid', message: problem }); return; }
        await store.set(spec.name, value);
        writeJson(res, 200, { ok: true, fields: await status(store) });
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/clear`,
      handler: post(async (req, res, store) => {
        const parsed = await body(req, res);
        if (parsed === undefined) return;
        const spec = field(parsed, res);
        if (spec === undefined) return;
        await store.unset(spec.name);
        writeJson(res, 200, { ok: true, fields: await status(store) });
      }),
    },
  ];
}

/**
 * Register the routes on the web carrier, once one exists.
 * @param ctx - registrant context carrying `webServer` and `credentials`.
 * @returns a disposer, or undefined when it mounts later through `ctx.inject`.
 */
export function mountOpenCloudBridge(ctx) {
  const mount = server => {
    const disposers = [];
    for (const route of buildOpenCloudRoutes(ctx)) {
      try {
        disposers.push(server.register({ kind: route.kind, path: route.path, handler: route.handler }));
      } catch (error) {
        console.warn(`[roblox-open-cloud] bridge route ${route.path} unavailable: ${error?.message ?? error}`);
      }
    }
    return () => { for (const dispose of disposers) dispose(); };
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], sctx => sctx.effect(() => mount(sctx.get('webServer')), 'roblox-open-cloud: bridge'));
    return undefined;
  }
  const server = ctx.get('webServer');
  return server === undefined ? undefined : mount(server);
}
