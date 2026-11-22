import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const loaded = [];
globalThis.window = { __ModuleLoader__: { load: spec => loaded.push(spec) } };
await import('../client.js');

const ROLES = ['planner', 'scout', 'implementer', 'reviewer', 'qa', 'studio', 'visual'];
const TIERS = ['fast', 'standard', 'expert'];

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: fn => fn,
  useEffect: () => {},
  useState: () => [undefined, () => {}],
};

/** A React stub whose useState yields pre-seeded values in call order. */
function seeded(seeds) {
  let index = 0;
  return { ...React, useState: () => [seeds[index++], () => {}] };
}

/** Mount the plugin and return its registrations by slot name. */
function mount(plugin) {
  const registered = [];
  plugin.apply({
    slots: {
      inject: (_slot, cb) => cb?.(),
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
    },
  });
  return registered;
}

/** The single Roblox page component, which holds every section. */
function register(plugin) {
  return mount(plugin).find(entry => entry.options.name === 'main').component;
}

/** useState seeds in render order: Visual gate, then routing, then Open Cloud. */
const GATE_SEEDS = [{ status: 'ready', value: 'off', legacy: false }, null, false, null];
const CLOUD_SEEDS = [{ status: 'ready', fields: {} }, null, null, false, '', '', ''];

/** Walk a stub-React tree, materializing function components like React would. */
function walk(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out; }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') { out.push(node); return walk(node.type(node.props ?? {}), out); }
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

test('the client registers one Roblox sidebar entry and page, and no settings sections', () => {
  const plugin = loaded[0].factory(name => (name === 'react' ? React : undefined));
  assert.deepEqual(plugin.inject, ['slots']);
  const seen = [];
  plugin.apply({ slots: { inject: (slot, cb) => { seen.push(slot); cb?.(); }, register: () => () => {} } });
  assert.deepEqual(seen, ['sidebar.panellist', 'main']);
  const entries = mount(loaded[0].factory(name => (name === 'react' ? React : undefined)));
  const entry = entries.find(item => item.options.name === 'sidebar.panellist');
  const main = entries.find(item => item.options.name === 'main');
  assert.equal(entry.options.label(), 'Roblox');
  assert.equal(entry.options.id, 'dsh-roblox-development');
  assert.equal(main.options.key, entry.options.id, 'the page is keyed by the sidebar entry id');
  assert.ok(!entries.some(item => item.options.name === 'settings.section'), 'nothing is left in Settings');
});

