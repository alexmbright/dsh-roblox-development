import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadRoutes,
  loadPolicy,
  policyFromTriples,
  mainModelMatrix,
  evaluateDispatch,
  createGuard,
} from '../routing.js';

const routes = loadRoutes();
// routes.json ships no models, so guard mechanics are exercised against a fixture matrix standing
// in for what the Roblox routing panel publishes.
const FIXTURE = [
  { provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' },
  { provider: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high' },
  { provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'low' },
  { provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'high' },
];
const policy = policyFromTriples(routes, FIXTURE);

/** One spawn dispatch carrying an explicit role/tier route. */
const spawn = (args, name = policy.spawnTools[0]) => ({ name, arguments: args });

test('dispatchGuard policy block names the enforced delegation tools and fields', () => {
  const guard = routes.dispatchGuard;
  assert.equal(guard.enforced, true);
  assert.deepEqual(guard.spawnTools, ['subagent']);
  assert.deepEqual(guard.forkTools, ['subagent_fork']);
  assert.deepEqual(guard.requiredRouteFields, ['provider', 'model', 'reasoning_effort']);
  assert.equal(guard.capacityFallbackArgument, 'capacityFallback');
  assert.equal(guard.logsOffMatrixFallback, true);
  assert.equal(routes.runtimeRouter, false, 'the guard gates dispatch; it never routes models');
  assert.equal(routes.automaticModelSwitch, false);
});

test('routes.json ships no dispatchable route: every model comes from the panel', () => {
  const cells = Object.values(routes.roles).flatMap(tiers => Object.values(tiers)).flat();
  assert.equal(cells.length, 21, 'one documented entry per role/tier cell');
  for (const entry of cells) {
    for (const field of ['provider', 'model', 'reasoning_effort']) assert.equal(entry[field], undefined, field);
    assert.ok(typeof entry.purpose === 'string' && entry.purpose !== '');
  }
  assert.deepEqual(loadPolicy(routes).matrix, []);
});

test('every published triple passes the guard', () => {
  for (const triple of FIXTURE) {
    assert.equal(evaluateDispatch(spawn(triple), policy).kind, 'allow', JSON.stringify(triple));
  }
});

test('loadPolicy rejects a partially specified route', () => {
  const broken = JSON.parse(JSON.stringify(routes));
  broken.roles.planner.fast[0] = { ...broken.roles.planner.fast[0], provider: 'claude', model: 'claude-sonnet-5-5' };
  assert.throws(() => loadPolicy(broken), /reasoning_effort/);
});

test('before the panel publishes, only the main model is dispatchable', () => {
  const ctx = { get: name => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'max' }) }
    : undefined) };
  assert.deepEqual(mainModelMatrix(ctx), [{ provider: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'max' }]);
  assert.deepEqual(mainModelMatrix({ get: () => undefined }), [], 'no main model, nothing allowed');
  assert.deepEqual(mainModelMatrix({ get: () => { throw new Error('unavailable'); } }), []);
});

