import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadRoutes,
  loadPolicy,
  evaluateDispatch,
  createGuard,
} from '../routing.js';

const routes = loadRoutes();
const policy = loadPolicy(routes);

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

test('every routes.json role/tier triple passes the guard, matrix built from the file itself', () => {
  const triples = [];
  for (const tiers of Object.values(routes.roles)) {
    for (const entries of Object.values(tiers)) {
      for (const entry of entries) {
        triples.push({ provider: entry.provider, model: entry.model, reasoning_effort: entry.reasoning_effort });
      }
    }
  }
  assert.ok(triples.length >= 20, 'the full role/tier matrix feeds the guard');
  for (const triple of triples) {
    assert.equal(evaluateDispatch(spawn(triple), policy).kind, 'allow', JSON.stringify(triple));
  }
  const distinct = new Set(triples.map(t => `${t.provider}\0${t.model}\0${t.reasoning_effort}`));
  assert.equal(distinct.size, policy.matrix.length, 'matrix deduplicates to exact distinct routes');
});

test('loadPolicy rejects a route missing its explicit effort', () => {
  const broken = JSON.parse(JSON.stringify(routes));
  delete broken.roles.planner.fast[0].reasoning_effort;
  assert.throws(() => loadPolicy(broken), /reasoning_effort/);
});

test('dispatch without any route fields is denied with an actionable message', () => {
  const verdict = evaluateDispatch(spawn({ description: 'x', prompt: 'y' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.reason, /provider, model and reasoning_effort together/);
  assert.match(verdict.reason, /routes\.json/);
  assert.match(verdict.reason, /missing: provider, model, reasoning_effort/);
  assert.equal(verdict.info.code, 'ROUTING_ROUTE_REQUIRED');
});

test('a partial route is denied and names exactly the missing fields', () => {
  for (const [given, missing] of [
    [{ provider: 'xiaomi' }, 'model, reasoning_effort'],
    [{ model: 'mimo-v2.6-pro' }, 'provider, reasoning_effort'],
    [{ provider: 'xiaomi', model: 'mimo-v2.6-pro' }, 'reasoning_effort'],
    [{ reasoning_effort: 'high' }, 'provider, model'],
  ]) {
    const verdict = evaluateDispatch(spawn(given), policy);
    assert.equal(verdict.kind, 'deny', JSON.stringify(given));
    assert.match(verdict.reason, new RegExp(`missing: ${missing.replace(', ', ', ')}`));
    assert.equal(verdict.info.code, 'ROUTING_ROUTE_REQUIRED');
  }
});

test('empty route field values are denied like missing fields', () => {
  const verdict = evaluateDispatch(spawn({ provider: 'xiaomi', model: '', reasoning_effort: 'high' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.match(verdict.reason, /missing: model/);
});

test('an off-matrix triple is denied even when complete', () => {
  const verdict = evaluateDispatch(spawn({ provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoning_effort: 'medium' }), policy);
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.info.code, 'ROUTING_OFF_MATRIX');
  assert.match(verdict.reason, /xiaomi\/mimo-v2\.6-pro/);
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
  assert.equal(guard(spawn({ provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoning_effort: 'high' })), undefined);
  assert.deepEqual(lines, []);
});

test('fork dispatch is denied: it cannot carry a tier route', () => {
  const verdict = evaluateDispatch({ name: 'subagent_fork', arguments: { description: 'x', prompt: 'y' } }, policy);
  assert.equal(verdict.kind, 'deny');
  assert.equal(verdict.info.code, 'ROUTING_FORK_UNSUPPORTED');
  assert.match(verdict.reason, /subagent tool/);
  const withRoute = evaluateDispatch({ name: 'subagent_fork', arguments: { provider: 'xiaomi', model: 'mimo-v2.6-pro', reasoning_effort: 'high' } }, policy);
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

test('independent final review keeps cross-provider routes available', () => {
  assert.deepEqual(routes.independentReview, { differentWorker: true, crossProvider: true, preliminaryIsApproval: false });
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
  assert.equal(reloaded.matrix.length, policy.matrix.length);
});
