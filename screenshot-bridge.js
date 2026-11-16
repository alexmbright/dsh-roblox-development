/**
 * Browser bridge for the Roblox screenshots sidebar tab.
 *
 * Two same-origin loopback routes on the existing web carrier, the same posture as the routing
 * panel's bridge:
 * - POST /api/roblox-screenshots/list `{ sessionId }`: every capture in that Session's worker tree
 *   (resolved to its root lead through the header parent chain), newest first.
 * - GET  /api/roblox-screenshots/image?session=<id>&id=<cap-id>: the stored image bytes, served
 *   only for a capture that belongs to that Session's tree.
 * @module @alexturbo/dsh-roblox-development/screenshot-bridge
 */
import { createReadStream } from 'node:fs';
import { collectTreeById, describe } from './screenshots.js';
import { readJson, writeJson, sameOrigin } from './http-bridge.js';

export const PREFIX = '/api/roblox-screenshots';

/** Walk a Session's header parent chain to its root id. */
export async function rootSessionOf(ctx, sessionId, signal) {
  let id = sessionId;
  for (let depth = 0; depth < 16; depth += 1) {
    let header = ctx.get('agents')?.get?.(id)?.session?.header;
    if (header === undefined) {
      try {
        header = await ctx.get('sessionQuery').inspectSession(id, session => session.header, signal);
      } catch {
        return id;
      }
    }
    if (header?.parentSession === undefined || header.origin !== 'subagent') return id;
    id = header.parentSession;
  }
  return id;
}

/** Captures for the tree a Session belongs to. */
export async function treeCaptures(ctx, sessionId, signal) {
  const root = await rootSessionOf(ctx, sessionId, signal);
  return collectTreeById(ctx, root, 'lead', signal);
}

/** Build the bridge routes. */
export function buildScreenshotRoutes(ctx) {
  const guard = handler => async (req, res) => {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'requests must come from the local page' });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) writeJson(res, 500, { ok: false, code: 'internal', message: error?.message ?? String(error) });
    }
  };
  return [
    {
      kind: 'exact',
      path: `${PREFIX}/list`,
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' }); return; }
        const body = await readJson(req);
        const sessionId = body?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') { writeJson(res, 400, { ok: false, code: 'malformed', message: 'sessionId required' }); return; }
        const { captures, unreadable } = await treeCaptures(ctx, sessionId);
        writeJson(res, 200, { ok: true, captures: captures.map(capture => ({ ...describe(ctx, capture), path: undefined })), unreadable });
      }),
    },
    {
      kind: 'exact',
      path: `${PREFIX}/image`,
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') { writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET required' }); return; }
        const url = new URL(req.url ?? '', 'http://local');
        const sessionId = url.searchParams.get('session') ?? '';
        const id = url.searchParams.get('id') ?? '';
        if (sessionId === '' || !/^cap-[0-9a-z]{6,}$/.test(id)) { writeJson(res, 400, { ok: false, code: 'malformed', message: 'session and id required' }); return; }
        const { captures } = await treeCaptures(ctx, sessionId);
        const capture = captures.find(item => item.id === id);
        if (capture === undefined) { writeJson(res, 404, { ok: false, code: 'not-found', message: 'no such capture in this Session tree' }); return; }
        let file;
        try {
          file = ctx.get('attachments')?.imageHostPath?.(capture.attachment);
        } catch { /* fall through */ }
        if (typeof file !== 'string' || file === '') { writeJson(res, 404, { ok: false, code: 'not-found', message: 'capture has no local file' }); return; }
        res.writeHead(200, {
          'content-type': capture.attachment.mediaType ?? 'image/png',
          'cache-control': 'private, max-age=86400, immutable',
          'x-content-type-options': 'nosniff',
        });
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }),
    },
  ];
}

/** Mount the bridge on the web carrier when present; returns the disposer. */
export function mountScreenshotBridge(ctx) {
  const mount = server => {
    const disposers = [];
    for (const route of buildScreenshotRoutes(ctx)) {
      try {
        disposers.push(server.register({ kind: route.kind, path: route.path, handler: route.handler }));
      } catch (error) {
        console.warn(`[roblox-screenshots] bridge route ${route.path} unavailable: ${error?.message ?? error}`);
      }
    }
    return () => { for (const dispose of disposers) dispose(); };
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], sctx => sctx.effect(() => mount(sctx.get('webServer')), 'roblox-screenshots: bridge'));
    return undefined;
  }
  const server = ctx.get('webServer');
  return server === undefined ? undefined : mount(server);
}
