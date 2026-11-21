import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBrain, sessionState } from '../skill-policy.js';
import { createVisualGuard, registerVisualGateTool } from '../routing.js';
import { checkVisualGate, parseGate } from '../tools/check-visual-gate.mjs';
import { replyCorrections, gateStatusLine } from '../visual-policy.js';
import { statusContext } from '../coordination.js';

const brain = loadBrain();
const repo = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(repo, 'tools/check-visual-gate.mjs');
const T0 = Date.parse('2026-11-15T12:00:00Z');

let seq = 0;
const callAndResult = (name, args, content, { time = T0, ok = true, turn = 1 } = {}) => {
  const callId = `c${seq += 1}`;
  return [
    { type: 'tool/call', time, data: { turn, name, callId, arguments: JSON.stringify(args) } },
    { type: 'tool/result', time, data: { turn, message: { toolCallId: callId, isError: !ok, content } } },
  ];
};
const image = [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 1280, height: 720 } }];
const tinyImage = [{ type: 'image', attachment: { attachmentId: 'b', mediaType: 'image/png', bytes: 1, width: 256, height: 256 } }];
const shot = (time, tool = 'mcp__robloxstudio__capture_screenshot') => callAndResult(tool, {}, [{ type: 'text', text: '{}' },
  { type: 'image', attachment: { ...image[0].attachment, attachmentId: `shot-${time}` } }], { time });
const dispatch = (name, prompt, route, { time = T0 + 10_000, turn = 1 } = {}) => callAndResult('subagent', { prompt, ...route }, [{ type: 'text', text: `started subagent ${name}` }], { time, turn });

const VISUAL_ROUTE = { provider: 'codex', model: 'gpt-6.1-terra', reasoning_effort: 'medium' };
const IMPL_ROUTE = { provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' };
const routesFor = (role, tier) => ({ 'visual/standard': [VISUAL_ROUTE], 'implementer/standard': [IMPL_ROUTE] })[`${role}/${tier}`];
const reviewPrompt = 'Role: visual/standard\nReview screenshots/menu.png and screenshots/hud.png.\nReturn Verdict: PASS|FAIL with a checklist and record it in docs/launch/VISUAL_GATE.md.';

const PASS_GATE = `# Visual gate
Verdict: PASS
Reviewer: reviewer (visual/standard)
Client source: src/client

Screenshots:
- screenshots/menu.png
- screenshots/hud.png
- screenshots/scene.png

## Checklist
- [x] readable on phone
- [x] hierarchy
- [x] palette
- [x] no placeholder primitives
- [x] nothing clipped

## Asset sourcing
Not applicable: UI-only layout and typography changes; no art pieces added or replaced.
`;

function project(gate = PASS_GATE, { gateTime = T0 + 60_000, clientTime = T0 } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'visual-'));
  mkdirSync(path.join(root, 'src/client'), { recursive: true });
  mkdirSync(path.join(root, 'docs/launch'), { recursive: true });
  writeFileSync(path.join(root, 'src/client/Menu.luau'), 'return {}');
  utimesSync(path.join(root, 'src/client/Menu.luau'), clientTime / 1000, clientTime / 1000);
  if (gate !== null) {
    writeFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), gate);
    utimesSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), gateTime / 1000, gateTime / 1000);
  }
  return root;
}

const reviewedRow = { name: 'reviewer', audit: { assets: { searches: [], thumbnails: [], details: [], changes: [], screenshots: 1,
  screenshotEvidence: ['menu', 'hud', 'scene'].map(name => ({ time: T0 + 50_000, viewedAt: T0 + 50_000,
    suspicious: false, path: `screenshots/${name}.png` })) } } };
function harness(root, { objective = 'Polish the main menu UI and scene art', rows = [reviewedRow], mode } = {}) {
  const ctx = { get: key => ({
    workingDirectory: { get: () => root },
    goals: { get: () => ({ objective }) },
  })[key] };
  const evidence = { rows: () => rows };
  return createVisualGuard({ ctx, brain, evidence, roleRoutes: routesFor, mode, collect: async () => ({ captures: [] }) });
}
const lead = events => ({ id: 'lead', header: {}, events });
const worker = (events, prompt = reviewPrompt) => ({ id: 'w', header: { origin: 'subagent', parentSession: 'lead' },
  events: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } }, ...events] });
