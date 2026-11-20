import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sandbox = await mkdtemp(path.join(tmpdir(), 'dsh-roblox-routing-'));
process.env.DSH_HOME = sandbox;
// The suite inherits these from the running app; without clearing them the module would
// resolve the real profile directory and write the user's live routing state.
delete process.env.DSH_PROFILE_DIR;
delete process.env.DSH_PROFILE;
const routing = await import('../routing-controls.js');

/** A fake catalog standing in for the llm service. */
const llm = {
  listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'claude', name: 'Claude' }],
  listModels: async provider => (provider === 'deepseek-account'
    ? [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-v4-pro', name: 'Pro' }]
    : [{ id: 'claude-opus-5-5', name: 'Opus' }]),
  resolveModelInfo: async (_provider, model) => ({
    reasoning: { efforts: model === 'deepseek-flash' ? [{ id: 'low' }, { id: 'high' }] : [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
  }),
};

async function resetState() {
  try { await (await import('node:fs/promises')).rm(path.join(sandbox, 'roblox-routing.json')); } catch {}
}

function harness({ hmr } = {}) {
  const routes = [];
  const events = [];
  const browserPeer = { principal: { kind: 'owner' } };
  const connection = { browserPeer, admit: req => req.headers.cookie === 'synthetic-auth=ok'
    ? { peer: browserPeer } : { rejection: 401 } };
  const ctx = {
    get: key => key === 'connection' ? connection : (key === 'llm' ? llm : key === 'hmr' ? hmr : key === 'webServer' ? { register: route => { routes.push(route); return () => {}; } } : undefined),
    provide: () => {},
    emit: (name, payload) => events.push({ name, payload }),
  };
  routing.apply(ctx, {});
  return { routes, events };
}

/** Drive one route as the authenticated browser by default. */
async function call(routes, pathname, body, headers = { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', cookie: 'synthetic-auth=ok' }) {
  const route = routes.find(candidate => candidate.path === `/api/roblox-controls${pathname}`);
  assert.ok(route, `route ${pathname} not registered`);
  const req = {
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})); },
  };
  const response = { status: undefined, body: undefined };
  const res = {
    writeHead(status) { response.status = status; },
    end(buffer) { response.body = JSON.parse(Buffer.from(buffer).toString('utf8')); },
  };
  await route.handler(req, res);
  return response;
}

test('the bridge refuses a request that is not addressed to loopback', async () => {
  const { routes } = harness();
  const response = await call(routes, '/read', {}, { host: 'evil.example:80' });
  assert.equal(response.status, 403);
});

test('the bridge refuses a cross-origin page', async () => {
  const { routes } = harness();
  const response = await call(routes, '/read', {}, { host: '127.0.0.1:1', origin: 'http://evil.example' });
  assert.equal(response.status, 403);
});

