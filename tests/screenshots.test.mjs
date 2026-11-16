import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureId, capturesIn, collectTree, registerScreenshotTool, captureRefs, storeTextOnlyCaptures, STORED_MARKER } from '../screenshots.js';
import { buildScreenshotRoutes, rootSessionOf } from '../screenshot-bridge.js';
import { loadBrain, sessionState } from '../skill-policy.js';
import { createVisualGuard } from '../routing.js';
import { replyCorrections } from '../visual-policy.js';

const brain = loadBrain();
const T0 = Date.parse('2026-11-15T12:00:00Z');
let seq = 0;
const ref = (id, extra = {}) => ({ attachmentId: id, mediaType: 'image/png', bytes: 4, width: 800, height: 600, ...extra });
const capture = (attachmentId, { time = T0, tool = 'mcp__robloxstudio__capture_screenshot', label } = {}) => {
  const callId = `c${seq += 1}`;
  const text = label ? `capture_device_matrix 1/1 ${label}: ok` : '{"width":800}';
  return [
    { type: 'tool/call', time, data: { turn: 1, name: tool, callId, arguments: '{}' } },
    { type: 'tool/result', time, data: { turn: 1, message: { toolCallId: callId, content: [{ type: 'text', text }, { type: 'image', attachment: ref(attachmentId) }] } } },
  ];
};
const session = (id, events, header = {}) => ({ id, header, events });

/** A worker tree: lead with an implementer (live) and a settled QA worker (durable log only). */
function tree({ dir = mkdtempSync(path.join(tmpdir(), 'att-')) } = {}) {
  const lead = session('lead', [], {});
  const impl = session('impl', [...capture('sha256-aaaaaaaaaaaaaaaa1111111111', { time: T0 + 1000 })], { origin: 'subagent', parentSession: 'lead' });
  const qa = session('qa', [...capture('sha256-bbbbbbbbbbbbbbbb2222222222', { time: T0 + 2000, tool: 'mcp__robloxstudio__capture_device_matrix', label: 'phone' })],
    { origin: 'subagent', parentSession: 'lead' });
  const agents = { lead: { id: 'lead', session: lead }, impl: { id: 'impl', session: impl } };
  for (const id of ['sha256-aaaaaaaaaaaaaaaa1111111111', 'sha256-bbbbbbbbbbbbbbbb2222222222']) writeFileSync(path.join(dir, id), 'png!');
  const ctx = {
    get: key => ({
      agents: { get: id => agents[id] },
      subagents: {
        rootOf: agent => (agent.id === 'lead' ? agent : agents.lead),
        namesOf: agent => ({ self: agent.id === 'lead' ? 'lead' : agent.id }),
        listDescendants: async () => [
          { kind: 'child', id: 'impl', parentId: 'lead', name: 'impl-ui' },
          { kind: 'child', id: 'qa', parentId: 'lead', name: 'qa-devices' },
        ],
      },
      sessionQuery: { inspectSession: async (id, read) => { if (id !== 'qa') throw new Error('not found'); return read(qa); } },
      attachments: { imageHostPath: attachment => path.join(dir, attachment.attachmentId) },
      llm: { resolveModelInfo: async (_p, model) => ({ inputModalities: model === 'blind' ? ['text'] : ['text', 'image'] }) },
    })[key],
  };
  return { ctx, lead, impl, qa, agents, dir };
}

test('capture ids are stable, short and recognisable in text', () => {
  const id = captureId('sha256-aaaaaaaaaaaaaaaa1111111111');
  assert.equal(id, captureId('sha256-aaaaaaaaaaaaaaaa1111111111'));
  assert.match(id, /^cap-[0-9a-z]{10}$/);
  assert.deepEqual(captureRefs(`Review ${id} and ${id}, then cap-zz.`), [id]);
});

test('captures are read from a session log with tool and device label', () => {
  const found = capturesIn(session('s', capture('sha256-x123456789abcdef', { label: 'tablet', tool: 'mcp__robloxstudio__capture_device_matrix' })), 'qa');
  assert.equal(found.length, 1);
  assert.deepEqual({ agent: found[0].agent, tool: found[0].tool, label: found[0].label }, { agent: 'qa', tool: 'capture_device_matrix', label: 'tablet' });
});

