/**
 * Shared helpers for the bundle's loopback browser bridges (routing panel, screenshots tab).
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
 * Admit only requests addressed to the loopback listener, and only when a browser-supplied
 * Origin matches the Host it is addressed to. This keeps a bridge from answering a cross-origin
 * page or a DNS-rebinding request that resolves here.
 * @param req - the incoming request.
 * @returns whether the request may be served.
 */
export function sameOrigin(req) {
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
  if (typeof site === 'string' && site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