const call = (session, name, args = {}) => ({ name, arguments: args, agent: { id: session.id, session } });
const complete = session => call(session, 'update_goal', { action: 'complete' });

/* Opt-in ---------------------------------------------------------------------------------- */

test('projects without a VISUAL_GATE.md marker are untouched', () => {
  const root = project(null);
  const { guard } = harness(root);
  assert.equal(guard(complete(lead([]))), undefined);
  assert.equal(guard(call(lead([]), 'subagent', { prompt: 'Make the menu.' })), undefined);
  assert.equal(harness(project(), { mode: 'off' }).guard(complete(lead([]))), undefined, 'config flag off');
  assert.equal(harness(root, { mode: 'on' }).guard(complete(lead([])))?.info.code, 'VISUAL_GATE_FAILED', 'config flag on');
});

/* Screenshot-before-accept ---------------------------------------------------------------- */

test('completion is refused when the coordinator never looked at a screenshot', () => {
  const { guard } = harness(project());
  const session = lead([...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)]);
  const denial = guard(complete(session));
  assert.equal(denial.info.code, 'VISUAL_GATE_FAILED');
  assert.match(denial.reason, /have not viewed a screenshot yourself/);
});

test('trusting operator text does not count: only capture tools or read_image on a capture', () => {
  const { guard } = harness(project());
  const text = [{ type: 'text', text: 'Screens look good.' }];
  const session = lead([
    ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE),
    ...callAndResult('send_message', { agent: 'operator', message: 'how does it look?' }, text, { time: T0 + 120_000 }),
    ...callAndResult('read_image', { file_path: '/tmp/reference/mood-board.png' }, image, { time: T0 + 120_000 }),
  ]);
  assert.match(guard(complete(session)).reason, /have not viewed a screenshot yourself/);
  const read = lead([...session.events, ...callAndResult('read_image', { file_path: 'screenshots/menu.png' }, image, { time: T0 + 120_000 })]);
  assert.match(guard(complete(read)).reason, /have not viewed a screenshot yourself/, 'a capture-looking filename without provenance does not count');
});

test('a screenshot older than the last client change does not count', () => {
  const root = project(PASS_GATE, { clientTime: T0 + 30_000, gateTime: T0 + 60_000 });
  const { guard } = harness(root);
  const session = lead([...shot(T0), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE, { time: T0 + 40_000 })]);
  assert.match(guard(complete(session)).reason, /last usable screenshot predates src\/client\/Menu\.luau/);
  const fresh = lead([...session.events, ...shot(T0 + 90_000)]);
  assert.equal(guard(complete(fresh)), undefined);
});

test('an asset insertion after the last screenshot also requires a new look', () => {
  const { guard } = harness(project());
  const session = lead([...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE),
    ...callAndResult('mcp__robloxstudio__insert_asset', { assetId: 123456 }, [{ type: 'text', text: 'ok' }], { time: T0 + 200_000 })]);
  assert.match(guard(complete(session)).reason, /predates an asset insertion/);
});

test('non-visual objectives are not held to the visual gate', () => {
  const { guard } = harness(project(), { objective: 'Fix DataStore retry backoff' });
  assert.equal(guard(complete(lead([]))), undefined);
});

/* Gate script ------------------------------------------------------------------------------ */

test('a completed-goal attempt is refused when the gate check fails, with its rule id', () => {
  const { guard } = harness(project(PASS_GATE.replace('Verdict: PASS', 'Verdict: FAIL')));
  const session = lead([...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)]);
  const denial = guard(complete(session));
  assert.equal(denial.info.code, 'VISUAL_GATE_FAILED');
  assert.match(denial.reason, /\[VERDICT\] docs\/launch\/VISUAL_GATE\.md: verdict is FAIL/);
  assert.match(denial.reason, /Report "visual gate FAILED"/);
});

