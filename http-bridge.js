/**
 * Shared helpers for the bundle's authenticated loopback browser bridges.
 * @module @alexturbo/dsh-roblox-development/http-bridge
 */

/** Read one JSON body with a bounded size; `undefined` for malformed or oversized input. */
export async function readJson(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Answer one request as JSON. */
export function writeJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Require loopback authority, refuse non-same-origin fetch metadata, and require any Origin
 * to match Host. Origin may be absent: DSH Desktop forwards panel requests from its
 * `dsh-app://` window without Origin or Sec-Fetch-Site and attaches its own owner cookie.
 * Authentication is then decided by DSH's Connection (`admit`).
 * @param req - the incoming request.
 * @returns whether the request may be served.
 */
function sameOrigin(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string' || host === '') return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Require the authenticated DSH browser owner before running any bridge operation. */
export function browserOwnerRejection(ctx, req) {
  if (!sameOrigin(req)) return 403;
  try {
    const connection = ctx.get('connection');
    if (typeof connection?.admit !== 'function') return 503;
    const admission = connection.admit(req);
    if ('rejection' in admission) return admission.rejection;
    return admission.peer === connection.browserPeer && admission.peer?.principal.kind === 'owner' ? undefined : 403;
  } catch {
    return 503;
  }
}

/** Answer a rejected browser request without exposing admission details. */
export function rejectBrowserRequest(ctx, req, res) {
  const status = browserOwnerRejection(ctx, req);
  if (status === undefined) return false;
  const [code, message] = status === 401 ? ['unauthorized', 'Open this panel in an authenticated DSH browser.']
    : status === 403 ? ['forbidden', 'This operation requires the local DSH browser owner.']
    : ['authentication-unavailable', 'This profile does not provide browser authentication.'];
  writeJson(res, status, { ok: false, code, message });
  return true;
}
