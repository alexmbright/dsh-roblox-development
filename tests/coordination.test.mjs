import test from 'node:test';
import assert from 'node:assert/strict';
import { statusContext, concurrencyCorrection } from '../coordination.js';
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

// Replies from a real session where the lead parked four workers behind one Studio operator.
const PARKED = [
  "Studio can only be used by one worker at a time, so these go one after another.",
  "**mobile-shop-fix** has finished planning outside Studio and is idle. It goes into Studio as soon as **pad-expert** hands it back.",
  "**loading-screen** is idle until it gets Studio.",
  "The Studio order after **pad-expert** and its final pad review is: **mobile-shop-fix**, **favorite-prompt**, **loading-screen**.",
  "Waiting on: mobile-shop-fix (codex/gpt-6.1-terra at high) — waiting for Studio",
  "then the menus, favorite popup, loading screen and catering stand, one at a time.",
];

test('a reply that queues work behind Studio with one worker running owes a correction', () => {
  for (const reply of PARKED) {
    const text = concurrencyCorrection({ reply, running: 1 });
    assert.match(text, /offline part now/, reply);
    assert.match(text, /name that conflict/);
  }
  assert.match(concurrencyCorrection({ reply: PARKED[0], running: 0 }), /Only 0 worker/);
});

test('no correction when several workers run or the reply queues nothing', () => {
  assert.equal(concurrencyCorrection({ reply: PARKED[0], running: 2 }), '');
  assert.equal(concurrencyCorrection({ reply: 'pad-review is reviewing in Studio. Waiting on: pad-review (claude at high)', running: 1 }), '');
  assert.equal(concurrencyCorrection({ reply: 'Waiting on: nothing', running: 0 }), '');
});

test('the status names idle capacity when at most one worker runs', async () => {
  const s = store();
  s.start({ id: 'impl', parentSessionId: 'lead' });
  await s.end({ id: 'impl', parentSessionId: 'lead', stopReason: 'completed' });
  s.start({ id: 'operator', parentSessionId: 'lead' });
  assert.match(statusContext(s.view('lead')), /send every remaining task to a worker now/);
  s.start({ id: 'ui', parentSessionId: 'lead' });
  assert.doesNotMatch(statusContext(s.view('lead')), /send every remaining task/);
});