test('one rule source: a different project copy of the script is never run', () => {
  const root = project();
  mkdirSync(path.join(root, 'tools'));
  writeFileSync(path.join(root, 'tools/check-visual-gate.mjs'), 'console.log("old rules"); process.exit(1);');
  const { guard } = harness(root);
  assert.equal(guard(complete(lead([...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)]))), undefined,
    'the bundled rules decide; an outdated project script cannot disagree');
});

test('roblox_visual_gate reports the same problems as completion, with the failing rules and watched paths', () => {
  const root = project(PASS_GATE.replace('Verdict: PASS', 'Verdict: FAIL'));
  const ctx = { get: key => (key === 'workingDirectory' ? { get: () => root } : undefined) };
  const visual = createVisualGuard({ ctx, brain, evidence: { rows: () => [] }, collect: async () => ({ captures: [] }) });
  let tool;
  ctx.tools = { register: definition => { tool = definition; return () => {}; } };
  registerVisualGateTool(ctx, visual);
  const value = tool.execute({}, { agent: { id: 'lead', session: lead([]) } });
  assert.equal(value.ok, false);
  assert.deepEqual([...new Set(value.problems.map(item => item.rule))].sort(), ['LEAD_LOOKED', 'REVIEWER_DISPATCHED', 'REVIEW_AFTER_WORK', 'VERDICT']);
  assert.ok(value.rules.LEAD_LOOKED && value.rules.VERDICT, 'each failing rule is explained');
  assert.deepEqual(Object.keys(value.rules).sort(), [...new Set(value.problems.map(item => item.rule))].sort(), 'passing rules are left out');
  assert.deepEqual(value.watch[0].watched, ['src/client']);
  assert.ok(value.watch[0].ignored.includes('assets/backup/**'));
  const off = createVisualGuard({ ctx: { get: () => ({ get: () => project(null) }) }, brain });
  assert.equal(off.report(lead([])), undefined);
});

test('a backup export or an ignored path does not make the gate stale', () => {
  const root = project();
  mkdirSync(path.join(root, 'assets/backup'), { recursive: true });
  writeFileSync(path.join(root, 'assets/backup/HolidayArt.rbxm'), 'x');
  writeFileSync(path.join(root, 'assets/Holiday.backup.rbxm'), 'x');
  const gate = { scope: 'launch', gate: { clientSource: ['src/client', 'assets'] } };
  const later = (T0 + 120_000) / 1000;
  utimesSync(path.join(root, 'assets/backup/HolidayArt.rbxm'), later, later);
  utimesSync(path.join(root, 'assets/Holiday.backup.rbxm'), later, later);
  const withAssets = PASS_GATE.replace('Client source: src/client', 'Client source: src/client, assets');
  writeFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), withAssets);
  utimesSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), (T0 + 60_000) / 1000, (T0 + 60_000) / 1000);
  assert.equal(checkVisualGate(root).ok, true, 'default ignores cover backup exports');
  writeFileSync(path.join(root, 'assets/Sky.rbxm'), 'x');
  utimesSync(path.join(root, 'assets/Sky.rbxm'), later, later);
  assert.match(checkVisualGate(root).gates[0].problems[0].text, /^assets\/Sky\.rbxm changed .* after the gate file/);
  writeFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), `${withAssets}Ignore: assets/Sky.rbxm\n`);
  utimesSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), (T0 + 60_000) / 1000, (T0 + 60_000) / 1000);
  assert.equal(checkVisualGate(root).ok, false, 'an explicit Ignore: line replaces the defaults, so the backup counts again');
  assert.equal(gate.scope, 'launch');
});

test('the gate script prints its rule table', () => {
  const out = spawnSync(process.execPath, [SCRIPT, '--rules'], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^CHECKLIST\s+a checklist of at least 5/m);
  assert.match(out.stdout, /Ignored by default .*assets\/backup\/\*\*/);
});

