/**
 * Direct Roblox Open Cloud REST tools.
 *
 * `roblox_cloud_find` searches a vendored index of every Open Cloud operation that accepts an
 * API key (built from Roblox's official OpenAPI document by scripts/build-open-cloud-index.mjs),
 * so endpoint knowledge costs tokens only when it is asked for.
 * `roblox_cloud` calls any of those endpoints with the Open Cloud key stored on the Roblox page.
 *
 * Both run in the host process: no shell, no Lune script, no environment variable lookup. The key
 * is resolved per call from DSH's credential store and is never returned, logged or echoed; every
 * response text is scrubbed of it. Requests only go to the Roblox hosts the index names, keyed
 * requests never follow redirects, and local files are read or written only inside the session
 * workspace.
 * @module @alexturbo/dsh-roblox-development/open-cloud-api
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NAMES } from './open-cloud-mcp.js';

export const inject = ['tools'];

export const FIND_TOOL = 'roblox_cloud_find';
export const CALL_TOOL = 'roblox_cloud';
const DEFAULT_HOST = 'apis.roblox.com';
const DOCS = 'https://create.roblox.com/docs/cloud/reference/';
const DEFAULT_MAX_CHARS = 12000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120000;
const DOWNLOAD_HOST = /(^|\.)(rbxcdn\.com|roblox\.com)$/i;
const MIME = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.tga': 'image/tga',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.fbx': 'model/fbx', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.obj': 'model/obj',
  '.rbxm': 'model/x-rbxm', '.rbxmx': 'model/x-rbxm', '.mp4': 'video/mp4', '.mov': 'video/mov',
  '.rbxl': 'application/octet-stream', '.rbxlx': 'application/xml', '.json': 'application/json',
  '.csv': 'text/csv', '.txt': 'text/plain', '.lua': 'text/plain', '.luau': 'text/plain',
});

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

let cached;
/** Load and compile the vendored operation index (cached), or another index file (tests). */
export function loadIndex(file) {
  if (file === undefined && cached) return cached;
  const raw = JSON.parse(readFileSync(file ?? new URL('./open-cloud-index.json', import.meta.url), 'utf8'));
  const ops = raw.ops.map(op => {
    const literal = op.p.replace(/\{[^}]+\}/g, '');
    const pattern = new RegExp(`^${op.p.split(/(\{[^}]+\})/).map(part => (part.startsWith('{')
      ? '([^/]+?)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
    const words = `${op.m} ${op.p} ${op.s} ${op.t ?? ''} ${(op.sc ?? []).join(' ')} ${op.d ?? ''}`.toLowerCase();
    return { ...op, host: op.h ?? DEFAULT_HOST, literal: literal.length, pattern, words, squashed: words.replace(/[-_\s{}/:.]+/g, '') };
  });
  const index = { ...raw, ops, hosts: new Set([DEFAULT_HOST, ...raw.hosts]) };
  if (file === undefined) cached = index;
  return index;
}

/** Find the template operation a concrete or templated path belongs to (any host when `host` is undefined). */
export function matchOperation(index, method, host, pathname) {
  let best;
  for (const op of index.ops) {
    if (op.m !== method || (host !== undefined && op.host !== host)) continue;
    if (op.p !== pathname && !op.pattern.test(pathname)) continue;
    if (op.p === pathname) return op;
    if (!best || op.literal > best.literal) best = op;
  }
  return best;
}

const line = op => `${op.m} ${op.h ? `https://${op.h}` : ''}${op.p} — ${op.s}${op.sc?.length ? ` [${op.sc.join(', ')}]` : ''}${op.st ? ` (${op.st})` : ''}`;

/** Full calling detail for one operation. */
export function describeOperation(op) {
  const out = [`${op.m} ${op.h ? `https://${op.h}` : ''}${op.p}${op.st ? `  (${op.st})` : ''}${op.rl ? `  rate ${op.rl} per key owner` : ''}`, op.s];
  if (op.d) out.push(op.d);
  if (op.sc?.length) out.push(`Scopes: ${op.sc.join(', ')}`);
  if (op.q?.length) {
    out.push('Params:');
    for (const [name, where, required, type, desc] of op.q) {
      out.push(`  ${name} (${where}${required ? ', required' : ''}) ${type}${desc ? ` — ${desc}` : ''}`);
    }
  }
  if (op.b) out.push(`Body (${op.b[0]}): ${op.b[1]}`);
  if (op.u) out.push(`Docs: ${DOCS}${op.u}`);
  return out.join('\n');
}

/**
 * Rank operations for a free-text query.
 * @returns matched operations, best first.
 */
export function searchOperations(index, query, limit = 12) {
  const text = String(query ?? '').trim();
  const exact = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i.exec(text);
  if (exact) {
    const target = toUrl(index, exact[2]);
    const method = exact[1].toUpperCase();
    const pathname = target && decodeURI(target.pathname);
    const op = target && (matchOperation(index, method, target.host, pathname)
      ?? (/^https:\/\//i.test(exact[2]) ? undefined : matchOperation(index, method, undefined, pathname)));
    if (op) return [op];
  }
  const tokens = text.toLowerCase().split(/[^a-z0-9.:@]+/).filter(token => token.length > 1);
  if (tokens.length === 0) return [];
  const scored = [];
  for (const op of index.ops) {
    let hits = 0;
    let score = 0;
    for (const token of tokens) {
      const squashed = token.replace(/[-_.:]+/g, '');
      const stem = squashed.replace(/(ies|es|s)$/, '');
      const word = new RegExp(`(^|[^a-z])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      if (word.test(op.words)) { hits++; score += 3; }
      else if (op.words.includes(token) || op.squashed.includes(squashed) || (stem.length > 2 && op.squashed.includes(stem))) { hits++; score += 1; }
      if (word.test(op.p.toLowerCase()) || word.test(op.s.toLowerCase())) score += 2;
      if (token === op.m.toLowerCase()) score += 2;
    }
    if (hits === 0) continue;
    if (op.p.startsWith('/cloud/v2/')) score += 1;
    if (!op.st) score += 0.5;
    scored.push({ op, hits, score: score - op.p.length / 400 });
  }
  const top = Math.max(0, ...scored.map(entry => entry.hits));
  return scored.filter(entry => entry.hits === top).sort((a, b) => b.score - a.score).slice(0, limit).map(entry => entry.op);
}