test('any agent in the tree sees every capture, live or settled, newest first', async () => {
  const { ctx, agents } = tree();
  for (const caller of [agents.lead, agents.impl]) {
    const { captures } = await collectTree(ctx, caller);
    assert.deepEqual(captures.map(c => c.agent), ['qa-devices', 'impl-ui']);
  }
});

test('roblox_screenshots list, view and selective export', async () => {
  const { ctx, agents } = tree();
  const root = mkdtempSync(path.join(tmpdir(), 'proj-'));
  assert.equal(registerScreenshotTool(ctx, () => root), undefined, 'no tool registry, no tool');
  let registered;
  ctx.tools = { register: definition => { registered = definition; return () => {}; } };
  registerScreenshotTool(ctx, () => root);
  const exec = agent => ({ agent: { ...agent, options: { provider: 'p', model: 'm' }, session: { ...agent.session, requestHeader: () => undefined } } });

  const listed = await registered.execute({ action: 'list' }, exec(agents.impl));
  assert.equal(listed.total, 2);
  assert.ok(listed.captures[0].path.endsWith('sha256-bbbbbbbbbbbbbbbb2222222222'));
  const [newest, older] = listed.captures.map(c => c.id);

  const viewed = await registered.execute({ action: 'view', ids: [older] }, exec(agents.lead));
  assert.equal(viewed.viewable, true);
  const blocks = registered.output.render({}, viewed);
  assert.deepEqual(blocks.filter(b => b.type === 'image').map(b => b.attachment.attachmentId), ['sha256-aaaaaaaaaaaaaaaa1111111111']);

  const blind = await registered.execute({ action: 'view', ids: [older] }, { agent: { ...exec(agents.lead).agent, options: { provider: 'p', model: 'blind' } } });
  assert.equal(blind.viewable, false);
  assert.equal(registered.output.render({}, blind).some(b => b.type === 'image'), false);

  assert.equal(existsSync(path.join(root, 'screenshots')), false, 'nothing is written unless exported');
  const exported = await registered.execute({ action: 'export', ids: [newest] }, exec(agents.lead));
  assert.deepEqual(exported.exported, [`screenshots/${newest}-phone.png`]);
  assert.equal(readFileSync(path.join(root, exported.exported[0]), 'utf8'), 'png!');
  await assert.rejects(registered.execute({ action: 'export', ids: [newest], dir: '../outside' }, exec(agents.lead)), /inside the project/);
  await assert.rejects(registered.execute({ action: 'view', ids: ['cap-nope000000'] }, exec(agents.lead)), /unknown capture id/);
});

test('viewing a shared capture counts as looking, dated by when it was captured', () => {
  const id = captureId('sha256-aaaaaaaaaaaaaaaa1111111111');
  const callId = 'v1';
  const summary = JSON.stringify({ captures: [{ id, attachmentId: 'sha256-aaaaaaaaaaaaaaaa1111111111', capturedAt: new Date(T0 + 1000).toISOString() }], viewable: true });
  const lead = session('lead', [
    { type: 'tool/call', time: T0 + 99_000, data: { turn: 1, name: 'roblox_screenshots', callId, arguments: JSON.stringify({ action: 'view', ids: [id] }) } },
    { type: 'tool/result', time: T0 + 99_000, data: { turn: 1, message: { toolCallId: callId, content: [{ type: 'text', text: summary }, { type: 'image', attachment: ref('sha256-aaaaaaaaaaaaaaaa1111111111') }] } } },
  ]);
  const state = sessionState(lead, brain);
  assert.deepEqual(state.screenshots.map(s => ({ time: s.time, id: s.id })), [{ time: T0 + 1000, id }]);
});

test('a visual review may be handed capture ids instead of file paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'v-'));
  mkdirSync(path.join(root, 'docs/x'), { recursive: true });
  writeFileSync(path.join(root, 'docs/x/VISUAL_GATE.md'), 'Verdict: FAIL');
  const ctx = { get: key => (key === 'workingDirectory' ? { get: () => root } : undefined) };
  const route = { provider: 'codex', model: 'gpt-6.1-terra', reasoning_effort: 'medium' };
  const { guard } = createVisualGuard({ ctx, brain, roleRoutes: () => [route] });
  const prompt = 'Role: visual/standard\nView cap-1a2b3c4d5e and cap-2b3c4d5e6f with roblox_screenshots.\nReturn Verdict: PASS|FAIL with a checklist in docs/x/VISUAL_GATE.md.';
  assert.equal(guard({ name: 'subagent', arguments: { prompt, ...route }, agent: { id: 'l', session: session('l', []) } }), undefined);
});