test('check-visual-gate.mjs exits 1 on each missing requirement and 0 on a complete gate', () => {
  const run = root => spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  assert.equal(run(project()).status, 0);
  const cases = [
    [PASS_GATE.replace('Verdict: PASS', 'Verdict: FAIL'), /verdict is FAIL/],
    [PASS_GATE.replace('Reviewer: reviewer (visual/standard)', ''), /no "Reviewer:/],
    [PASS_GATE.replace('(visual/standard)', '(implementer/standard)'), /not a visual\/standard or visual\/expert/],
    [PASS_GATE.replace('- screenshots/scene.png\n', ''), /2 screenshot\(s\); at least 3/],
    [PASS_GATE.replace('- [x] nothing clipped', '- [ ] nothing clipped'), /unchecked checklist/],
  ];
  for (const [gate, pattern] of cases) {
    const out = run(project(gate));
    assert.equal(out.status, 1, String(pattern));
    assert.match(out.stdout, pattern);
    assert.match(out.stdout, /visual gate FAILED/);
  }
  const stale = run(project(PASS_GATE, { gateTime: T0, clientTime: T0 + 60_000 }));
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /\[STALE\] src\/client\/Menu\.luau changed .* after the gate file/);
  assert.equal(run(project(null)).status, 1, 'no gate file at all');
});

test('the shipped template parses and is not itself a passing gate', () => {
  const template = readFileSync(path.join(repo, 'templates/VISUAL_GATE.md'), 'utf8');
  const gate = parseGate(template);
  assert.equal(gate.verdict, 'FAIL');
  assert.equal(gate.screenshots.length, 3);
  assert.ok(gate.checklist.length >= 5);
  assert.equal(gate.pieces.length, 1);
});

/* Visual reviewer requirement -------------------------------------------------------------- */

test('visual work cannot be accepted without a visual review dispatched after it', () => {
  const { guard } = harness(project());
  const impl = 'Role: implementer/standard\nBuild the main menu GUI in src/client.';
  const session = lead([...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE), ...dispatch('impl', impl, IMPL_ROUTE), ...shot(T0 + 100_000)]);
  assert.match(guard(complete(session)).reason, /no visual\/standard or visual\/expert review with capture ids was dispatched after the last visual work/);
  const reviewed = lead([...session.events, ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE, { time: T0 + 20_000 })]);
  assert.equal(guard(complete(reviewed)), undefined);
});

test('the gate reviewer must be a visual worker this coordinator dispatched', () => {
  const { guard } = harness(project(PASS_GATE.replace('Reviewer: reviewer', 'Reviewer: someone-else')));
  const denial = guard(complete(lead([...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)])));
  assert.match(denial.reason, /names reviewer "someone-else", which is not a visual worker you dispatched/);
});

test('a visual reviewer dispatch without a screenshot or image path is rejected', () => {
  const { guard } = harness(project());
  const prompt = 'Role: visual/standard\nReview the main menu. Return Verdict: PASS|FAIL with a checklist in docs/launch/VISUAL_GATE.md.';
  const denial = guard(call(lead([]), 'subagent', { prompt, ...VISUAL_ROUTE }));
  assert.equal(denial.info.code, 'VISUAL_ASSIGNMENT_INCOMPLETE');
  assert.match(denial.reason, /needs at least one screenshot to judge: pass capture ids/);
  assert.equal(guard(call(lead([]), 'subagent', { prompt: reviewPrompt, ...VISUAL_ROUTE })), undefined);
});

test('a visual reviewer dispatch must demand Verdict: PASS|FAIL and name the gate file', () => {
  const { guard } = harness(project());
  const denial = guard(call(lead([]), 'subagent', { prompt: 'Role: visual/standard\nReview screenshots/a.png and tell me how it looks.', ...VISUAL_ROUTE }));
  assert.match(denial.reason, /"Verdict: PASS\|FAIL" with a checklist/);
  assert.match(denial.reason, /VISUAL_GATE\.md the reviewer records/);
});

