import test from 'node:test';
import assert from 'node:assert/strict';

const routing = await import('../routing.js');

/** A ctx stub that mimics the parts of the tool registry the guard touches. */
function harness() {
  const registered = [];
  const guards = [];
  const cleanups = [];
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    tools: {
      guard: fn => { guards.push(fn); return () => {}; },
      register: definition => {
        // Mirror the shipped registry's own precondition.
        if (definition?.output === undefined || typeof definition.output.render !== 'function') {
          throw new TypeError(`tool "${definition?.name}" must declare output { schema, render, presentationMeta? }`);
        }
        registered.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, registered, guards, cleanups };
}

test('apply mounts a guard and never throws', () => {
  const { ctx, guards } = harness();
  const dispose = routing.apply(ctx, {});
  assert.equal(guards.length, 1);
  assert.ok(dispose === undefined || typeof dispose === 'function');
});

test('the guard tolerates a missing routing service', () => {
  const { ctx, guards } = harness();
  routing.apply(ctx, {});
  const verdict = guards[0]({ name: 'subagent', arguments: { provider: 'claude', model: 'claude-opus-5-5', reasoning_effort: 'high' } });
  assert.ok(verdict === undefined || typeof verdict === 'object', 'a dispatch is decided, not crashed');
});

test('roblox_routes registers with a renderable output schema', () => {
  const { ctx, registered } = harness();
  routing.apply(ctx, {});
  const tool = registered.find(definition => definition.name === 'roblox_routes');
  assert.ok(tool, 'roblox_routes registered');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.output.schema.type, 'object');
  assert.deepEqual(tool.parameters?.type, 'object');
});

test('a rejected tool registration cannot fail the plugin mount', () => {
  const { ctx } = harness();
  ctx.tools.register = () => { throw new TypeError('registry refused'); };
  assert.doesNotThrow(() => routing.apply(ctx, {}));
});

test('a coordinator may not block on a worker', async () => {
  const { blockingWaitDenial } = await import('../routing.js');
  const coordinator = { name: 'wait_agent', agent: { session: { header: { origin: 'desktop' } } } };
  const worker = { name: 'wait_agent', agent: { session: { header: { origin: 'subagent' } } } };
  const other = { name: 'subagent', agent: { session: { header: { origin: 'desktop' } } } };

  const denial = blockingWaitDenial(coordinator);
  assert.ok(denial, 'coordinator wait is refused');
  assert.equal(denial.info.code, 'ROUTING_NO_BLOCKING_WAIT');
  assert.match(denial.reason, /end your turn/);

  assert.equal(blockingWaitDenial(worker), undefined, 'a worker may wait on its children');
  assert.equal(blockingWaitDenial(other), undefined, 'unrelated tools are untouched');
});

test('the mounted guard enforces skills after routing and registers the audit tool', () => {
  const { ctx, guards, registered } = harness();
  routing.apply(ctx, {});
  assert.ok(registered.some(definition => definition.name === 'roblox_skill_audit'));
  const session = { id: 'lead', header: {}, events: [] };
  const route = { provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' };
  const denial = guards[0]({ name: 'subagent', arguments: { ...route, prompt: 'do it' }, agent: { id: 'lead', session } });
  assert.equal(denial?.info?.code, 'SKILLS_LEAD_NOT_GROUNDED');
  const unrouted = guards[0]({ name: 'subagent', arguments: { prompt: 'do it' }, agent: { id: 'lead', session } });
  assert.equal(unrouted?.info?.code, 'ROUTING_ROUTE_REQUIRED', 'routing denial still comes first');
  assert.equal(guards[0]({ name: 'read', arguments: {}, agent: { id: 'lead', session } }), undefined);
});

test('worker status context is lead-only and follows subagent lifecycle events', () => {
  const { ctx } = harness();
  const listeners = {};
  const contexts = [];
  ctx.on = (name, fn) => { listeners[name] = fn; return () => {}; };
  ctx.get = name => (name === 'systemPrompt'
    ? { context: c => { contexts.push(c); return () => {}; }, getContextOrder: () => 100 }
    : undefined);
  routing.apply(ctx, {});
  const status = contexts.find(c => c.name === 'roblox-worker-status');
  assert.ok(status, 'context registered');
  const leadContext = { agent: { id: 'lead', session: { id: 'lead', header: {} } } };
  assert.equal(status.text(leadContext), '');
  listeners['subagent/start']({ id: 'w1', parentSessionId: 'lead' });
  assert.match(status.text(leadContext), /Waiting on 1 worker/);
  listeners['subagent/end']({ id: 'w1', parentSessionId: 'lead', stopReason: 'completed' });
  assert.match(status.text(leadContext), /Waiting on: nothing[^]*w1: completed/);
  const workerContext = { agent: { id: 'w1', session: { id: 'w1', header: { origin: 'subagent' } } } };
  assert.equal(status.text(workerContext), '');
});