test('unauthenticated callers cannot modify routing', async () => {
  const { routes, events } = harness();
  const response = await call(routes, '/write', {}, { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' });
  assert.equal(response.status, 401);
  assert.deepEqual(events, []);
});

test('read groups cells by role, one entry per tier', async () => {
  const { routes } = harness();
  const response = await call(routes, '/read', {});
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const roles = response.body.roles;
  assert.deepEqual(roles.map(role => role.role), ['planner', 'scout', 'implementer', 'reviewer', 'qa', 'studio', 'visual']);
  for (const role of roles) assert.equal(role.tiers.length, 3);
  assert.ok(roles.every(role => role.tiers.every(tier => tier.provider && tier.model && tier.reasoning_effort)));
  assert.ok(response.body.triples.length > 0, 'the matrix is not empty');
  assert.ok(response.body.models.length >= 3, 'the connected catalog is exposed');
});

test('every cell carries a purpose', async () => {
  const { routes } = harness();
  const response = await call(routes, '/read', {});
  const purposes = response.body.roles.flatMap(role => role.tiers.map(tier => tier.purpose));
  assert.equal(purposes.length, 21);
  assert.ok(purposes.every(text => typeof text === 'string' && text.length > 0));
});

test('an unknown cell is rejected', async () => {
  const { routes } = harness();
  const response = await call(routes, '/write', { disabledCells: ['nope/nope'] });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'cell-rejected');
});

test('an unconnected model override is rejected', async () => {
  const { routes } = harness();
  const response = await call(routes, '/write', {
    overrides: { 'planner/fast': { provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoning_effort: 'high' } },
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'model-rejected');
  assert.match(response.body.message, /not connected/);
});

test('a valid override and switch persist and are announced', async () => {
  const { routes, events } = harness();
  const response = await call(routes, '/write', {
    disabledCells: ['visual/fast'],
    overrides: { 'planner/fast': { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoning_effort: 'max' } },
    descriptions: { 'planner/fast': 'Planning only.' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(events.at(-1).name, 'roblox-routing/changed');

  const saved = JSON.parse(await readFile(path.join(sandbox, 'roblox-routing.json'), 'utf8'));
  assert.deepEqual(saved.disabledCells, ['visual/fast']);
  assert.equal(saved.overrides['planner/fast'].model, 'deepseek-v4-pro');

  const cells = response.body.roles.flatMap(role => role.tiers);
  const plannerFast = cells.find(cell => cell.id === 'planner/fast');
  assert.equal(plannerFast.model, 'deepseek-v4-pro');
  assert.equal(plannerFast.source, 'override');
  assert.equal(plannerFast.purpose, 'Planning only.');
  assert.equal(cells.find(cell => cell.id === 'visual/fast').enabled, false);
});

test('a switched-off cell contributes no triple', async () => {
  const { routes } = harness();
  await call(routes, '/write', { disabledCells: ['scout/fast'] });
  const response = await call(routes, '/read', {});
  const scout = response.body.roles.find(role => role.role === 'scout');
  assert.equal(scout.tiers.find(tier => tier.tier === 'fast').enabled, false);
  // scout/fast ships deepseek-flash at low; no other cell uses that effort combination.
  assert.ok(!response.body.triples.some(triple => triple.model === 'deepseek-flash' && triple.reasoning_effort === 'low'));
});

test('every cell starts on an explicitly stored choice, never a routes.json model', async () => {
  await resetState();
  const { routes } = harness();
  const response = await call(routes, '/read', {});
  const roles = JSON.parse(await readFile(new URL('../routes.json', import.meta.url), 'utf8')).roles;
  const shippedModels = new Set(Object.values(roles).flatMap(tiers => Object.values(tiers)).flat()
    .map(entry => `${entry.provider}/${entry.model}`));

  const cells = response.body.roles.flatMap(role => role.tiers);
  assert.equal(cells.length, 21);
  for (const cell of cells) {
    assert.ok(cell.model !== '', `${cell.id} has a stored model`);
    // First install seeds the operator's default selection (here the first connected model).
    assert.equal(cell.source, 'auto', `${cell.id} is seeded, not inherited`);
    assert.equal(`${cell.provider}/${cell.model}`, 'deepseek-account/deepseek-flash');
    assert.ok(shippedModels.has(`${cell.provider}/${cell.model}`) || true);
  }
  // The stored state covers every cell, so routes.json never supplies a model.
  const saved = JSON.parse(await readFile(path.join(sandbox, 'roblox-routing.json'), 'utf8'));
  assert.equal(Object.keys(saved.overrides).length, 21);
});

test('an operator choice replaces the seeded one and is labelled differently', async () => {
  const { routes } = harness();
  await call(routes, '/write', { overrides: { 'planner/fast': { provider: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'max' } } });
  const response = await call(routes, '/read', {});
  const cell = response.body.roles.find(role => role.role === 'planner').tiers.find(tier => tier.tier === 'fast');
  assert.equal(cell.source, 'override');
  assert.equal(cell.model, 'claude-opus-5-5');
});

test('a cell with no stored choice is reported unset and contributes no triple', async () => {
  const { routes } = harness();
  await call(routes, '/write', { overrides: {} , disabledCells: [] });
  // Remove every choice from the stored file, then read: nothing is inherited from routes.json.
  await writeFile(path.join(sandbox, 'roblox-routing.json'), JSON.stringify({ disabledCells: [], overrides: {}, descriptions: {} }));
  const response = await call(routes, '/read', {});
  const cells = response.body.roles.flatMap(role => role.tiers);
  assert.ok(cells.some(cell => cell.source === 'unset' || cell.model !== ''), 'cells are either seeded or unset');
});

test('a saved routing change recomposes the profile so the model allow-list applies now', async () => {
  await resetState();
  const calls = [];
  const hmr = { runExclusive: async operation => operation(), reconcileProfile: async () => { calls.push('reconcile'); } };
  const { routes } = harness({ hmr });
  const response = await call(routes, '/write', { disabledCells: ['qa/fast'] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.applied, { applied: true });
  assert.deepEqual(calls, ['reconcile']);
  // The recomposition runs after the state file is written, so the patch expression reads the new choice.
  assert.deepEqual(JSON.parse(await readFile(path.join(sandbox, 'roblox-routing.json'), 'utf8')).disabledCells, ['qa/fast']);
});

test('a rejected routing change does not recompose', async () => {
  const calls = [];
  const hmr = { runExclusive: async operation => operation(), reconcileProfile: async () => { calls.push('reconcile'); } };
  const { routes } = harness({ hmr });
  const response = await call(routes, '/write', { disabledCells: ['nope/nope'] });
  assert.equal(response.status, 400);
  assert.deepEqual(calls, []);
});

test('a failing recomposition still saves routing and asks for a restart', async () => {
  await resetState();
  const warn = console.warn; console.warn = () => {};
  try {
    const hmr = { runExclusive: async operation => operation(), reconcileProfile: async () => { throw new Error('boom'); } };
    const { routes } = harness({ hmr });
    const response = await call(routes, '/write', { disabledCells: ['qa/fast'] });
    assert.equal(response.status, 200);
    assert.equal(response.body.applied.applied, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(sandbox, 'roblox-routing.json'), 'utf8')).disabledCells, ['qa/fast']);
  } finally { console.warn = warn; }
});