test('every dispatch must state its role, and the route must belong to that role', () => {
  const { guard } = harness(project());
  assert.match(guard(call(lead([]), 'subagent', { prompt: 'Build the HUD.', ...IMPL_ROUTE })).reason, /"Role: <role>\/<tier>"/);
  const mislabelled = guard(call(lead([]), 'subagent', { prompt: reviewPrompt, ...IMPL_ROUTE }));
  assert.match(mislabelled.reason, /claude\/claude-sonnet-5-5 at high is not a visual\/standard route/);
});

test('only the visual reviewer worker may write VISUAL_GATE.md', () => {
  const { guard } = harness(project());
  const gatePath = 'docs/launch/VISUAL_GATE.md';
  assert.equal(guard(call(lead([]), 'write', { file_path: gatePath })).info.code, 'VISUAL_GATE_FILE_OWNED');
  assert.equal(guard(call(worker([], 'Role: implementer/standard\nBuild UI.'), 'edit', { file_path: gatePath })).info.code, 'VISUAL_GATE_FILE_OWNED');
  assert.equal(guard(call(worker([]), 'write', { file_path: gatePath })), undefined);
  assert.equal(guard(call(lead([]), 'write', { file_path: 'src/client/Menu.luau' })), undefined);
});

/* Asset sourcing --------------------------------------------------------------------------- */

const assetGate = piece => `${PASS_GATE.replace(/Not applicable:.*\n/, '')}\n${piece}\n`;
const QUERIES = 'Queries: "pine tree"; "stylized tree"; "low poly tree"; "forest pack"; "cartoon tree"; "tree model"';
const searched = ['pine tree', 'stylized tree', 'low poly tree', 'forest pack', 'cartoon tree', 'tree model']
  .flatMap(query => callAndResult('mcp__robloxstudio__search_assets', { assetType: 'Model', query }, [{ type: 'text', text: '[]' }]));
const looked = id => [
  ...callAndResult('mcp__robloxstudio__get_asset_thumbnail', { assetId: id }, image),
  ...callAndResult('mcp__robloxstudio__get_asset_details', { assetId: id }, [{ type: 'text', text: '{}' }]),
];

test('primitive final art needs 6 queries, viewed candidates and real rejection reasons', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'asset-'));
  mkdirSync(path.join(root, 'src/client'), { recursive: true });
  const write = text => {
    mkdirSync(path.join(root, 'docs/x'), { recursive: true });
    writeFileSync(path.join(root, 'docs/x/VISUAL_GATE.md'), text);
    return checkVisualGate(root).gates[0].problems.map(item => item.text).join('\n');
  };
  const thin = write(assetGate('### Piece: tree\nFinal: primitive\nQueries: "tree"; "pine"'));
  assert.match(thin, /at least 6 distinct search_assets queries \(found 2\)/);
  assert.match(thin, /needs the shortlisted candidates/);
  const lazy = write(assetGate(`### Piece: tree\nFinal: primitive\n${QUERIES}\nCandidates:\n- 1111111 | creator: bob | price: free | thumbnail: no | details: yes | status: rejected | reason: has scripts`));
  assert.match(lazy, /thumbnail not viewed/);
  assert.match(lazy, /rejection reason "has scripts" is missing or only a fixable issue/);
  assert.match(lazy, /rejected without being seen in the scene/);
  assert.match(write(assetGate('### Piece: tree\nFinal: primitive\n' + QUERIES + '\nCandidates:\n- 1111111 | thumbnail: yes | details: yes | in-scene: yes | status: rejected | reason: high triangles')),
    /only a fixable issue/);
  const kept = write(assetGate(`### Piece: tree\nFinal: 2222222\n${QUERIES}\nCandidates:\n- 2222222 | creator: alice | thumbnail: yes | details: yes | in-scene: yes | status: kept`));
  assert.match(kept, /kept asset must record its price/);
  assert.match(kept, /dated authorizing decision/);
  const good = write(assetGate(`### Piece: tree\nFinal: 2222222\n${QUERIES}\nCandidates:\n- 2222222 | creator: alice | price: free | thumbnail: yes | details: yes | in-scene: yes | status: kept | authorized: 2026-11-15\n- 1111111 | creator: bob | price: free | thumbnail: yes | details: yes | in-scene: yes | status: rejected | reason: realistic bark clashes with flat palette in scene.png`));
  assert.equal(good, '');
});

