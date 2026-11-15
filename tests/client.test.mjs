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

function register(plugin) {
  const registered = [];
  plugin.apply({
    slots: {
      inject: (_slot, cb) => cb?.(),
      register: (_options, component) => { registered.push(component); return () => {}; },
    },
  });
  return registered[0];
}

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

test('the client registers a Roblox routing settings section', () => {
  const plugin = loaded[0].factory(name => (name === 'react' ? React : undefined));
  assert.deepEqual(plugin.inject, ['slots']);
  const seen = [];
  plugin.apply({ slots: { inject: (slot, cb) => { seen.push(slot); cb?.(); }, register: () => () => {} } });
  assert.deepEqual(seen, ['settings.section']);
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
  const seeds = ['ready', null, { roles, models }, [], {}, {}, false, null];
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
  const checkboxes = elements.filter(element => element.type === 'input' && element.props?.type === 'checkbox');
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
  const seeds = ['ready', null, { roles, models }, [], {}, {}, false, null];
  const section = register(loaded[0].factory(name => (name === 'react' ? seeded(seeds) : undefined)));
  const pickers = walk(section({})).filter(element => element.type === 'select' && / reasoning effort$/.test(element.props['aria-label']));
  const labels = walk(pickers[0].children).filter(element => element.type === 'option').map(option => option.children[0]);
  assert.deepEqual(labels, ['low', 'high', 'xhigh (not supported)']);
  assert.equal(pickers[1].props.disabled, true, 'no model chosen, so no effort to pick');
});