test('dispatch without any route fields is denied with an actionable message', () => {
  const verdict = evaluateDispatch(spawn({ description: 'x', prompt: 'y' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.reason, /provider, model and reasoning_effort together/);
  assert.match(verdict.reason, /roblox_routes/);
  assert.match(verdict.reason, /missing: provider, model, reasoning_effort/);
  assert.equal(verdict.info.code, 'ROUTING_ROUTE_REQUIRED');
});

test('a partial route is denied and names exactly the missing fields', () => {
  for (const [given, missing] of [
    [{ provider: 'claude' }, 'model, reasoning_effort'],
    [{ model: 'claude-sonnet-5-5' }, 'provider, reasoning_effort'],
    [{ provider: 'claude', model: 'claude-sonnet-5-5' }, 'reasoning_effort'],
    [{ reasoning_effort: 'high' }, 'provider, model'],
  ]) {
    const verdict = evaluateDispatch(spawn(given), policy);
    assert.equal(verdict.kind, 'deny', JSON.stringify(given));
    assert.match(verdict.reason, new RegExp(`missing: ${missing.replace(', ', ', ')}`));
    assert.equal(verdict.info.code, 'ROUTING_ROUTE_REQUIRED');
  }
});

test('empty route field values are denied like missing fields', () => {
  const verdict = evaluateDispatch(spawn({ provider: 'claude', model: '', reasoning_effort: 'high' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.reason, /missing: model/);
});

test('an off-matrix triple is denied even when complete', () => {
  const verdict = evaluateDispatch(spawn({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'medium' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.info.code, 'ROUTING_OFF_MATRIX');
  assert.match(verdict.reason, /claude\/claude-sonnet-5-5/);
  assert.match(verdict.reason, /capacityFallback/);
});

test('the same model at a different effort is a different route (deepseek-flash low vs high)', () => {
  assert.equal(evaluateDispatch(spawn({ provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'low' }), policy).kind, 'allow');
  assert.equal(evaluateDispatch(spawn({ provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'high' }), policy).kind, 'allow');
  assert.equal(evaluateDispatch(spawn({ provider: 'deepseek-account', model: 'deepseek-flash', reasoning_effort: 'xhigh' }), policy).kind, 'deny');
});

test('capacity fallback needs a non-empty reason and is allowed plus clearly logged', () => {
  const lines = [];
  const guard = createGuard(policy, { log: line => lines.push(line) });
  const args = { provider: 'claude', model: 'claude-haiku-5-5', reasoning_effort: 'high', capacityFallback: 'claude quota exhausted, Sonnet latency breached SLA' };
  assert.equal(guard(spawn(args)), undefined, 'logged fallback passes the guard');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /capacity fallback/i);
  assert.match(lines[0], /claude\/claude-haiku-5-5/);
  assert.match(lines[0], /claude quota exhausted/);
});

test('an empty fallback marker is not an opt-in', () => {
  for (const marker of ['', '   ', 42, {}, true]) {
    const verdict = evaluateDispatch(spawn({ provider: 'claude', model: 'claude-haiku-5-5', reasoning_effort: 'high', capacityFallback: marker }), policy);
    assert.equal(verdict.kind, 'deny', JSON.stringify(marker));
  }
});

test('clean matrix dispatch logs nothing', () => {
  const lines = [];
  const guard = createGuard(policy, { log: line => lines.push(line) });
  assert.equal(guard(spawn({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' })), undefined);
  assert.deepEqual(lines, []);
});

test('fork dispatch is denied: it cannot carry a tier route', () => {
  const verdict = evaluateDispatch({ name: 'subagent_fork', arguments: { description: 'x', prompt: 'y' } }, policy);
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.info.code, 'ROUTING_FORK_UNSUPPORTED');
  assert.match(verdict.reason, /subagent tool/);
  const withRoute = evaluateDispatch({ name: 'subagent_fork', arguments: { provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' } }, policy);
  assert.equal(withRoute.kind, 'deny', 'route fields cannot tier a fork child');
});

test('unrelated tools pass untouched and no guard result is produced', () => {
  for (const name of ['pwsh', 'read', 'list_subagent_models', 'todo_write']) {
    assert.equal(evaluateDispatch({ name, arguments: { anything: 1 } }, policy).kind, 'allow', name);
  }
});

test('guard denials carry the structured identity contract', () => {
  const guard = createGuard(policy, { log: () => {} });
  const denial = guard(spawn({}));
  assert.equal(typeof denial.reason, 'string');
  assert.equal(denial.info.name, 'roblox-routing-guard');
  assert.ok(denial.info.code.startsWith('ROUTING_'));
});

test('independent review needs a different worker but not a different provider, and stays routable', () => {
  assert.deepEqual(routes.independentReview, { differentWorker: true, crossProvider: false, preliminaryIsApproval: false });
  const reviewerStandard = evaluateDispatch(spawn({ provider: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high' }), policy);
  const implementerStandard = evaluateDispatch(spawn({ provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' }), policy);
  assert.equal(reviewerStandard.kind, 'allow');
  assert.equal(implementerStandard.kind, 'allow');
  assert.notEqual('codex', 'claude');
});

test('the guard module resolves routes.json beside itself at runtime', () => {
  const raw = JSON.parse(readFileSync(new URL('../routes.json', import.meta.url), 'utf8'));
  assert.equal(raw.dispatchGuard.enforced, true);
  const reloaded = loadPolicy(raw);
  assert.deepEqual(reloaded.matrix, [], 'the shipped file contributes rules, never routes');
});