test('claimed asset evidence must match the asset tool calls in the session logs', () => {
  const piece = `### Piece: tree\nFinal: 2222222\n${QUERIES}\nCandidates:\n- 2222222 | creator: alice | price: free | thumbnail: yes | details: yes | in-scene: yes | status: kept | authorized: 2026-11-15`;
  const root = project(assetGate(piece));
  const base = [...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)];
  const denial = harness(root).guard(complete(lead(base)));
  assert.match(denial.reason, /queries never run with search_assets/);
  assert.match(denial.reason, /candidate 2222222: no get_asset_thumbnail call in any log/);
  const rows = [{ name: 'artist', audit: { assets: { searches: searched.filter(e => e.type === 'tool/call').map(e => JSON.parse(e.data.arguments).query), thumbnails: ['2222222'], details: ['2222222'], changes: [], screenshots: 0 } } }];
  assert.equal(harness(root, { rows: [...rows, reviewedRow] }).guard(complete(lead(base))), undefined, 'worker logs carry the evidence');
  assert.equal(harness(root).guard(complete(lead([...searched, ...looked(2222222), ...base]))), undefined, 'or the lead\'s own log');
});

test('a successful Assets API read counts as the details lookup for own private uploads', () => {
  const own = '94578467400759';
  const assetsApi = (endpoint, text, { method = 'GET', ok = true } = {}) => callAndResult('mcp__Roblox_Studio__open_cloud_invoke',
    { method, endpoint, scopes: ['asset:read'] }, [{ type: 'text', text }], { ok });
  const body = id => `{"path":"assets/${id}","assetId":"${id}","assetType":"Model","creationContext":{"creator":{"groupId":"421538685"}},"moderationResult":{"moderationState":"Approved"}}`;
  const detailsOf = events => sessionState(lead(events), loadBrain()).assets.details;
  const good = assetsApi(`/assets/v1/assets/${own}`, `GET https://apis.roblox.com/assets/v1/assets/${own} -> 200 OK\n\n${body(own)}`);
  assert.deepEqual([...detailsOf(good)], [own]);
  // The Creator Store 404 does not count; neither do failures, other ids, other endpoints or writes.
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}`, `GET https://apis.roblox.com/assets/v1/assets/${own} -> 404 Not Found\n\n{}`)).size, 0);
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}`, `GET x -> 200 OK\n\n${body(own)}`, { ok: false })).size, 0);
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}`, `GET x -> 200 OK\n\n${body('1111111')}`)).size, 0);
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}/versions`, `GET x -> 200 OK\n\n${body(own)}`)).size, 0);
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}`, `PATCH x -> 200 OK\n\n${body(own)}`, { method: 'PATCH' })).size, 0);
  assert.equal(detailsOf(assetsApi(`/assets/v1/assets/${own}`, 'GET x -> 200 OK\n\nnot json')).size, 0);

  const piece = `### Piece: noodles\nFinal: ${own}\nCandidates:\n- Candidate: ${own} | thumbnail: yes | details: yes | status: kept | creator: own | price: n/a (own upload)`;
  const root = project(assetGate(piece));
  const base = [...shot(T0 + 100_000), ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)];
  const thumb = callAndResult('mcp__robloxstudio__get_asset_thumbnail', { assetId: own }, image);
  const notFound = callAndResult('mcp__robloxstudio__get_asset_details', { assetId: own }, [{ type: 'text', text: 'Open Cloud 404' }], { ok: false });
  assert.match(harness(root).guard(complete(lead([...thumb, ...notFound, ...base]))).reason, /no get_asset_details call or successful Assets API read/);
  assert.equal(harness(root).guard(complete(lead([...thumb, ...notFound, ...good, ...base]))), undefined);
});