test('the panel lays out one group per role with a tier row inside', () => {
  const roles = ROLES.map(role => ({
    role,
    tiers: TIERS.map(tier => ({
      id: `${role}/${tier}`,
      tier,
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoning_effort: 'high',
      shipped: { provider: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' },
      source: 'default',
      enabled: true,
      purpose: 'Plans the work.',
      defaultPurpose: 'Plans the work.',
    })),
  }));
  const models = [
    { provider: 'deepseek-account', model: 'deepseek-flash', label: 'DeepSeek / Flash', efforts: ['low', 'high'] },
    { provider: 'deepseek-account', model: 'deepseek-v4-pro', label: 'DeepSeek / Pro', efforts: ['high', 'max'] },
  ];
  const seeds = [...GATE_SEEDS, 'ready', null, { roles, models }, [], {}, {}, false, null, ...CLOUD_SEEDS];
  const section = register(loaded[0].factory(name => (name === 'react' ? seeded(seeds) : undefined)));
  const elements = walk(section({}));

  const selects = elements.filter(element => element.type === 'select');
  const modelPickers = selects.filter(select => / model$/.test(select.props['aria-label']));
  const effortPickers = selects.filter(select => / reasoning effort$/.test(select.props['aria-label']));
  assert.equal(modelPickers.length, 21, 'one model picker per tier');
  assert.equal(effortPickers.length, 21, 'one effort picker per tier');
  const options = modelPickers.flatMap(select => walk(select.children)).filter(element => element.type === 'option');
  assert.equal(options.length, 42, 'two connected models per picker');
  const efforts = walk(effortPickers[0].children).filter(element => element.type === 'option').map(option => option.props.value);
  assert.deepEqual(efforts, ['low', 'high'], 'effort picker offers the efforts the chosen model declares');
  assert.equal(effortPickers[0].props.value, 'high');
  assert.equal(effortPickers[0].props.disabled, false);
  const checkboxes = elements.filter(element => element.type === 'input' && element.props?.type === 'checkbox' && element.props['aria-label'] !== 'Visual gate');
  assert.equal(checkboxes.length, 21, 'one switch per tier');
  const purposes = elements.filter(element => element.type === 'textarea');
  assert.equal(purposes.length, 21, 'one purpose per tier');
  assert.ok(purposes.every(input => input.props.value === 'Plans the work.'), 'shipped purposes are prefilled');

  const headings = elements
    .filter(element => element.type === 'div' && element.props?.style?.textTransform === 'capitalize')
    .map(element => element.children?.[0]);
  assert.deepEqual(headings, ROLES, 'roles appear in matrix order');
});

test('the manifest declares the client half correctly', () => {
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.ok(manifest.files.includes('client.js'));
});

test('the effort picker keeps an unsupported saved effort visible and disables unset cells', () => {
  const roles = [{ role: 'planner', tiers: [
    { id: 'planner/fast', tier: 'fast', provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'xhigh', enabled: true, purpose: 'p' },
    { id: 'planner/standard', tier: 'standard', provider: '', model: '', reasoning_effort: '', enabled: false, purpose: 'p' },
  ] }];
  const models = [{ provider: 'deepseek-account', model: 'deepseek-flash', label: 'Flash', efforts: ['low', 'high'] }];
  const seeds = [...GATE_SEEDS, 'ready', null, { roles, models }, [], {}, {}, false, null, ...CLOUD_SEEDS];
  const section = register(loaded[0].factory(name => (name === 'react' ? seeded(seeds) : undefined)));
  const pickers = walk(section({})).filter(element => element.type === 'select' && / reasoning effort$/.test(element.props['aria-label']));
  const labels = walk(pickers[0].children).filter(element => element.type === 'option').map(option => option.children[0]);
  assert.deepEqual(labels, ['low', 'high', 'xhigh (not supported)']);
  assert.equal(pickers[1].props.disabled, true, 'no model chosen, so no effort to pick');
});

test('the client registers a Roblox screenshots tab in the right sidebar when it exists', () => {
  const plugin = loaded[0].factory(name => (name === 'react' ? React : undefined));
  const types = [];
  const seats = [];
  const slots = {
    inject: (slot, cb) => { seats.push(slot); cb?.(); },
    register: (options, component) => { seats.push({ ...options, component }); return () => {}; },
  };
  const tabsCtx = {
    slots,
    sidebarRightTabs: { register: definition => { types.push(definition); return () => {}; } },
    effect: fn => fn(),
  };
  plugin.apply({ slots, inject: (deps, cb) => { assert.deepEqual(deps, ['sidebarRightTabs']); cb(tabsCtx); } });
  assert.equal(types.length, 1);
  assert.equal(types[0].kind, 'roblox-screenshots');
  assert.equal(types[0].guide[0].title(), 'Roblox screenshots');
  const body = seats.find(seat => seat?.name === 'sidebar.right.pane.tab');
  assert.equal(body.key, types[0].id);
  assert.deepEqual(body.inject('session-1'), { sessionId: 'session-1' });
  assert.ok(seats.some(seat => seat?.name === 'sidebar.right.pane.tab.title' && seat.key === types[0].id));
  assert.doesNotThrow(() => plugin.apply({ slots }), 'compositions without a right sidebar still mount');
});

test('the Roblox page holds the Open Cloud section with write-only fields', () => {
  const ready = {
    status: 'ready',
    fields: { apiKey: { configured: true, source: 'stored', writable: true, masked: 'fixture-preview-should-not-render' }, creatorUserId: { configured: false, writable: true }, creatorGroupId: { configured: false, writable: true } },
  };
  // useState order across the page: Visual gate, routing (loading), then CloudPanel (state, failure, notice, busy) and one draft per field.
  const plugin = loaded[0].factory(name => (name === 'react' ? seeded([...GATE_SEEDS, 'loading', null, { roles: [], models: [] }, [], {}, {}, false, null, ready, null, null, false, '', '', '']) : undefined));
  const page = mount(plugin).find(entry => entry.options.name === 'main');
  assert.ok(page, 'the Roblox page is registered');

  const all = walk({ type: page.component, props: {}, children: [] });
  assert.ok(all.some(node => node.props?.['data-roblox-routing-section']), 'routing section is on the page');
  assert.ok(all.some(node => node.props?.['data-roblox-visual-gate-section']), 'visual gate section is on the page');
  const nodes = all.filter(node => node.type !== 'select');
  const inputs = nodes.filter(node => node.type === 'input' && node.props?.type !== 'checkbox');
  assert.equal(inputs.length, 3);
  const key = inputs.find(node => node.props['aria-label'] === 'Open Cloud API key');
  assert.equal(key.props.type, 'password');
  assert.equal(key.props.autoComplete, 'new-password');
  assert.equal(key.props.value, '', 'a saved value is never put back into the field');
  const renderedText = nodes.flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
  assert.doesNotMatch(renderedText, /Restart DSH|fixture-preview-should-not-render/);
  const clearButtons = nodes.filter(node => node.type === 'button' && node.children.includes('Clear'));
  assert.equal(clearButtons.length, 3);
  assert.equal(clearButtons[0].props.disabled, false, 'a configured field can be cleared');
  assert.equal(clearButtons[1].props.disabled, true, 'an unset field cannot');
});

function gateSection(seeds) {
  // Gate seeds come first on the page; the routing panel and Open Cloud panel are left loading.
  const plugin = loaded[0].factory(name => (name === 'react' ? seeded([...seeds, 'loading', null, { roles: [], models: [] }, [], {}, {}, false, null, ...CLOUD_SEEDS]) : undefined));
  return mount(plugin).find(entry => entry.options.name === 'main');
}

test('the Visual gate section shows an Off-by-default switch and says when a change applies', () => {
  const section = gateSection([{ status: 'ready', value: 'off', legacy: false }, null, false, null]);
  assert.ok(section, 'the Roblox page is registered');
  assert.equal(section.options.name, 'main');
  const nodes = walk({ type: section.component, props: {}, children: [] });
  const toggle = nodes.find(node => node.type === 'input' && node.props?.['aria-label'] === 'Visual gate');
  assert.ok(toggle, 'a Visual gate switch');
  assert.equal(toggle.props.type, 'checkbox');
  assert.equal(toggle.props.role, 'switch');
  assert.equal(toggle.props.checked, false);
  const text = nodes.flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
  assert.match(text, /Visual gate: Off/);
  assert.match(text, /one implementer and one Studio check/);
  assert.match(text, /new Roblox development session/);
  assert.match(text, /already running keep the setting they started with/);
  assert.match(text, /restart DSH/);
});

test('the Visual gate switch reflects On and a legacy auto value is called out as Off', () => {
  const nodes = walk({ type: gateSection([{ status: 'ready', value: 'on', legacy: true }, null, false, null]).component, props: {}, children: [] });
  assert.equal(nodes.find(node => node.props?.['aria-label'] === 'Visual gate').props.checked, true);
  const text = nodes.flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
  assert.match(text, /Visual gate: On/);
  assert.match(text, /legacy “auto” value was found and is treated as Off/);
});
