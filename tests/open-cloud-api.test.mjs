import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAMES } from '../open-cloud-mcp.js';
import { callOpenCloud, loadIndex, matchOperation, pick, searchOperations, apply, CALL_TOOL, FIND_TOOL } from '../open-cloud-api.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const KEY = 'fixture-only-open-cloud-key-0123456789';
const index = loadIndex();

function ctxWith(values = { [NAMES.apiKey]: KEY }, services = {}) {
  const credentials = { resolve: async ref => (values[ref] ? { value: values[ref], source: 'stored' } : undefined) };
  return { get: name => (name === 'credentials' ? credentials : services[name]) };
}

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'oc-api-'));
  return { dir, exec: { agent: { id: 'a', session: { header: { cwd: dir } } }, signal: new AbortController().signal, callId: 'c1' } };
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('index covers the key-capable Open Cloud surface', () => {
  assert.ok(index.ops.length > 300);
  for (const sig of ['GET /cloud/v2/universes/{universe_id}/data-stores', 'POST /assets/v1/assets',
    'POST /universes/v1/{universeId}/places/{placeId}/versions', 'POST /messaging-service/v1/universes/{universeId}/topics/{topic}',
    'POST /cloud/v2/universes/{universe_id}/places/{place_id}/luau-execution-session-tasks']) {
    assert.ok(index.ops.some(op => `${op.m} ${op.p}` === sig), sig);
  }
  assert.ok(index.ops.every(op => !op.p.includes('#')));
});

test('search ranks relevant operations and describes an exact one', () => {
  const ds = searchOperations(index, 'list data stores');
  assert.ok(ds.length > 0);
  assert.match(ds.map(op => op.p).join('\n'), /data-stores/);
  const publish = searchOperations(index, 'POST /universes/v1/1/places/2/versions');
  assert.equal(publish.length, 1);
  assert.equal(publish[0].p, '/universes/v1/{universeId}/places/{placeId}/versions');
  assert.deepEqual(searchOperations(index, ''), []);
});

test('concrete paths match the most specific template', () => {
  const op = matchOperation(index, 'POST', 'apis.roblox.com', '/cloud/v2/universes/123:restartServers');
  assert.equal(op?.p, '/cloud/v2/universes/{universeId}:restartServers');
});

test('pick selects nested fields and maps arrays', () => {
  const value = { dataStores: [{ id: 'a', x: 1 }, { id: 'b' }], nextPageToken: 't' };
  assert.deepEqual(pick(value, 'dataStores[].id'), ['a', 'b']);
  assert.deepEqual(pick(value, 'dataStores[].id,nextPageToken'), { 'dataStores[].id': ['a', 'b'], nextPageToken: 't' });
});

test('GET fills placeholders, sends the key, keeps it out of the result, and never follows redirects', async () => {
  const { exec } = await workspace();
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return json(200, { dataStores: [{ id: 'Players' }], echo: KEY });
  };
  const result = await callOpenCloud(ctxWith(), { path: '/cloud/v2/universes/{universe_id}/data-stores', params: { universe_id: 42, maxPageSize: 5 } }, exec, { fetch });
  assert.equal(seen[0].url, 'https://apis.roblox.com/cloud/v2/universes/42/data-stores?maxPageSize=5');
  assert.equal(seen[0].init.headers['x-api-key'], KEY);
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.match(result.body, /\[redacted\]/);
});

test('a bare path for a non-apis endpoint is routed to its own Roblox host', async () => {
  const { exec } = await workspace();
  let sent;
  const fetch = async url => { sent = String(url); return json(200, { data: [] }); };
  await callOpenCloud(ctxWith(), { path: '/v1/locales/supported-locales-for-creators' }, exec, { fetch });
  assert.equal(sent, 'https://locale.roblox.com/v1/locales/supported-locales-for-creators');
  assert.equal(searchOperations(index, 'GET /v1/locales/supported-locales-for-creators')[0]?.h, 'locale.roblox.com');
});

test('missing key, missing placeholders and foreign hosts are refused before any request', async () => {
  const { exec } = await workspace();
  const fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(callOpenCloud(ctxWith({}), { path: '/cloud/v2/universes/1' }, exec, { fetch }), /Roblox page/);
  await assert.rejects(callOpenCloud(ctxWith(), { path: '/cloud/v2/universes/{universe_id}' }, exec, { fetch }), /universe_id/);
  await assert.rejects(callOpenCloud(ctxWith(), { path: 'https://example.com/x' }, exec, { fetch }), /Open Cloud path/);
  await assert.rejects(callOpenCloud(ctxWith(), { path: '/x', headers: { 'X-Api-Key': 'other' } }, exec, { fetch }), /cannot be set/);
});

test('raw file upload stays inside the workspace', async () => {
  const { dir, exec } = await workspace();
  await writeFile(path.join(dir, 'game.rbxl'), Buffer.from([1, 2, 3]));
  let sent;
  const fetch = async (url, init) => { sent = { url: String(url), init }; return json(200, { versionNumber: 7 }); };
  const result = await callOpenCloud(ctxWith(), { path: '/universes/v1/{universeId}/places/{placeId}/versions', params: { universeId: 1, placeId: 2, versionType: 'Saved' }, file: 'game.rbxl' }, exec, { fetch });
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers['content-type'], 'application/octet-stream');
  assert.deepEqual([...sent.init.body], [1, 2, 3]);
  assert.match(result.body, /versionNumber/);
  await assert.rejects(callOpenCloud(ctxWith(), { path: '/universes/v1/1/places/2/versions', file: '../outside.rbxl' }, exec, { fetch }), /outside the session workspace/);
});

