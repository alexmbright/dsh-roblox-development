/**
 * Stored-Session reads across DSH releases: `observeSession` leases (0.2.3+) and the
 * `inspectSession` fallback (0.2.2-rc.5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadStoredSession, readStoredSession } from '../session-read.js';
import { collectTreeById } from '../screenshots.js';
import { rootSessionOf } from '../screenshot-bridge.js';

const ref = id => ({ attachmentId: id, mediaType: 'image/png', bytes: 4, width: 800, height: 600 });
const capture = (attachmentId, callId, time) => [
  { type: 'tool/call', seq: 0, time, data: { turn: 1, name: 'mcp__robloxstudio__capture_screenshot', callId, arguments: '{}' } },
  { type: 'tool/result', seq: 1, time, data: { turn: 1, message: { toolCallId: callId, content: [{ type: 'text', text: '{}' }, { type: 'image', attachment: ref(attachmentId) }] } } },
];

/** A 0.2.3-style query service: observation leases, no inspectSession. */
function observingQuery(stored) {
  const calls = [];
  let open = 0;
  return {
    calls,
    open: () => open,
    observeSession: async (id, options) => {
      calls.push({ id, options });
      if (!stored.has(id)) throw Object.assign(new Error(`Session ${id} not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      const { header, events } = stored.get(id);
      open += 1;
      let disposed = false;
      return {
        source: 'prepared',
        header: { id, ...header },
        inheritedEventCount: 0,
        events: Object.freeze([...events]),
        cursor: events.length - 1,
        retain() { throw new Error('not used'); },
        [Symbol.dispose]() { if (!disposed) { disposed = true; open -= 1; } },
      };
    },
  };
}

test('availability covers both DSH releases', () => {
  assert.equal(canReadStoredSession(undefined), false);
  assert.equal(canReadStoredSession({}), false);
  assert.equal(canReadStoredSession({ observeSession() {} }), true);
  assert.equal(canReadStoredSession({ inspectSession() {} }), true);
});

test('observeSession is preferred, skips projections, forwards the signal and releases the lease', async () => {
  const query = observingQuery(new Map([['w', { header: { parentSession: 'lead', origin: 'subagent' }, events: capture('sha256-a', 'c1', 5) }]]));
  query.inspectSession = async () => { throw new Error('legacy path must not run when observeSession exists'); };
  const signal = new AbortController().signal;
  const view = await readStoredSession(query, 'w', session => ({ header: session.header, count: session.events.length, id: session.id }), signal);
  assert.deepEqual(view, { header: { id: 'w', parentSession: 'lead', origin: 'subagent' }, count: 2, id: 'w' });
  assert.deepEqual(query.calls, [{ id: 'w', options: { signal, projectionMode: 'none' } }]);
  assert.equal(query.open(), 0, 'lease released');
  await readStoredSession(query, 'w', () => undefined);
  assert.deepEqual(query.calls[1].options, { projectionMode: 'none' }, 'no undefined signal key');
});

test('the lease is released even when the reader throws', async () => {
  const query = observingQuery(new Map([['w', { header: {}, events: [] }]]));
  await assert.rejects(readStoredSession(query, 'w', () => { throw new Error('reader failed'); }), /reader failed/);
  assert.equal(query.open(), 0);
});

test('missing sessions reject with the service error', async () => {
  await assert.rejects(readStoredSession(observingQuery(new Map()), 'gone', () => 1), /Session gone not found/);
});

test('DSH 0.2.2-rc.5 inspectSession remains the fallback', async () => {
  const prepared = { id: 'w', header: { parentSession: 'lead' }, events: [] };
  const query = { inspectSession: async (id, read, signal) => read({ ...prepared, signal }) };
  const signal = new AbortController().signal;
  assert.equal(await readStoredSession(query, 'w', session => session.signal === signal && session.header.parentSession, signal), 'lead');
});

test('an observation without events falls back to inspectSession when present', async () => {
  const query = {
    observeSession: async () => ({ header: {}, [Symbol.dispose]() {} }),
    inspectSession: async (_id, read) => read({ header: { legacy: true }, events: [] }),
  };
  assert.equal(await readStoredSession(query, 'w', session => session.header.legacy), true);
});

test('no read method rejects instead of returning empty evidence', async () => {
  await assert.rejects(readStoredSession(undefined, 'w', () => 1), /session log unavailable/);
  await assert.rejects(readStoredSession({}, 'w', () => 1), /session log unavailable/);
});

test('screenshots and the sidebar bridge read settled workers on DSH 0.2.3', async () => {
  const stored = new Map([
    ['lead', { header: {}, events: [] }],
    ['qa', { header: { origin: 'subagent', parentSession: 'lead' }, events: capture('sha256-bbbbbbbbbbbbbbbb2222222222', 'c2', 2000) }],
  ]);
  const query = observingQuery(stored);
  const ctx = {
    get: key => ({
      agents: { get: () => undefined },
      subagents: { listDescendants: async () => [{ kind: 'child', id: 'qa', parentId: 'lead', name: 'qa-devices' }] },
      sessionQuery: query,
    })[key],
  };
  const { captures, unreadable } = await collectTreeById(ctx, 'lead');
  assert.deepEqual(unreadable, []);
  assert.deepEqual(captures.map(c => [c.agent, c.tool]), [['qa-devices', 'capture_screenshot']]);
  assert.equal(await rootSessionOf(ctx, 'qa'), 'lead', 'worker resolved to its lead through the observed header');
  assert.equal(query.open(), 0, 'every lease released');
});
