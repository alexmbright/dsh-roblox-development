import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = fileURLToPath(new URL('../', import.meta.url));
import { NAMES, studioArgs } from '../open-cloud-mcp.js';
const { buildOpenCloudRoutes, status, FIELDS, PREFIX } = await import('../open-cloud-bridge.js');

const SECRET = 'fixture-only-not-a-real-secret-12345';
const browserPeer = { principal: { kind: 'owner' } };
const connection = { browserPeer, admit: req => req.headers.cookie === 'synthetic-auth=ok'
  ? { peer: browserPeer } : { rejection: 401 } };

/** An in-memory credential service with the seam's describe/set/unset shape. */
function fakeStore() {
  const values = new Map();
  return {
    values,
    describe: async name => (values.has(name)
      ? { configured: true, source: 'stored', writable: true, masked: name === NAMES.apiKey ? `${SECRET.slice(0, 6)}…${SECRET.slice(-5)}` : undefined }
      : { configured: false, writable: true }),
    set: async (name, value) => { values.set(name, value); },
    unset: async name => { values.delete(name); },
  };
}

function request(body, { method = 'POST', headers = {} } = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { host: '127.0.0.1:50211', origin: 'http://127.0.0.1:50211',
    'content-type': 'application/json', cookie: 'synthetic-auth=ok', ...headers };
  return req;
}

/** Call one route and capture the JSON it answers. */
async function call(routes, name, body, options) {
  const route = routes.find(entry => entry.path === `${PREFIX}/${name}`);
  assert.ok(route, `route ${name}`);
  let result;
  const res = {
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(payload) { result = { status: this.statusCode, text: payload.toString('utf8') }; },
  };
  await route.handler(request(body, options), res);
  return { status: result.status, text: result.text, json: JSON.parse(result.text) };
}

const routesFor = store => buildOpenCloudRoutes({ get: name => (name === 'credentials' ? store : name === 'connection' ? connection : undefined) });

test('write stores the value, and no response ever contains it', async () => {
  const store = fakeStore();
  const routes = routesFor(store);
  const saved = await call(routes, 'write', { field: 'apiKey', value: `  ${SECRET}  ` });
  assert.equal(saved.status, 200);
  assert.equal(store.values.get(NAMES.apiKey), SECRET);
  assert.equal(saved.json.fields.apiKey.configured, true);
  assert.ok(!saved.text.includes(SECRET));
  assert.deepEqual(saved.json.fields.apiKey, { configured: true, source: 'stored', writable: true });
  const read = await call(routes, 'read', {});
  assert.ok(!read.text.includes(SECRET));
  assert.equal(read.json.fields.creatorUserId.configured, false);
});

test('clear removes the stored value', async () => {
  const store = fakeStore();
  const routes = routesFor(store);
  await call(routes, 'write', { field: 'apiKey', value: SECRET });
  const cleared = await call(routes, 'clear', { field: 'apiKey' });
  assert.equal(cleared.status, 200);
  assert.equal(store.values.has(NAMES.apiKey), false);
  assert.equal(cleared.json.fields.apiKey.configured, false);
});

test('invalid input is rejected without storing, and the message never echoes the value', async () => {
  const store = fakeStore();
  const routes = routesFor(store);
  for (const [field, value] of [['apiKey', 'short'], ['apiKey', 'has a space in it 0123456789'], ['creatorUserId', 'abc'], ['creatorGroupId', '0'], ['apiKey', '']]) {
    const answer = await call(routes, 'write', { field, value });
    assert.equal(answer.status, 400, `${field}=${value}`);
    assert.ok(!answer.text.includes(value) || value === '');
  }
  assert.equal(store.values.size, 0);
});

test('unknown fields, prototype keys, malformed bodies and wrong methods are refused', async () => {
  const store = fakeStore();
  const routes = routesFor(store);
  assert.equal((await call(routes, 'write', { field: 'nope', value: 'x' })).status, 400);
  assert.equal((await call(routes, 'write', { field: 'constructor', value: 'x' })).status, 400);
  assert.equal((await call(routes, 'clear', { field: '__proto__' })).status, 400);
  assert.equal((await call(routes, 'write', '{not json')).status, 400);
  assert.equal((await call(routes, 'read', {}, { method: 'GET' })).status, 405);
  assert.equal(store.values.size, 0);
});

test('cross-origin requests are refused before anything is stored', async () => {
  const store = fakeStore();
  const routes = routesFor(store);
  const hostile = await call(routes, 'write', { field: 'apiKey', value: SECRET }, { headers: { origin: 'https://evil.example' } });
  assert.equal(hostile.status, 403);
  const rebinding = await call(routes, 'write', { field: 'apiKey', value: SECRET }, { headers: { host: 'evil.example' } });
  assert.equal(rebinding.status, 403);
  assert.equal(store.values.size, 0);
});

test('a profile without a credential store reports it instead of pretending to save', async () => {
  const routes = routesFor(undefined);
  const answer = await call(routes, 'write', { field: 'apiKey', value: SECRET });
  assert.equal(answer.status, 503);
});

test('a failing store gives a generic error that does not echo the value', async () => {
  const store = fakeStore();
  store.set = async () => { throw new Error(`could not write ${SECRET}`); };
  const answer = await call(routesFor(store), 'write', { field: 'apiKey', value: SECRET });
  assert.equal(answer.status, 500);
  assert.ok(!answer.text.includes(SECRET));
});