test('asset work assignments must carry the sourcing rule', () => {
  const { guard } = harness(project());
  const bare = 'Role: implementer/standard\nFind trees on the Creator Store and insert_asset them.';
  assert.match(guard(call(lead([]), 'subagent', { prompt: bare, ...IMPL_ROUTE })).reason, /asset work must carry the sourcing rule/);
  const ruled = `${bare}\nScripts, triangle counts and pivots are fixable; reject only after seeing it in the scene.`;
  assert.equal(guard(call(lead([]), 'subagent', { prompt: ruled, ...IMPL_ROUTE })), undefined);
});

test('assets are never inserted during a playtest', () => {
  const { guard } = harness(project());
  const playing = worker(callAndResult('mcp__robloxstudio__solo_playtest', { action: 'start', mode: 'play' }, [{ type: 'text', text: 'ok' }]));
  const denial = guard(call(playing, 'mcp__robloxstudio__insert_asset', { assetId: 1 }));
  assert.equal(denial.info.code, 'VISUAL_INSERT_DURING_PLAYTEST');
  const stopped = worker([...playing.events.slice(1), ...callAndResult('mcp__robloxstudio__solo_playtest', { action: 'stop' }, [{ type: 'text', text: 'ok' }])]);
  assert.equal(guard(call(stopped, 'mcp__robloxstudio__insert_asset', { assetId: 1 })), undefined);
  const official = worker(callAndResult('mcp__Roblox_Studio__start_stop_play', { is_start: true }, [{ type: 'text', text: 'ok' }]));
  assert.equal(guard(call(official, 'mcp__Roblox_Studio__insert_asset', { assetId: 1 }))?.info.code, 'VISUAL_INSERT_DURING_PLAYTEST');
});

/* Report honesty and dispatch announcements ------------------------------------------------ */

test('a visual status report while the gate fails must open with "visual gate FAILED"', () => {
  const gate = { ok: false, problems: [{ rule: 'VERDICT', text: 'verdict is FAIL' }] };
  const [fix] = replyCorrections({ reply: 'Status: impl-ui finished the HUD pass.', gate, visualTurn: true });
  assert.match(fix, /Open the report with "visual gate FAILED"/);
  assert.match(fix, /\[VERDICT\] verdict is FAIL/);
  assert.deepEqual(replyCorrections({ reply: 'visual gate FAILED: verdict is FAIL.\nStatus: fixing the HUD.', gate, visualTurn: true }), []);
  const [claim] = replyCorrections({ reply: 'The menu is done and looks good.', gate });
  assert.match(claim, /visual gate FAILED/, 'a visual claim needs the opening even on a quiet turn');
});

test('unrelated questions are not forced to open with the gate state', async () => {
  const gate = { ok: false, problems: [{ rule: 'VERDICT', text: 'verdict is FAIL' }] };
  assert.deepEqual(replyCorrections({ reply: 'The licence is MIT. Summary: you may reuse the code with attribution.', gate }), []);
  const root = project(PASS_GATE.replace('Verdict: PASS', 'Verdict: FAIL'));
  const { turnStopping } = harness(root);
  const steered = [];
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'what licence is the brain under?' }] } },
    ...callAndResult('read', { file_path: 'LICENSE' }, [{ type: 'text', text: 'MIT' }]),
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Result: it is MIT licensed.' }] } } },
  ];
  await turnStopping({ agent: { id: 'lead', session: lead(events), steer: message => steered.push(message) }, turn: 1 });
  assert.equal(steered.length, 0);
  const visualEvents = [...events.slice(0, 1), ...shot(T0 + 5000), events.at(-1)];
  await turnStopping({ agent: { id: 'lead2', session: { ...lead(visualEvents), id: 'lead2' }, steer: message => steered.push(message) }, turn: 1 });
  assert.equal(steered.length, 1, 'a turn that captured a screenshot is a visual turn');
});

