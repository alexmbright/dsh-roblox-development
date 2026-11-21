import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioToolSearch, deferredTools, CORE_TOOLS, SEARCH_TOOL } from '../studio-tool-search.js';

const tool = (raw, description = `Use to ${raw.replace(/_/g, ' ')}.`) => ({ name: `mcp__robloxstudio__${raw}`, description });

function fixture() {
  const state = createStudioToolSearch({ serverName: 'robloxstudio' });
  const registrations = new Map();
  const register = state.wrapRegister((definition, options) => {
    registrations.set(definition.name, options);
    return () => registrations.delete(definition.name);
  });
  const disposers = {};
  for (const raw of ['get_project_structure', 'search_assets', 'get_asset_thumbnail', 'capture_micro_profiler', 'set_device_simulator']) {
    disposers[raw] = register(tool(raw, raw === 'search_assets' ? 'Use to find public Creator Store assets by type or keyword.' : undefined));
  }
  const admittedIn = async (raw, agent) => {
    const when = registrations.get(`mcp__robloxstudio__${raw}`)?.when;
    return when === undefined ? true : await when({ agent });
  };
  return { state, registrations, disposers, admittedIn };
}

test('core Studio tools stay visible; every other tool waits for admission', async () => {
  const { registrations, admittedIn } = fixture();
  assert.ok(CORE_TOOLS.includes('get_project_structure'));
  assert.equal(registrations.get('mcp__robloxstudio__get_project_structure').when, undefined);
  for (const raw of ['search_assets', 'get_asset_thumbnail', 'capture_micro_profiler', 'set_device_simulator']) {
    assert.equal(await admittedIn(raw, { id: 'lead' }), false, raw);
  }
});

test('a search admits matching tools for the calling agent only', async () => {
  const { state, admittedIn } = fixture();
  const lead = { id: 'lead' };
  const result = state.definition.execute({ query: 'asset search' }, { agent: lead });
  assert.equal(state.definition.name, SEARCH_TOOL);
  assert.equal(result.loaded[0].name, 'mcp__robloxstudio__search_assets');
  assert.match(result.loaded[0].summary, /Creator Store/);
  assert.equal(await admittedIn('search_assets', lead), true);
  assert.equal(await admittedIn('search_assets', { id: 'worker' }), false, 'another agent stays unchanged');
  assert.equal(await admittedIn('capture_micro_profiler', lead), false, 'unmatched tools stay hidden');
});

test('exact names load with or without the mcp prefix; unknown queries list what exists', async () => {
  const { state, admittedIn } = fixture();
  const lead = { id: 'lead' };
  state.definition.execute({ names: ['set_device_simulator', 'mcp__robloxstudio__capture_micro_profiler', 'nope'] }, { agent: lead });
  assert.equal(await admittedIn('set_device_simulator', lead), true);
  assert.equal(await admittedIn('capture_micro_profiler', lead), true);
  const none = state.definition.execute({ query: 'zzzz' }, { agent: lead });
  assert.deepEqual(none.loaded, []);
  assert.ok(none.available.includes('search_assets'));
  assert.ok(!none.available.includes('get_project_structure'), 'core tools are not listed as loadable');
});

test('an existing activation condition still applies after admission', async () => {
  const state = createStudioToolSearch({ serverName: 'robloxstudio' });
  let options;
  state.wrapRegister((_definition, given) => { options = given; return () => {}; })(tool('upload_asset'), { when: () => false });
  state.definition.execute({ names: ['upload_asset'] }, { agent: { id: 'lead' } });
  assert.equal(await options.when({ agent: { id: 'lead' } }), false);
});

test('an unregistered tool leaves the search results', () => {
  const { state, disposers } = fixture();
  disposers.search_assets();
  assert.ok(!state.deferredNames().includes('mcp__robloxstudio__search_assets'));
  assert.deepEqual(state.definition.execute({ query: 'creator store' }, { agent: { id: 'lead' } }).loaded, []);
});

test('the provided tools service wraps register and forwards every other member', () => {
  const calls = [];
  const host = { register(definition, options) { calls.push([this === host, definition.name, typeof options.when]); return () => {}; }, schemas() { return this === host; } };
  let provided;
  deferredTools({ provide: (name, value) => { assert.equal(name, 'tools'); provided = value; } },
    { host: () => host, state: createStudioToolSearch({ serverName: 'robloxstudio' }) });
  provided.register(tool('search_assets'));
  provided.register(tool('get_project_structure'));
  assert.deepEqual(calls, [[true, 'mcp__robloxstudio__search_assets', 'function'], [true, 'mcp__robloxstudio__get_project_structure', 'undefined']]);
  assert.equal(provided.schemas(), true, 'other members keep the host as this');
});
