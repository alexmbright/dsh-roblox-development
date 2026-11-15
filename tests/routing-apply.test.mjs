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