test('the lead is reminded once to show new worker screenshots, and may decline', async () => {
  assert.match(replyCorrections({ reply: 'impl-ui finished the menu.', newCaptures: ['cap-aaaa111111'] })[0], /Show the operator/);
  assert.deepEqual(replyCorrections({ reply: 'Menu done.\n![main menu](</p/x.png>)', newCaptures: ['cap-aaaa111111'] }), []);
  assert.deepEqual(replyCorrections({ reply: 'Only log output changed; no new screenshots worth showing.', newCaptures: ['cap-aaaa111111'] }), []);

  const root = mkdtempSync(path.join(tmpdir(), 'n-'));
  const ctx = { get: key => (key === 'workingDirectory' ? { get: () => root } : undefined) };
  let captures = [];
  const { turnStopping } = createVisualGuard({ ctx, brain, collect: async () => ({ captures }) });
  const steered = [];
  const reply = turn => [{ type: 'turn/start', data: { turn } }, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'Working.' }] } } }];
  const lead = session('lead', reply(1));
  const agent = { id: 'lead', session: lead, steer: message => steered.push(message) };
  await turnStopping({ agent, turn: 1 });
  assert.equal(steered.length, 0, 'first turn sets the baseline, no history replay');
  captures = [{ id: 'cap-new0000001', time: T0 + 5000 }];
  lead.events.push(...reply(2));
  await turnStopping({ agent, turn: 2 });
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /cap-new0000001/);
  await turnStopping({ agent, turn: 2 });
  assert.equal(steered.length, 1, 'once per turn');
  lead.events.push(...reply(3));
  await turnStopping({ agent, turn: 3 });
  assert.equal(steered.length, 1, 'already-offered captures are not offered again');
  const off = createVisualGuard({ ctx, brain, previews: 'off', collect: async () => ({ captures }) });
  await off.turnStopping({ agent: { ...agent, steer: message => steered.push(message) }, turn: 9 });
  assert.equal(steered.length, 1, 'screenshotPreviews off');
});

test('a gate reviewer that never viewed a screenshot cannot pass the gate', async () => {
  const { completionDenial } = await import('../visual-policy.js');
  const root = mkdtempSync(path.join(tmpdir(), 'g-'));
  mkdirSync(path.join(root, 'docs/x'), { recursive: true });
  const gate = path.join(root, 'docs/x/VISUAL_GATE.md');
  writeFileSync(gate, 'Verdict: PASS\nReviewer: reviewer (visual/standard)\n\nScreenshots:\n- cap-1a2b3c4d5e\n- cap-2b3c4d5e6f\n- cap-3c4d5e6f7a\n\n'
    + '- [x] a\n- [x] b\n- [x] c\n- [x] d\n- [x] e\n## Asset sourcing\nNot applicable: UI-only layout changes with no art added or replaced.\n');
  utimesSync(gate, (T0 + 60_000) / 1000, (T0 + 60_000) / 1000);
  const prompt = 'Role: visual/standard\nView cap-1a2b3c4d5e.\nVerdict: PASS|FAIL with a checklist in docs/x/VISUAL_GATE.md.';
  const lead = {
    screenshots: [{ time: T0 + 100_000 }],
    dispatchLog: [{ name: 'reviewer', role: 'visual', tier: 'standard', time: T0 + 1000, prompt }],
    assets: { searches: [], thumbnails: new Set(), details: new Set(), changes: [] },
  };
  const blindRow = [{ name: 'reviewer', audit: { assets: { searches: [], thumbnails: [], details: [], changes: [], screenshots: 0 } } }];
  const denial = completionDenial({ root, objective: 'polish the UI', lead, workers: blindRow, runScript: () => undefined });
  assert.match(denial.reason, /reviewer "reviewer" has no readable evidence/);
  const screenshotEvidence = ['cap-1a2b3c4d5e', 'cap-2b3c4d5e6f', 'cap-3c4d5e6f7a'].map(id => ({ id, time: T0 + 2000, viewedAt: T0 + 3000, suspicious: false }));
  const sighted = [{ name: 'reviewer', audit: { assets: { ...blindRow[0].audit.assets, screenshots: 3, screenshotEvidence } } }];
  assert.equal(completionDenial({ root, objective: 'polish the UI', lead, workers: sighted, runScript: () => undefined }), undefined);
});

