import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../index.js';

function listener() {
  let callback;
  const dispose = () => {};
  assert.equal(apply({ on(event, fn) {
    assert.equal(event, 'tools/post-execute');
    assert.equal(callback, undefined);
    callback = fn;
    return dispose;
  } }), dispose);
  return callback;
}
function fixture() {
  const controller = new AbortController();
  return {
    controller,
    exec: { name: 'mcp__robloxstudio__get_tree', signal: controller.signal },
    result: { isError: false, value: { content: [], structuredContent: { tree: ['Workspace'] } },
      content: [{ type: 'text', text: '(get_tree returned no model-visible content)' }] },
  };
}
const handle = listener();
test('registers exactly one context-owned listener with tools injection and disposer', () => {
  assert.deepEqual(inject, ['tools']);
  listener();
});
for (const structured of [{ tree: ['Workspace'] }, {}, [], { text: '日本語\n"hi"' }]) {
  for (const empty of [false, true]) {
    test(`recovers ${JSON.stringify(structured)} with ${empty ? 'empty' : 'placeholder'} projection`, async () => {
      const { exec, result } = fixture();
      result.value.structuredContent = structured;
      if (empty) result.content = [];
      const before = structuredClone(result);
      Object.freeze(result.value.content);
      Object.freeze(result.value);
      Object.freeze(result.content);
      Object.freeze(result);
      const contexts = [{ role: 'user', content: [{ type: 'text', text: 'policy context' }] }];
      const decision = Object.freeze({ kind: 'accept', additionalContexts: contexts });
      let calls = 0;
      const output = await handle(exec, result, async () => { calls++; return decision; });
      assert.equal(calls, 1);
      assert.deepEqual(output, { kind: 'accept', additionalContexts: contexts,
        content: [{ type: 'text', text: JSON.stringify(structured) }] });
      assert.equal(output.additionalContexts, contexts);
      assert.deepEqual(result, before);
      assert.equal('content' in decision, false);
    });
  }
}
const skips = {
  'other server': f => { f.exec.name = 'mcp__other__get_tree'; },
  'prefix lookalike': f => { f.exec.name = 'mcp__robloxstudio_extra__get_tree'; },
  'missing raw name': f => { f.exec.name = 'mcp__robloxstudio__'; },
  'invalid name': f => { f.exec.name = null; },
  'failure': f => { f.result.isError = true; },
  'missing success flag': f => { delete f.result.isError; },
  'pre-cancelled': f => { f.controller.abort(); },
  'null value': f => { f.result.value = null; },
  'primitive value': f => { f.result.value = 'x'; },
  'array value': f => { f.result.value = []; },
  'missing canonical content': f => { delete f.result.value.content; },
  'invalid canonical content': f => { f.result.value.content = ''; },
  'canonical text': f => { f.result.value.content = [{ type: 'text', text: '' }]; },
  'canonical image': f => { f.result.value.content = [{ type: 'image', data: 'x' }]; },
  'missing structured': f => { delete f.result.value.structuredContent; },
  'null structured': f => { f.result.value.structuredContent = null; },
  'string structured': f => { f.result.value.structuredContent = 'data'; },
  'boolean structured': f => { f.result.value.structuredContent = false; },
  'number structured': f => { f.result.value.structuredContent = 1; },
  'invalid projection': f => { f.result.content = null; },
  'fixed runtime': f => { f.result.content = [{ type: 'text', text: '{"tree":["Workspace"]}' }]; },
  'image projection': f => { f.result.content = [{ type: 'image', image: 'x' }]; },
  'empty text is not empty array': f => { f.result.content = [{ type: 'text', text: '' }]; },
  'wrong raw name': f => { f.result.content[0].text = '(other returned no model-visible content)'; },
  'public name placeholder': f => { f.result.content[0].text = `(${f.exec.name} returned no model-visible content)`; },
  'extra whitespace': f => { f.result.content[0].text += ' '; },
  'extra block': f => { f.result.content.push({ type: 'text', text: 'policy' }); },
  'extra block metadata': f => { f.result.content[0].policy = true; },
  'null block': f => { f.result.content = [null]; },
  'primitive block': f => { f.result.content = ['']; },
  'circular structured': f => { f.result.value.structuredContent.self = f.result.value.structuredContent; },
  'unserializable structured': f => { f.result.value.structuredContent = { bad: 1n }; },
  'undefined serialization': f => { f.result.value.structuredContent = { toJSON() {} }; },
};
for (const [name, change] of Object.entries(skips)) {
  test(`leaves ${name} untouched`, async () => {
    const f = fixture(); change(f);
    const decision = { kind: 'accept' };
    let calls = 0;
    assert.equal(await handle(f.exec, f.result, async () => { calls++; return decision; }), decision);
    assert.equal(calls, 1);
  });
}
for (const decision of [
  { kind: 'block', feedback: [{ type: 'text', text: 'denied' }], additionalContexts: [] },
  { kind: 'accept', value: null }, { kind: 'accept', value: { replacement: true } },
  { kind: 'accept', content: [] }, { kind: 'accept', content: [{ type: 'text', text: 'policy' }] },
  { kind: 'accept', content: undefined }, { kind: 'accept', value: undefined },
]) {
  test(`preserves downstream decision ${JSON.stringify(decision)}`, async () => {
    const f = fixture();
    assert.equal(await handle(f.exec, f.result, async () => decision), decision);
  });
}
for (const [name, change] of Object.entries({
  cancellation: f => f.controller.abort(),
  content: f => { f.result.content[0].text = 'redacted'; },
  structured: f => { f.result.value.structuredContent.tree = []; },
  'value replacement': f => { f.result.value = structuredClone(f.result.value); },
  'content replacement': f => { f.result.content = structuredClone(f.result.content); },
  failure: f => { f.result.isError = true; },
})) {
  test(`does not overwrite downstream ${name}`, async () => {
    const f = fixture(); const decision = { kind: 'accept' };
    assert.equal(await handle(f.exec, f.result, async () => {
      await Promise.resolve(); change(f); return decision;
    }), decision);
  });
}
test('propagates downstream errors without manufacturing a successful result', async () => {
  const f = fixture(); const error = new Error('policy failed');
  await assert.rejects(handle(f.exec, f.result, async () => { throw error; }), e => e === error);
});