// ---------------------------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------------------------

/** Resolve a path or absolute URL to a URL on an indexed Roblox host, or undefined. */
function toUrl(index, target) {
  const raw = String(target ?? '').trim();
  let url;
  try { url = raw.startsWith('https://') ? new URL(raw) : new URL(raw.startsWith('/') ? raw : `/${raw}`, `https://${DEFAULT_HOST}`); }
  catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || !index.hosts.has(url.host)) return undefined;
  return url;
}

/** Resolve a workspace-relative file and refuse anything outside the session workspace. */
function insideWorkspace(exec, file) {
  const root = exec?.agent?.session?.header?.cwd;
  if (typeof root !== 'string' || root === '') throw new Error('no session workspace is available for file access');
  const resolved = path.resolve(root, String(file));
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${file} resolves outside the session workspace ${root}`);
  }
  return resolved;
}

async function readLocal(exec, file) {
  const resolved = insideWorkspace(exec, file);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`${file} is not a file`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  return { bytes: await readFile(resolved), name: path.basename(resolved), type: MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream' };
}

async function writeLocal(exec, file, bytes) {
  const resolved = insideWorkspace(exec, file);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, bytes);
  return resolved;
}

const scrubber = key => text => (key && key.length >= 8 ? String(text).split(key).join('[redacted]') : String(text));

/** Extract `a.b[].c` style selections; several selections are comma-separated. */
export function pick(value, selection) {
  const one = (node, parts) => {
    if (parts.length === 0) return node;
    const [head, ...rest] = parts;
    const each = head.endsWith('[]');
    const key = each ? head.slice(0, -2) : head;
    const next = key === '' ? node : node?.[key];
    if (each) return Array.isArray(next) ? next.map(item => one(item, rest)) : undefined;
    return one(next, rest);
  };
  const paths = String(selection).split(',').map(part => part.trim()).filter(Boolean);
  if (paths.length === 1) return one(value, paths[0].split('.'));
  return Object.fromEntries(paths.map(part => [part, one(value, part.split('.'))]));
}

function signalWithTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBody(response) {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) return { kind: 'empty', bytes, type };
  if (type.includes('json')) {
    try { return { kind: 'json', json: JSON.parse(bytes.toString('utf8')), bytes, type }; }
    catch { return { kind: 'text', text: bytes.toString('utf8'), bytes, type }; }
  }
  if (type.startsWith('text/') || type.includes('xml') || type === '') {
    const text = bytes.toString('utf8');
    if (type === '') { try { return { kind: 'json', json: JSON.parse(text), bytes, type }; } catch { /* plain */ } }
    if (!text.includes('\u0000')) return { kind: 'text', text, bytes, type };
  }
  return { kind: 'binary', bytes, type };
}

const INTERESTING_HEADERS = /^(roblox-|content-md5$|etag$|retry-after$|x-ratelimit-|location$)/i;
function headersOf(response) {
  const out = {};
  for (const [name, value] of response.headers) if (INTERESTING_HEADERS.test(name)) out[name] = value;
  return out;
}

/** True while a long-running operation or Luau task is still pending. */
function pending(json) {
  if (!json || typeof json !== 'object' || typeof json.path !== 'string') return false;
  if (json.done === false) return true;
  return json.state === 'QUEUED' || json.state === 'PROCESSING';
}

/** Poll URL for an operation or task path, relative to the API family that created it. */
function pollUrl(origin, requestPath, resourcePath) {
  const family = /^\/(assets\/v1|cloud\/v2)\//.exec(requestPath)?.[1] ?? 'cloud/v2';
  return new URL(`/${family}/${resourcePath.replace(/^\//, '')}`, origin);
}

// ---------------------------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------------------------

/**
 * Execute one Open Cloud call.
 * @param ctx - registrant context (credentials, optional approval).
 * @param args - tool arguments.
 * @param exec - tool run context.
 * @param options - `{ index, fetch, approve }` overrides (tests).
 */
export async function callOpenCloud(ctx, args, exec, options = {}) {
  const index = options.index ?? loadIndex();
  const doFetch = options.fetch ?? globalThis.fetch;
  const params = { ...(args?.params ?? {}) };
  const hasBody = args?.body !== undefined || args?.bodyText !== undefined || args?.form !== undefined || args?.files !== undefined || args?.file !== undefined;
  const method = String(args?.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`unsupported method ${method}`);

  // Fill {placeholders} from params; the rest of params becomes the query string.
  let missing = [];
  const rawPath = String(args?.path ?? '').replace(/\{([^}]+)\}/g, (_, name) => {
    if (params[name] === undefined || params[name] === null || params[name] === '') { missing.push(name); return `{${name}}`; }
    const value = params[name];
    delete params[name];
    return encodeURIComponent(String(value));
  });
  if (missing.length) throw new Error(`missing path parameter(s): ${missing.join(', ')}`);
  const url = toUrl(index, rawPath);
  if (!url) throw new Error(`path must be an Open Cloud path such as /cloud/v2/... or an https URL on ${[...index.hosts].join(', ')}`);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { /* keep encoded */ }
  let op = matchOperation(index, method, url.host, decodedPath);
  // A bare path for an endpoint that lives on another Roblox host (e.g. locale.roblox.com): route it there.
  if (!op && !/^https:\/\//i.test(rawPath.trim())) {
    const elsewhere = matchOperation(index, method, undefined, decodedPath);
    if (elsewhere) { op = elsewhere; url.host = elsewhere.host; }
  }

  const credentials = ctx.get?.('credentials');
  const resolved = credentials ? await credentials.resolve(NAMES.apiKey) : undefined;
  const key = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
  if (key === '') {
    throw new Error('No Roblox Open Cloud API key is configured. Ask the user to paste it on the Roblox page (left sidebar → Roblox → Open Cloud) and press Save.');
  }
  const scrub = scrubber(key);

  // Optional host-side confirmation for writes (config approve: "writes").
  if (method !== 'GET' && (options.approve ?? 'none') === 'writes') {
    const approval = ctx.get?.('approval');
    if (!approval || !exec?.agent) throw new Error('write confirmation is required but no approval service is available');
    const reason = `${method} ${url.host}${url.pathname}`;
    const outcome = await approval.request({ agent: exec.agent, toolName: CALL_TOOL, callId: exec.callId, reason,
      displayReason: { en: `Roblox Open Cloud: ${reason}` }, signal: exec.signal });
    if (outcome !== 'allowed-once') throw new Error(`Open Cloud write not approved (${outcome})`);
  }

  // Body: raw file, multipart form, or JSON.
  const headers = { 'x-api-key': key, accept: 'application/json' };
  for (const [name, value] of Object.entries(args?.headers ?? {})) {
    if (/^(x-api-key|cookie|authorization|host|content-length)$/i.test(name)) throw new Error(`header ${name} cannot be set`);
    headers[name.toLowerCase()] = String(value);
  }
  let body;
  if (args?.file !== undefined) {
    const file = await readLocal(exec, args.file);
    body = file.bytes;
    headers['content-type'] ??= file.type;
  } else if (args?.form !== undefined || args?.files !== undefined || op?.b?.[0] === 'multipart/form-data') {
    const form = new FormData();
    const fields = { ...(args?.form ?? {}) };
    // Asset uploads: default the creator from the IDs saved on the Roblox page.
    if (op && op.m === 'POST' && op.p === '/assets/v1/assets' && fields.request && typeof fields.request === 'object'
        && !fields.request.creationContext?.creator) {
      const group = (await credentials.resolve(NAMES.creatorGroupId))?.value;
      const user = (await credentials.resolve(NAMES.creatorUserId))?.value;
      const creator = group ? { groupId: group } : user ? { userId: user } : undefined;
      if (creator) fields.request = { ...fields.request, creationContext: { ...fields.request.creationContext, creator } };
    }
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      form.append(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const [name, file] of Object.entries(args?.files ?? {})) {
      const local = await readLocal(exec, file);
      form.append(name, new Blob([local.bytes], { type: local.type }), local.name);
    }
    body = form;
  } else if (args?.body !== undefined || args?.bodyText !== undefined) {
    body = args.bodyText !== undefined ? String(args.bodyText) : JSON.stringify(args.body);
    headers['content-type'] ??= 'application/json';
    // Standard data store v1 writes require the body's MD5.
    if (/\/datastores\/v1\/.+\/entries\/entry$/.test(url.pathname) && method === 'POST' && !headers['content-md5']) {
      headers['content-md5'] = createHash('md5').update(body).digest('base64');
    }
  }

  const send = async (target, init) => {
    const response = await doFetch(target, { redirect: 'manual', ...init, signal: signalWithTimeout(exec?.signal, REQUEST_TIMEOUT_MS) })
      .catch(error => { throw new Error(scrub(`Open Cloud request failed: ${error?.cause?.code ?? error?.name ?? 'network error'}`)); });
    return { response, parsed: await readBody(response) };
  };

  let { response, parsed } = await send(url, { method, headers, body });
  const notes = [];
  const extra = {};

  // Follow pages: nextPageToken → pageToken, nextPageCursor → cursor; arrays are concatenated.
  const pages = Math.min(Math.max(Number(args?.pages ?? 1) || 1, 1), 50);
  if (method === 'GET' && pages > 1 && parsed.kind === 'json') {
    let merged = parsed.json;
    for (let page = 1; page < pages; page++) {
      const token = merged.nextPageToken || merged.nextPageCursor;
      if (!token) break;
      const next = new URL(url);
      next.searchParams.set(merged.nextPageToken ? 'pageToken' : 'cursor', token);
      const more = await send(next, { method, headers });
      if (!more.response.ok || more.parsed.kind !== 'json') { notes.push(`page ${page + 1} failed with ${more.response.status}`); break; }
      const combined = { ...more.parsed.json };
      for (const [name, value] of Object.entries(merged)) {
        if (Array.isArray(value) && Array.isArray(more.parsed.json[name])) combined[name] = [...value, ...more.parsed.json[name]];
      }
      merged = combined;
    }
    parsed = { ...parsed, json: merged };
  }

  // Poll long-running operations and Luau tasks.
  const waitSeconds = Math.min(Math.max(Number(args?.wait) || 0, 0), 600);
  if (waitSeconds > 0 && response.ok && parsed.kind === 'json' && pending(parsed.json)) {
    const deadline = Date.now() + waitSeconds * 1000;
    const target = pollUrl(url.origin, url.pathname, parsed.json.path);
    let delay = 1000;
    while (pending(parsed.json) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (exec?.signal?.aborted) throw new Error('cancelled');
      delay = Math.min(delay * 1.5, 5000);
      const polled = await send(target, { method: 'GET', headers: { 'x-api-key': key, accept: 'application/json' } });
      if (!polled.response.ok || polled.parsed.kind !== 'json') { notes.push(`poll failed with ${polled.response.status}`); break; }
      parsed = polled.parsed;
    }
    if (pending(parsed.json)) notes.push(`still pending after ${waitSeconds}s; GET ${target.pathname} to check again`);
  }
  // A finished Luau task: attach its logs.
  if (waitSeconds > 0 && parsed.kind === 'json' && typeof parsed.json?.path === 'string'
      && parsed.json.path.includes('luau-execution-session-tasks/') && !pending(parsed.json)) {
    const logs = await send(pollUrl(url.origin, url.pathname, `${parsed.json.path}/logs`), { method: 'GET', headers: { 'x-api-key': key, accept: 'application/json' } })
      .catch(() => undefined);
    if (logs?.response.ok && logs.parsed.kind === 'json') {
      const messages = (logs.parsed.json.luauExecutionSessionTaskLogs ?? []).flatMap(entry => entry.messages ?? entry.structuredMessages?.map(m => m.message) ?? []);
      extra.logs = messages;
    }
  }

  // Save: binary bodies, JSON bodies, or the file behind an asset-delivery `location`.
  let saved;
  if (args?.save !== undefined && response.ok) {
    const location = parsed.kind === 'json' && typeof parsed.json?.location === 'string' ? URL.parse(parsed.json.location) : null;
    if (location && location.protocol === 'https:' && DOWNLOAD_HOST.test(location.hostname)) {
      // CDN downloads never carry the key.
      const download = await doFetch(location, { redirect: 'follow', signal: signalWithTimeout(exec?.signal, REQUEST_TIMEOUT_MS) });
      if (!download.ok) throw new Error(`asset download failed with ${download.status}`);
      const bytes = Buffer.from(await download.arrayBuffer());
      saved = await writeLocal(exec, args.save, bytes);
      notes.push(`downloaded ${bytes.length} bytes to ${saved}`);
    } else {
      const bytes = parsed.kind === 'json' ? Buffer.from(JSON.stringify(parsed.json, null, 2)) : parsed.bytes;
      saved = await writeLocal(exec, args.save, parsed.kind === 'json' || parsed.kind === 'text' ? Buffer.from(scrub(bytes.toString('utf8'))) : bytes);
      notes.push(`saved ${bytes.length} bytes to ${saved}`);
    }
  }

  // Render.
  const maxChars = Math.min(Math.max(Number(args?.maxChars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS, 200), 100000);
  let text;
  if (parsed.kind === 'json') {
    let value = args?.pick && response.ok ? pick(parsed.json, args.pick) : parsed.json;
    if (Object.keys(extra).length) value = { result: value, ...extra };
    text = JSON.stringify(value) ?? 'undefined';
  } else if (parsed.kind === 'text') text = parsed.text;
  else if (parsed.kind === 'binary') text = saved ? '' : `(${parsed.bytes.length} bytes of ${parsed.type || 'binary'}; pass save to write it to a file)`;
  else text = '';
  if (saved && response.ok && args?.pick === undefined && parsed.kind !== 'binary') {
    text = text.length > 400 ? `${text.slice(0, 400)}… (full response in the saved file)` : text;
  }
  text = scrub(text);
  if (text.length > maxChars) {
    notes.push(`response truncated from ${text.length} chars; narrow it with pick, lower page sizes, or pass save`);
    text = `${text.slice(0, maxChars)}…`;
  }
  if (!response.ok && response.status >= 300 && response.status < 400) notes.push('redirect not followed for a keyed request');
  if (response.status === 401) notes.push('the key is invalid, expired, or IP-restricted');
  if (response.status === 403) notes.push(`the key lacks a scope or resource access${op?.sc?.length ? ` (this operation needs ${op.sc.join(', ')})` : ''}`);
  if (response.status === 404 && !op) notes.push(`no indexed operation matches ${method} ${url.pathname}; check it with ${FIND_TOOL}`);

  const shown = new URL(url);
  return {
    status: response.status,
    ok: response.ok,
    request: `${method} ${shown.href}`,
    headers: headersOf(response),
    body: text,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

const textOutput = schema => ({ schema, render: (_args, value) => [{ type: 'text', text: value.text ?? '' }] });

function findDefinition() {
  return {
    name: FIND_TOOL,
    description: 'Search every API-key Roblox Open Cloud endpoint (offline index of the official spec). Keywords list operations '
      + 'with scopes; "METHOD /path" or detail:true adds params and body shape. Use before roblox_cloud when unsure.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, or "METHOD /path" for one operation.' },
        detail: { type: 'boolean', description: 'Include parameters and body for the top results (max 3).' },
        limit: { type: 'integer', description: 'Max results (default 12).' },
      },
      required: ['query'],
    },
    output: textOutput({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
    async execute(args) {
      const index = loadIndex();
      const ops = searchOperations(index, args?.query, Math.min(Math.max(Number(args?.limit) || 12, 1), 40));
      if (ops.length === 0) return { text: `No Open Cloud operation matches "${args?.query}". Try fewer or different words.` };
      const detailed = ops.length === 1 || args?.detail === true;
      const text = detailed
        ? ops.slice(0, 3).map(describeOperation).join('\n\n') + (ops.length > 3 ? `\n\nAlso:\n${ops.slice(3).map(line).join('\n')}` : '')
        : ops.map(line).join('\n');
      return { text };
    },
    isConcurrencySafe: () => true,
  };
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'integer' },
    ok: { type: 'boolean' },
    request: { type: 'string' },
    headers: { type: 'object' },
    body: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'ok', 'request', 'headers', 'body', 'notes'],
};

function callDefinition(ctx, config) {
  return {
    name: CALL_TOOL,
    description: 'Call any Roblox Open Cloud endpoint, including web/cloud work the Studio MCP tools lack; the saved API key is added automatically (never look for or print it). '
      + 'Path {placeholders} come from params, other params become the query. One body: body, bodyText, form+files (multipart) or file (raw, e.g. .rbxl publish).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Default GET, or POST with a body.' },
        path: { type: 'string', description: 'e.g. /cloud/v2/universes/{universe_id}/data-stores, or an https URL for other Roblox hosts.' },
        params: { type: 'object' },
        body: { type: 'object', description: 'JSON object.' },
        bodyText: { type: 'string', description: 'Raw text, e.g. a non-object data store value.' },
        form: { type: 'object', description: 'Multipart fields; objects are JSON-encoded.' },
        files: { type: 'object', description: '{field: workspace path} multipart files.' },
        file: { type: 'string', description: 'Workspace path.' },
        headers: { type: 'object' },
        wait: { type: 'integer', description: 'Seconds to poll an asset operation or Luau task (returns its logs).' },
        pages: { type: 'integer', description: 'Follow page tokens N times, merging arrays.' },
        pick: { type: 'string', description: 'Fields to return, e.g. "dataStores[].id,nextPageToken".' },
        save: { type: 'string', description: 'Workspace path for the response or asset-delivery download.' },
        maxChars: { type: 'integer' },
      },
      required: ['path'],
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [`${value.status}${value.ok ? '' : ' ERROR'} ${value.request}`,
          Object.keys(value.headers ?? {}).length ? `headers: ${JSON.stringify(value.headers)}` : '',
          value.body,
          ...(value.notes ?? []).map(note => `note: ${note}`)].filter(Boolean).join('\n'),
      }],
    },
    timeoutMs: 15 * 60 * 1000,
    execute: (args, exec) => callOpenCloud(ctx, args, exec, { approve: config?.approve }),
    isConcurrencySafe: args => String(args?.method ?? 'GET').toUpperCase() === 'GET' && args?.body === undefined && args?.save === undefined,
  };
}

/**
 * Register both tools in the preset scope.
 * @param ctx - registrant context.
 * @param config - `{ approve?: 'none' | 'writes' }`; `writes` asks DSH approval before every non-GET call.
 */
export function apply(ctx, config = {}) {
  try {
    loadIndex();
    ctx.tools.register(findDefinition());
    ctx.tools.register(callDefinition(ctx, config));
  } catch (error) {
    console.warn(`[roblox-open-cloud-api] tools unavailable: ${error?.message ?? error}`);
  }
}
