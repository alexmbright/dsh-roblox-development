import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, renameSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assetEvidence, auditSession, loadBrain, registerAuditTool, sessionState } from '../skill-policy.js';
import { captureId, capturesIn, isSuspicious, registerScreenshotTool, STORED_MARKER } from '../screenshots.js';

// Synthetic events and files are isolated test fixtures, never real worker/session logs.
const brain = loadBrain();
const T0 = Date.parse('2026-11-15T12:00:00Z');
const attachment = (extra = {}) => ({ attachmentId: 'sha256-capture-1234567890', mediaType: 'image/png', bytes: 20, width: 1280, height: 720, ...extra });
const image = (ref = attachment()) => ({ type: 'image', attachment: ref });
const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
let sequence = 0;
const result = (name, args, content, time = T0) => {
  const callId = `capture-test-${sequence += 1}`;
  return [
    { type: 'tool/call', time, data: { name, callId, arguments: JSON.stringify(args) } },
    { type: 'tool/result', time, data: { message: { toolCallId: callId, isError: false, content } } },
  ];
};
const session = (events, cwd) => ({ id: 'test', header: { cwd }, events });
const capture = (ref = attachment(), time = T0, content = [image(ref)]) => result('mcp__studio__capture_screenshot', {}, content, time);
const read = (file, ref = attachment(), time = T0 + 90_000) => result('read_image', { file_path: file }, [image(ref)], time);
const temporary = t => {
  const root = mkdtempSync(path.join(tmpdir(), 'screenshot-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const fileAt = (root, name = 'screenshot.png', time = T0 + 1000) => {
  const file = path.join(root, name);
  writeFileSync(file, 'isolated test image bytes');
  utimesSync(file, time / 1000, time / 1000);
  return file;
};

test('fallback result metadata applies before or after every image and stored marker', () => {
  const ref = attachment();
  const blocks = [image(ref), text(`${STORED_MARKER} ${JSON.stringify({ attachment: ref })}`), text({ studioFastPathUnavailable: true })];
  for (const content of [blocks, [...blocks].reverse(), [blocks[0], blocks[2], blocks[1]]]) {
    const events = capture(ref, T0, content);
    const listed = capturesIn(session(events), 'qa');
    assert.equal(listed.length, 2);
    assert.ok(listed.every(item => item.suspicious));
    const state = sessionState(session(events), brain);
    assert.equal(assetEvidence(state).screenshots, 0);
    assert.ok(state.screenshots.every(item => item.suspicious));
  }
});

test('missing, nonfinite, nonpositive and tiny attachment dimensions fail closed', () => {
  for (const dimensions of [{ width: 256, height: 256 }, { width: 0 }, { height: -1 },
    { width: undefined }, { height: NaN }, { width: Infinity }, { width: '1280' }]) {
    const ref = attachment(dimensions);
    assert.equal(isSuspicious(ref), true);
    assert.equal(capturesIn(session(capture(ref)))[0].suspicious, true);
    assert.equal(assetEvidence(sessionState(session(capture(ref)), brain)).screenshots, 0);
  }
  assert.equal(isSuspicious(attachment()), false);
  assert.equal(isSuspicious(attachment({ width: 256, height: 257 })), false, 'documented cutoff requires both dimensions');
});

test('arbitrary existing files and renamed screenshots never create capture provenance', t => {
  const root = temporary(t);
  const file = fileAt(root, 'reference.png');
  const renamed = path.join(root, 'screenshot-fresh-capture.png');
  renameSync(file, renamed);
  assert.equal(sessionState(session(read(renamed)), brain).screenshots.length, 0);
  assert.equal(statSync(renamed).mtimeMs, T0 + 1000, 'rename does not create a capture timestamp');
});

test('known capture bytes read from an actual file retain capture time, not view time', t => {
  const root = temporary(t);
  const file = fileAt(root);
  const state = sessionState(session([...capture(), ...read(file)]), brain);
  assert.equal(state.screenshots.length, 2);
  assert.deepEqual(state.screenshots[1], {
    tool: 'read_image', time: T0, viewedAt: T0 + 90_000, id: captureId(attachment().attachmentId), path: path.resolve(file), suspicious: false,
  });
});

test('capture provenance is replay-stable regardless of current source mtime', t => {
  const root = temporary(t);
  const file = fileAt(root, 'capture.png', T0 - 60_000);
  const state = sessionState(session([...capture(), ...read(file)]), brain);
  assert.equal(state.screenshots.at(-1).time, T0);
  utimesSync(file, (T0 + 200_000) / 1000, (T0 + 200_000) / 1000);
  assert.deepEqual(sessionState(session([...capture(), ...read(file)]), brain).screenshots, state.screenshots);
});

test('missing current files do not erase durable successful reads, mismatched attachments do not count', t => {
  const root = temporary(t);
  const file = fileAt(root);
  const dir = path.join(root, 'screenshots');
  mkdirSync(dir);
  for (const source of [path.join(root, 'deleted-capture.png'), file]) {
    const state = sessionState(session([...capture(), ...read(source)]), brain);
    assert.equal(state.screenshots.length, 2, 'successful logged image read is not re-run during replay');
  }
  const state = sessionState(session([...capture(), ...read(file, attachment({ attachmentId: 'sha256-random-1234567890' }))]), brain);
  assert.equal(state.screenshots.length, 1);
});

test('relative read_image files resolve only using the session cwd', t => {
  const root = temporary(t);
  fileAt(root);
  const events = [...capture(), ...read('screenshot.png')];
  assert.equal(sessionState(session(events, root), brain).screenshots.length, 2);
  assert.equal(sessionState(session(events), brain).screenshots.length, 1);
});

test('text-only captures establish provenance without claiming the model saw an image', t => {
  const root = temporary(t);
  const file = fileAt(root);
  const ref = attachment();
  const events = capture(ref, T0, [text(`${STORED_MARKER} ${JSON.stringify({ attachment: ref })}`)]);
  assert.equal(sessionState(session(events), brain).screenshots.length, 0);
  assert.equal(sessionState(session([...events, ...read(file)]), brain).screenshots.length, 1);
});

test('re-reading known fallback or tiny images cannot launder suspicious capture provenance', t => {
  const root = temporary(t);
  const file = fileAt(root);
  const fallback = [...capture(attachment(), T0, [image(), text({ studioFastPathUnavailable: true })]), ...read(file)];
  const tiny = attachment({ width: 16, height: 16 });
  const tinyEvents = [...capture(tiny), ...read(file, tiny)];
  for (const events of [fallback, tinyEvents]) {
    const state = sessionState(session(events), brain);
    assert.equal(state.screenshots.length, 2);
    assert.equal(assetEvidence(state).screenshots, 0);
    assert.ok(state.screenshots.every(item => item.suspicious));
  }
});

test('shared listings allow standalone captured-file reads, not visual credit for listing', t => {
  const root = temporary(t);
  const file = fileAt(root);
  const ref = attachment();
  const description = { id: captureId(ref.attachmentId), attachmentId: ref.attachmentId, capturedAt: new Date(T0).toISOString(),
    path: file, width: ref.width, height: ref.height, suspicious: false };
  const listed = result('roblox_screenshots', { action: 'list' }, [text({ captures: [description] })], T0 + 30_000);
  assert.equal(sessionState(session(listed), brain).screenshots.length, 0);
  const state = sessionState(session([...listed, ...read(file)]), brain);
  assert.equal(state.screenshots.length, 1);
  assert.equal(state.screenshots[0].time, T0);
  assert.equal(state.screenshots[0].id, description.id);
});

test('shared views count only matching image attachments and preserve capture freshness', () => {
  const ref = attachment();
  const description = { id: captureId(ref.attachmentId), attachmentId: ref.attachmentId, capturedAt: new Date(T0).toISOString(), suspicious: false };
  for (const [blocks, count] of [[[image()], 1], [[], 0], [[image(attachment({ attachmentId: 'different' }))], 0]]) {
    const events = result('roblox_screenshots', { action: 'view', ids: [description.id] }, [text({ captures: [description] }), ...blocks], T0 + 90_000);
    const state = sessionState(session(events), brain);
    assert.equal(state.screenshots.length, count);
    if (count) assert.equal(state.screenshots[0].time, T0);
  }
});

test('audit records retain per-image ids, timestamps and suspicion; returned arrays are detached', () => {
  const events = [...capture(), ...capture(attachment({ attachmentId: 'tiny-abcdefghij', width: 1, height: 1 }), T0 + 1000)];
  const worker = session(events);
  const audit = auditSession(worker, brain);
  assert.equal(audit.assets.screenshots, 1);
  assert.deepEqual(audit.assets.screenshotEvidence.map(item => [item.id, item.time, item.suspicious]), [
    [captureId(attachment().attachmentId), T0, false], [captureId('tiny-abcdefghij'), T0 + 1000, true],
  ]);
  audit.assets.screenshotEvidence[0].time = 0;
  assert.equal(auditSession(worker, brain).assets.screenshotEvidence[0].time, T0);
});

test('audit tool declares screenshot evidence and supplies an empty fail-closed default', async () => {
  let tool;
  const ctx = { tools: { register: definition => { tool = definition; } } };
  registerAuditTool(ctx, brain, { seed: async () => [{ id: 'unreadable', error: 'missing log' }] });
  const assets = tool.output.schema.properties.workers.items.properties.assets;
  assert.ok(assets.required.includes('screenshotEvidence'));
  assert.equal(assets.properties.screenshotEvidence.items.properties.time.type, 'number');
  const output = await tool.execute({}, { agent: { id: 'lead' } });
  assert.deepEqual(output.workers[0].assets.screenshotEvidence, []);
});

test('selective export preserves original capture time and exposes attachment provenance', async t => {
  const root = temporary(t);
  const source = fileAt(root, 'attachment.png', T0 + 90_000);
  const lead = { id: 'lead', session: session(capture()) };
  let tool;
  const ctx = {
    tools: { register: definition => { tool = definition; } },
    get: key => ({ agents: { get: () => lead }, subagents: { listDescendants: async () => [] },
      attachments: { imageHostPath: () => source } })[key],
  };
  registerScreenshotTool(ctx, () => root);
  const listed = await tool.execute({ action: 'list' }, { agent: lead });
  assert.equal(listed.captures[0].attachmentId, attachment().attachmentId);
  const exported = await tool.execute({ action: 'export', ids: [listed.captures[0].id] }, { agent: lead });
  assert.equal(statSync(path.join(root, exported.exported[0])).mtimeMs, T0);
});