test('suspicious captures (256x256 or a fallback) do not count as looking', () => {
  const { guard } = harness(project());
  const tiny = callAndResult('mcp__robloxstudio__capture_screenshot', {}, [{ type: 'text', text: '{}' }, ...tinyImage], { time: T0 + 100_000 });
  const fallback = callAndResult('mcp__robloxstudio__capture_screenshot', {},
    [{ type: 'text', text: '{"studioFastPathUnavailable":true}' }, ...image], { time: T0 + 100_000 });
  for (const capture of [tiny, fallback]) {
    const denial = guard(complete(lead([...capture, ...dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)])));
    assert.match(denial.reason, /\[LEAD_LOOKED\] every screenshot you viewed was flagged suspicious/);
  }
});

test('visuals cannot be called done on a worker rating without a fresh look', () => {
  const gate = { ok: true, problems: [] };
  const [fix] = replyCorrections({ reply: 'The reviewer rated it 9/10, so the UI looks great and is ready.', gate, lookedSinceChange: false });
  assert.match(fix, /without viewing a screenshot since the last change/);
  assert.deepEqual(replyCorrections({ reply: 'The UI looks great and is ready.', gate, lookedSinceChange: true }), []);
});

test('dispatch announcements must name the model and effort', () => {
  const dispatched = [{ name: 'impl-ui', ...IMPL_ROUTE }];
  const [fix] = replyCorrections({ reply: 'Dispatched impl-ui to build the HUD.\nWaiting on: impl-ui', dispatched });
  assert.match(fix, /impl-ui → claude\/claude-sonnet-5-5 at high/);
  assert.deepEqual(replyCorrections({ reply: 'Dispatched impl-ui (implementer/standard, claude-sonnet-5-5 at high).', dispatched }), []);
});

test('the coordinator turn is steered once when its reply breaks the rules', async () => {
  const root = project(null);
  const { turnStopping } = harness(root);
  const steered = [];
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    ...dispatch('impl', 'Role: implementer/standard\nBuild it.', IMPL_ROUTE),
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Started impl.' }] } } },
  ];
  const agent = { id: 'lead', session: lead(events), steer: message => steered.push(message) };
  await turnStopping({ agent, turn: 1 });
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /claude-sonnet-5-5 at high/);
  // Regression: 1.4.x steered without role/id, and the stored user/message made the session
  // log fail replay validation ("message must have role \"user\"").
  assert.equal(steered[0].role, 'user');
  assert.match(steered[0].id, /^[0-9a-f-]{36}$/);
  assert.ok(Object.isFrozen(steered[0]));
  await turnStopping({ agent, turn: 1 });
  assert.equal(steered.length, 1, 'never loops');
});

test('the worker status context shows each worker\'s model and effort', () => {
  const view = { running: [{ name: 'impl' }], finished: [] };
  const routes = new Map([['impl', { name: 'impl', ...IMPL_ROUTE }]]);
  assert.match(statusContext(view, routes), /impl \(claude\/claude-sonnet-5-5 at high\): running/);
});

test('dispatches are recorded with route, role and worker name from the session log', () => {
  const state = sessionState(lead(dispatch('reviewer', reviewPrompt, VISUAL_ROUTE)), brain);
  assert.deepEqual({ ...state.dispatchLog[0], prompt: undefined, time: undefined },
    { name: 'reviewer', ...VISUAL_ROUTE, role: 'visual', tier: 'standard', prompt: undefined, time: undefined, turn: 1 });
});

test('the lead prompt carries a gate line only while the gate fails', () => {
  assert.equal(gateStatusLine(undefined), '');
  assert.equal(gateStatusLine({ ok: true, problems: [] }), '');
  const line = gateStatusLine({ ok: false, problems: [{ rule: 'VERDICT_PASS', text: 'x' }] });
  assert.match(line, /FAILED on VERDICT_PASS/);
  assert.match(line, /Do not mention the gate in replies about other work/);
  assert.match(line, /in plain words/);
});