test('asset upload is multipart, defaults the creator, and wait polls the operation', async () => {
  const { dir, exec } = await workspace();
  await writeFile(path.join(dir, 'icon.png'), Buffer.from('png'));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return json(200, { path: 'operations/op1', operationId: 'op1', done: false });
    return json(200, { path: 'operations/op1', done: true, response: { assetId: '999' } });
  };
  const result = await callOpenCloud(ctxWith({ [NAMES.apiKey]: KEY, [NAMES.creatorUserId]: '55' }),
    { path: '/assets/v1/assets', form: { request: { assetType: 'Image', displayName: 'Icon' } }, files: { fileContent: 'icon.png' }, wait: 10 }, exec, { fetch });
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.deepEqual(JSON.parse(form.get('request')).creationContext, { creator: { userId: '55' } });
  assert.equal(form.get('fileContent').type, 'image/png');
  assert.equal(calls[1].url, 'https://apis.roblox.com/assets/v1/operations/op1');
  assert.match(result.body, /"assetId":"999"/);
});

test('Luau task wait returns the logs', async () => {
  const { exec } = await workspace();
  const task = 'universes/1/places/2/luau-execution-session-tasks/t1';
  let n = 0;
  const fetch = async url => {
    n++;
    if (String(url).endsWith('/logs')) return json(200, { luauExecutionSessionTaskLogs: [{ messages: ['hello'] }] });
    return json(200, { path: task, state: n === 1 ? 'QUEUED' : 'COMPLETE', output: { results: [3] } });
  };
  const result = await callOpenCloud(ctxWith(), { path: '/cloud/v2/universes/1/places/2/luau-execution-session-tasks', body: { script: 'print("hello") return 3' }, wait: 10 }, exec, { fetch });
  const body = JSON.parse(result.body);
  assert.deepEqual(body.logs, ['hello']);
  assert.equal(body.result.state, 'COMPLETE');
});

test('pages merge arrays and save writes into the workspace', async () => {
  const { dir, exec } = await workspace();
  const fetch = async url => (new URL(url).searchParams.get('pageToken')
    ? json(200, { dataStores: [{ id: 'b' }], nextPageToken: '' })
    : json(200, { dataStores: [{ id: 'a' }], nextPageToken: 'p2' }));
  const result = await callOpenCloud(ctxWith(), { path: '/cloud/v2/universes/1/data-stores', pages: 3, pick: 'dataStores[].id', save: 'out/ds.json' }, exec, { fetch });
  assert.equal(result.body, '["a","b"]');
  const saved = JSON.parse(await readFile(path.join(dir, 'out/ds.json'), 'utf8'));
  assert.equal(saved.dataStores.length, 2);
});

test('errors keep the Roblox message and add a scope hint', async () => {
  const { exec } = await workspace();
  const fetch = async () => json(403, { code: 'PERMISSION_DENIED', message: 'Insufficient scope' });
  const result = await callOpenCloud(ctxWith(), { path: '/cloud/v2/universes/1/data-stores' }, exec, { fetch });
  assert.equal(result.ok, false);
  assert.match(result.body, /Insufficient scope/);
  assert.ok(result.notes.some(note => /universe-datastores/.test(note)));
});

test('approve: writes asks DSH approval and stops on rejection', async () => {
  const { exec } = await workspace();
  const asked = [];
  const approval = { request: async req => { asked.push(req); return 'rejected'; } };
  const fetch = async () => { throw new Error('must not fetch'); };
  await assert.rejects(callOpenCloud(ctxWith(undefined, { approval }), { method: 'DELETE', path: '/cloud/v2/universes/1/data-stores/x' }, exec, { fetch, approve: 'writes' }), /not approved/);
  assert.equal(asked[0].toolName, CALL_TOOL);
});

test('apply registers both tools; the patch mounts them in the preset', () => {
  const names = [];
  apply({ tools: { register: def => names.push(def.name) }, get: () => undefined }, {});
  assert.deepEqual(names, [FIND_TOOL, CALL_TOOL]);
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: roblox-open-cloud-api\n +name: '@alexturbo\/dsh-roblox-development\/open-cloud-api'/);
  assert.match(patch, /call roblox_cloud directly/);
  assert.match(patch, /no loaded Studio tool covers, search roblox_cloud_find before saying it cannot be done/);
  assert.match(patch, /when both fail, do the cloud half with roblox_cloud/);
  const studio = readFileSync(path.join(root, 'skills/roblox-tiered-workflow/references/studio.md'), 'utf8');
  assert.match(studio, /\*\*Coverage rule\.\*\*/);
  assert.match(studio, /\*\*`roblox_cloud` last\*\*/);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./open-cloud-api'], './open-cloud-api.js');
  assert.ok(manifest.files.includes('open-cloud-index.json'));
});