test('a capture by a text-only model is stored and shared, without an image in its context', async () => {
  const saved = [];
  const ctx = { get: key => (key === 'attachments'
    ? { saveImages: async inputs => inputs.map((input, index) => { saved.push(input); return ref(`sha256-stored${index}abcdefghij`, { width: 1280, height: 720 }); }) }
    : undefined) };
  const hook = storeTextOnlyCaptures(ctx);
  const exec = { name: 'mcp__robloxstudio__capture_screenshot' };
  const result = {
    isError: false,
    value: { content: [{ type: 'text', text: '{"width":1280}' }, { type: 'image', data: Buffer.from('png!').toString('base64'), mimeType: 'image/png' }] },
    content: [{ type: 'text', text: '[image unavailable: image/png; model "deepseek-flash" does not declare image input]' }],
  };
  const decision = await hook(exec, result, async () => ({ kind: 'accept' }));
  assert.equal(saved.length, 1);
  assert.equal(decision.content.some(block => block.type === 'image'), false, 'the model still reads text only');
  const text = decision.content[0].text;
  assert.match(text, /cannot view images; the capture is stored and shared/);
  const logged = session('w', [
    { type: 'tool/call', time: T0, data: { name: exec.name, callId: 'x', arguments: '{}' } },
    { type: 'tool/result', time: T0, data: { message: { toolCallId: 'x', content: decision.content } } },
  ]);
  const [found] = capturesIn(logged, 'qa');
  assert.equal(found.id, captureId('sha256-stored0abcdefghij'));
  assert.equal(found.stored, true);
  assert.equal(found.suspicious, false);
  assert.ok(text.includes(STORED_MARKER));
  const seeing = await hook(exec, { ...result, content: [{ type: 'image', attachment: ref('a') }] }, async () => ({ kind: 'accept' }));
  assert.deepEqual(seeing, { kind: 'accept' }, 'image-capable models are left to DSH');
});

test('tiny and fallback captures are flagged suspicious in listings', () => {
  const tiny = capturesIn(session('s', capture('sha256-tinytinytiny123', { tool: 'mcp__robloxstudio__capture_screenshot' })
    .map(event => (event.type === 'tool/result'
      ? { ...event, data: { message: { ...event.data.message, content: [{ type: 'image', attachment: ref('sha256-tinytinytiny123', { width: 256, height: 256 }) }] } } }
      : event))), 'qa');
  assert.equal(tiny[0].suspicious, true);
  assert.equal(tiny[0].server, 'robloxstudio');
});

test('the sidebar bridge lists a worker Session\'s whole tree and serves only its images', async () => {
  const { ctx, impl } = tree();
  assert.equal(await rootSessionOf(ctx, 'impl'), 'lead');
  assert.equal(await rootSessionOf(ctx, 'qa'), 'lead', 'settled worker resolved through its durable header');
  const routes = Object.fromEntries(buildScreenshotRoutes(ctx).map(route => [route.path.split('/').pop(), route.handler]));
  const response = () => {
    const res = { status: 0, headers: {}, body: [], headersSent: false };
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
    res.end = chunk => { if (chunk) res.body.push(Buffer.from(chunk)); res.done = true; };
    res.write = chunk => { res.body.push(Buffer.from(chunk)); return true; };
    res.on = () => res; res.once = () => res; res.emit = () => false; res.removeListener = () => res;
    res.destroy = () => {};
    return res;
  };
  const request = (method, url, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    return { method, url, headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' }, async *[Symbol.asyncIterator]() { yield* chunks; } };
  };
  const listRes = response();
  await routes.list(request('POST', '/api/roblox-screenshots/list', { sessionId: impl.id }), listRes);
  const listed = JSON.parse(Buffer.concat(listRes.body).toString());
  assert.equal(listed.captures.length, 2);
  assert.equal(listed.captures[0].path, undefined, 'host paths are not sent to the browser');
  const cross = response();
  await routes.list({ ...request('POST', '/x', { sessionId: 'lead' }), headers: { host: 'evil.example', origin: 'http://evil.example' } }, cross);
  assert.equal(cross.status, 403);
  const missing = response();
  await routes.image(request('GET', `/api/roblox-screenshots/image?session=lead&id=cap-zzzzzzzzzz`), missing);
  assert.equal(missing.status, 404);
});
