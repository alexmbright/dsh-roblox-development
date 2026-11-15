import test from 'node:test';
import assert from 'node:assert/strict';
import { statusContext } from '../coordination.js';
import { loadBrain, createEvidenceStore } from '../skill-policy.js';

const brain = loadBrain();
const store = () => createEvidenceStore({ brain, ctx: { get: key => (key === 'subagents'
  ? { namesOf: agent => ({ self: agent.id }), listDescendants: async () => [] }
  : key === 'agents' ? { get: id => ({ id }) } : undefined) } });

test('no context until the lead delegates', () => {
  assert.equal(statusContext(store().view('lead')), '');
});

test('running workers are what the lead is waiting on', () => {
  const s = store();
  s.start({ id: 'implementer', parentSessionId: 'lead' });
  s.start({ id: 'reviewer', parentSessionId: 'lead' });
  s.start({ id: 'other', parentSessionId: 'other-lead' });
  const text = statusContext(s.view('lead'));
  assert.match(text, /Waiting on 2 worker\(s\)/);
  assert.match(text, /implementer: running/);
  assert.match(text, /reviewer: running/);
  assert.doesNotMatch(text, /other/);
  assert.match(text, /"Waiting on:" line/);
});

test('finished workers move out of the waiting list with their outcome, newest first', async () => {
  const s = store();
  s.start({ id: 'impl', parentSessionId: 'lead' });
  await s.end({ id: 'impl', parentSessionId: 'lead', stopReason: 'completed' });
  s.start({ id: 'qa', parentSessionId: 'lead' });
  await s.end({ id: 'qa', parentSessionId: 'lead', stopReason: 'error' });
  const text = statusContext(s.view('lead'));
  assert.match(text, /Waiting on: nothing/);
  assert.match(text, /qa: error\n {2}- impl: completed/);
  assert.match(text, /Announce each finished worker/);
});

test('the status text is stable between worker events, so it does not break prompt caching', () => {
  const s = store();
  s.start({ id: 'impl', parentSessionId: 'lead' });
  const first = statusContext(s.view('lead'));
  assert.equal(statusContext(s.view('lead')), first);
});

test('finished history is bounded so the context stays small', async () => {
  const s = store();
  for (let i = 0; i < 20; i += 1) {
    s.start({ id: `w${i}`, parentSessionId: 'lead' });
    await s.end({ id: `w${i}`, parentSessionId: 'lead', stopReason: 'completed' });
  }
  const view = s.view('lead');
  assert.equal(view.finished.length, 5);
  assert.ok(statusContext(view).length < 800);
});

test('only direct workers appear in the lead status', () => {
  const s = store();
  s.start({ id: 'impl', parentSessionId: 'lead' });
  s.start({ id: 'helper', parentSessionId: 'impl' });
  const text = statusContext(s.view('lead'));
  assert.match(text, /impl: running/);
  assert.doesNotMatch(text, /helper/);
});
