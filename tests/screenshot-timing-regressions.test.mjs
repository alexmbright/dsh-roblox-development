import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrain, sessionState } from '../skill-policy.js';
import { capturesIn, captureId } from '../screenshots.js';
const brain = loadBrain();
const T = Date.parse('2026-11-15T12:00:00Z');
const ref = { attachmentId: 'sha256-identical-1111111111', width: 1280, height: 720, mediaType: 'image/png', bytes: 1 };
let n = 0;
function pair(name, args, content, callTime, resultTime) {
  const callId = `timing-${++n}`;
  return [{ type: 'tool/call', time: callTime, data: { name, callId, arguments: JSON.stringify(args) } },
    { type: 'tool/result', time: resultTime, data: { message: { toolCallId: callId, content } } }];
}
const shot = (start, end) => pair('capture_screenshot', {}, [{ type: 'image', attachment: ref }], start, end);
test('a delayed capture result cannot turn an earlier acquisition into fresh evidence', () => {
  const session = { events: shot(T, T + 10_000) };
  const state = sessionState(session, brain);
  assert.equal(state.screenshots[0].time, T);
  assert.equal(state.screenshots[0].viewedAt, T + 10_000);
  assert.equal(capturesIn(session)[0].time, T);
});
test('a new capture occurrence with identical pixels earns its own capture time', () => {
  const events = [...shot(T, T + 10), ...shot(T + 1000, T + 1010)];
  const state = sessionState({ events }, brain);
  assert.deepEqual(state.screenshots.map(s => s.time), [T, T + 1000]);
  assert.equal(state.captures.get(captureId(ref.attachmentId)).time, T + 1000);
});
test('dispatch uses call time, not delayed return time, and missing timestamps fail closed', () => {
  for (const time of [T, undefined]) {
    const events = pair('subagent', { prompt: 'Role: visual/standard\nReview cap-1111111111' },
      [{ type: 'text', text: 'started subagent review' }], time, T + 100_000);
    assert.equal(sessionState({ events }, brain).dispatchLog[0].time, time ?? 0);
  }
});