test('status exposes only presence, source and writability, without even a partial key', async () => {
  const store = fakeStore();
  await store.set(NAMES.apiKey, SECRET);
  const out = await status(store);
  assert.deepEqual(Object.keys(out), Object.keys(FIELDS));
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.deepEqual(out.apiKey, { configured: true, source: 'stored', writable: true });
});

test('the preset wires the optional adapter only into the community Studio server', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(patch, /id: mcp-robloxstudio\n +name: '@alexturbo\/dsh-roblox-development\/open-cloud-mcp'/);
  assert.doesNotMatch(patch, /open-cloud-credential|ROBLOX_OPEN_CLOUD_API_KEY/);
  assert.equal(manifest.exports['./open-cloud-mcp'], './open-cloud-mcp.js');
  assert.ok(manifest.files.includes('open-cloud-mcp.js'));
});

test('a missing dependency gives a plain error without consulting credential data', () => {
  assert.throws(() => studioArgs(undefined, 'file:///nonexistent-roblox-bundle/package.json'), /reinstall Roblox development with its dependencies/);
});

const { applyProfileChange } = await import('../apply-profile.js');

/** A context whose `hmr` records each recomposition and can be made to fail. */
function hmrContext(store, { fail = false, withHmr = true } = {}) {
  const calls = [];
  const hmr = {
    runExclusive: async operation => operation(),
    reconcileProfile: async () => { calls.push('reconcile'); if (fail) throw Object.assign(new Error(`boom ${SECRET}`), { name: 'ProbeError' }); },
  };
  return { calls, ctx: { get: name => (name === 'credentials' ? store : name === 'hmr' && withHmr ? hmr : name === 'connection' ? connection : undefined) } };
}

test('applyProfileChange recomposes through HMR inside its exclusive queue', async () => {
  const { calls, ctx } = hmrContext(fakeStore());
  assert.deepEqual(await applyProfileChange(ctx), { applied: true });
  assert.deepEqual(calls, ['reconcile']);
});

test('applyProfileChange degrades to a restart notice instead of throwing, without leaking the cause', async () => {
  const warn = console.warn; const lines = []; console.warn = line => lines.push(String(line));
  try {
    const failed = await applyProfileChange(hmrContext(fakeStore(), { fail: true }).ctx);
    assert.equal(failed.applied, false);
    assert.ok(!JSON.stringify(failed).includes(SECRET) && !lines.join('\n').includes(SECRET));
    const none = await applyProfileChange(hmrContext(fakeStore(), { withHmr: false }).ctx);
    assert.equal(none.applied, false);
  } finally { console.warn = warn; }
});

test('credential changes do not recompose the profile or claim the MCP connection is ready', async () => {
  const { calls, ctx } = hmrContext(fakeStore());
  const routes = buildOpenCloudRoutes(ctx);
  const saved = await call(routes, 'write', { field: 'creatorUserId', value: '12345' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.fields.creatorUserId.configured, true);
  const cleared = await call(routes, 'clear', { field: 'creatorUserId' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.fields.creatorUserId.configured, false);
  for (const response of [saved, cleared]) {
    assert.ok(!Object.hasOwn(response.json, 'applied'));
    assert.ok(!Object.hasOwn(response.json, 'wired'));
  }
  assert.deepEqual(calls, []);
});

test('signed browser owner admission is required before accessing the store', async () => {
  let touches = 0;
  const guarded = { describe: async () => { touches++; }, set: async () => { touches++; }, unset: async () => { touches++; } };
  const cases = [
    [connection, { cookie: undefined }, 401],
    [connection, { origin: 'http://127.0.0.1:1' }, 403],
    [connection, { origin: 'null' }, 403],
    [connection, { 'sec-fetch-site': 'same-site' }, 403],
    [connection, { 'content-type': 'text/plain' }, 415],
    [{ browserPeer, admit: () => ({ rejection: 403 }) }, {}, 403],
    [{ browserPeer, admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, {}, 403],
    [{ browserPeer, admit: () => { throw new Error(SECRET); } }, {}, 503],
    [undefined, {}, 503],
  ];
  for (const [auth, headers, expected] of cases) {
    const routes = buildOpenCloudRoutes({ get: key => key === 'credentials' ? guarded : auth });
    for (const action of ['read', 'write', 'clear']) {
      const result = await call(routes, action, { field: 'apiKey', value: SECRET }, { headers });
      assert.equal(result.status, expected, action);
      assert.ok(!result.text.includes(SECRET));
    }
  }
  assert.equal(touches, 0);
});

test('DSH Desktop forwarded requests (no Origin, no Sec-Fetch-Site) reach the store after admission', async () => {
  // Desktop's forwardWebRequest strips origin/sec-fetch-site and injects its own Host cookie.
  const store = fakeStore();
  const routes = buildOpenCloudRoutes({ get: key => (key === 'credentials' ? store : key === 'connection' ? connection : undefined) });
  for (const action of ['read', 'write', 'clear']) {
    const result = await call(routes, action, { field: 'creatorUserId', value: '12345' }, { headers: { origin: undefined } });
    assert.equal(result.status, 200, action);
  }
});
