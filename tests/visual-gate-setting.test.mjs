import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrain } from '../skill-policy.js';
import { createVisualGuard, apply as applyRouting } from '../routing.js';
import { gateEnabled, visualGateInstructions } from '../visual-policy.js';
import {
  normalizeVisualGate, readVisualGate, writeVisualGate, settingsPath, SETTINGS_FILE,
} from '../visual-gate-setting.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(path.join(repo, name), 'utf8');
const brain = loadBrain();
const T0 = Date.parse('2026-11-15T12:00:00Z');

/* The persisted value ------------------------------------------------------------------------ */

test('explicit on and off are kept; legacy auto, unset and junk read as Off', () => {
  assert.equal(normalizeVisualGate('on'), 'on');
  assert.equal(normalizeVisualGate('off'), 'off');
  assert.equal(normalizeVisualGate(' ON '), 'on');
  for (const legacy of ['auto', undefined, null, '', 'maybe', 0, {}]) assert.equal(normalizeVisualGate(legacy), 'off', String(legacy));
});

test('the setting persists across a restart and keeps unrelated keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-setting-'));
  assert.deepEqual(readVisualGate(dir), { value: 'off', stored: false }, 'unset reads Off');
  writeFileSync(settingsPath(dir), JSON.stringify({ other: 1 }));
  assert.deepEqual(writeVisualGate(dir, 'on'), { ok: true, value: 'on' });
  // A "restart" is a fresh read from disk with no in-memory state.
  assert.equal(readVisualGate(dir).value, 'on');
  assert.equal(readVisualGate(dir).stored, true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')), { other: 1, visualGate: 'on' });
  assert.equal(writeVisualGate(dir, 'off').ok, true);
  assert.equal(readVisualGate(dir).value, 'off');
  assert.equal(readVisualGate(dir).stored, true, 'an explicit off is stored, not merely defaulted');
});

test('legacy auto is read as Off and flagged, and an invalid write is refused without touching the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-setting-'));
  writeFileSync(settingsPath(dir), JSON.stringify({ visualGate: 'auto' }));
  assert.deepEqual(readVisualGate(dir), { value: 'off', stored: false, legacy: true });
  const bad = writeVisualGate(dir, 'auto');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'value-rejected');
  assert.equal(JSON.parse(readFileSync(settingsPath(dir), 'utf8')).visualGate, 'auto');
  writeFileSync(settingsPath(dir), '{ not json');
  assert.equal(readVisualGate(dir).value, 'off', 'an unreadable file reads Off');
  assert.equal(readVisualGate('').value, 'off');
});

/* The patch reads the same file ------------------------------------------------------------- */

/** Evaluate the roblox-routing-guard `visualGate: !!js` expression exactly as the loader would. */
function patchVisualGate(profileDir) {
  const lines = read('cordis.patch.yml').split('\n');
  const start = lines.findIndex(line => /^\s+visualGate: !!js >-$/.test(line));
  assert.ok(start > 0, 'the guard row takes visualGate from a !!js expression');
  const indent = /^\s*/.exec(lines[start + 1])[0].length;
  const body = [];
  for (let index = start + 1; index < lines.length && /^\s*$/.test(lines[index].slice(0, indent)) && lines[index].trim() !== ''; index += 1) body.push(lines[index].slice(indent));
  const previous = process.env.DSH_PROFILE_DIR;
  if (profileDir === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = profileDir;
  try {
    return new Function(`return (${body.join('\n')});`)();
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR; else process.env.DSH_PROFILE_DIR = previous;
  }
}

test('the profile patch feeds the guard the persisted value and defaults to off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-patch-'));
  assert.equal(patchVisualGate(dir), 'off', 'no file');
  assert.equal(patchVisualGate(undefined), 'off', 'no profile directory');
  writeVisualGate(dir, 'on');
  assert.equal(patchVisualGate(dir), 'on');
  writeVisualGate(dir, 'off');
  assert.equal(patchVisualGate(dir), 'off');
  writeFileSync(settingsPath(dir), JSON.stringify({ visualGate: 'auto' }));
  assert.equal(patchVisualGate(dir), 'off', 'legacy auto');
  writeFileSync(settingsPath(dir), '{ nope');
  assert.equal(patchVisualGate(dir), 'off', 'unreadable');
});

/* One setting, two readers ------------------------------------------------------------------ */

function mount(config) {
  const guards = [];
  const sections = [];
  const ctx = {
    get: name => (name === 'systemPrompt' ? { section: s => { sections.push(s); return () => {}; }, getSectionOrder: () => 2800 } : undefined),
    on: () => () => {},
    tools: { guard: fn => { guards.push(fn); return () => {}; }, register: () => () => {} },
  };
  const dispose = applyRouting(ctx, config);
  return { guards, sections, dispose };
}

test('the mounted plugin gives the lead and the runtime the same resolved value', () => {
  for (const [config, expected] of [[{ visualGate: 'on' }, 'on'], [{ visualGate: 'off' }, 'off'], [{ visualGate: 'auto' }, 'off'], [{}, 'off'], [undefined, 'off']]) {
    const { sections, dispose } = mount(config);
    const section = sections.find(entry => entry.name === 'roblox-visual-gate');
    assert.ok(section, 'the lead gets a Visual gate section');
    assert.equal(section.interpolate, false);
    assert.equal(section.text(), visualGateInstructions(expected));
    assert.match(section.text(), expected === 'on' ? /Visual gate: ON/ : /Visual gate: OFF/);
    dispose();
  }
});

test('the Off instructions drop the formal review and name the one-check path; On restores the gate', () => {
  const off = visualGateInstructions('off');
  assert.match(off, /one implementer/);
  assert.match(off, /one screenshot of the changed view/);
  assert.match(off, /do not dispatch a formal visual reviewer/i);
  assert.match(off, /Studio screenshots, playtests and the visual role stay available/);
  assert.doesNotMatch(off, /Verdict: PASS\|FAIL|visual gate FAILED/);
  const on = visualGateInstructions('on');
  assert.match(on, /Verdict: PASS\|FAIL/);
  assert.match(on, /visual\/standard/);
  assert.match(on, /Edits after the review need a fresh review/);
  assert.match(on, /6 varied search_assets queries/);
});

/* Enforcement actually changes ------------------------------------------------------------- */

let seq = 0;
const call = (name, args, content, time = T0, turn = 1) => {
  const callId = `c${seq += 1}`;
  return [
    { type: 'tool/call', time, data: { turn, name, callId, arguments: JSON.stringify(args) } },
    { type: 'tool/result', time, data: { turn, message: { toolCallId: callId, isError: false, content } } },
  ];
};
const capture = time => call('mcp__robloxstudio__capture_screenshot', {}, [{ type: 'text', text: '{}' },
  { type: 'image', attachment: { attachmentId: `shot-${time}`, mediaType: 'image/png', bytes: 1, width: 1280, height: 720 } }], time);
const IMPL = { provider: 'claude', model: 'claude-sonnet-5-5', reasoning_effort: 'high' };
const UI_PROMPT = 'Rebuild the main menu UI in src/client/Menu.luau.\nBrain revision: x\nRequired skills: roblox-gui';
const dispatchImpl = (time = T0 + 10_000) => call('subagent', { prompt: UI_PROMPT, ...IMPL }, [{ type: 'text', text: 'started subagent impl-ui' }], time);

const EXISTING_GATE = '# Visual gate: launch\nVerdict: FAIL\nReviewer: reviewer (visual/standard)\n';
function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-enforce-'));
  mkdirSync(path.join(root, 'src/client'), { recursive: true });
  mkdirSync(path.join(root, 'docs/launch'), { recursive: true });
  writeFileSync(path.join(root, 'src/client/Menu.luau'), 'return {}');
  utimesSync(path.join(root, 'src/client/Menu.luau'), T0 / 1000, T0 / 1000);
  writeFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), EXISTING_GATE);
  utimesSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), (T0 + 60_000) / 1000, (T0 + 60_000) / 1000);
  return root;
}
const guardFor = (root, mode, objective = 'Polish the main menu UI') => createVisualGuard({
  ctx: { get: key => ({ workingDirectory: { get: () => root }, goals: { get: () => ({ objective }) } })[key] },
  brain, evidence: { rows: () => [] }, mode, collect: async () => ({ captures: [] }),
});
const lead = events => ({ id: 'lead', header: {}, events });
const exec = (session, name, args = {}) => ({ name, arguments: args, agent: { id: session.id, session } });

test('Off: a routine UI task finishes with one implementer and one Studio check, even beside an old gate file', () => {
  const root = project();
  // One implementer built it, one Studio screenshot inspected it. No reviewer, no Role line, no checklist.
  const session = lead([...dispatchImpl(), ...capture(T0 + 120_000)]);
  for (const mode of ['off', undefined, 'auto']) {
    const { guard, statusLine, report } = guardFor(root, mode);
    assert.equal(guard(exec(session, 'subagent', { prompt: UI_PROMPT, ...IMPL })), undefined, `dispatch without a Role line (${mode})`);
    assert.equal(guard(exec(session, 'update_goal', { action: 'complete' })), undefined, `completion (${mode})`);
    assert.equal(guard(exec(session, 'edit', { file_path: 'docs/launch/VISUAL_GATE.md' })), undefined, `no gate-file ownership (${mode})`);
    assert.equal(statusLine(session), '', `no gate status line (${mode})`);
    assert.equal(report(session), undefined, `no gate report (${mode})`);
  }
  assert.equal(readFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), 'utf8'), EXISTING_GATE, 'the existing gate file is intact');
});

test('On: the existing gate still blocks that same incomplete evidence', () => {
  const root = project();
  const session = lead([...dispatchImpl(), ...capture(T0 + 120_000)]);
  const { guard, statusLine } = guardFor(root, 'on');
  const denial = guard(exec(session, 'update_goal', { action: 'complete' }));
  assert.equal(denial?.info.code, 'VISUAL_GATE_FAILED');
  assert.match(denial.reason, /REVIEW_AFTER_WORK|REVIEWER_DISPATCHED|VERDICT/);
  assert.equal(guard(exec(session, 'subagent', { prompt: UI_PROMPT, ...IMPL }))?.info.code, 'VISUAL_ASSIGNMENT_INCOMPLETE');
  assert.equal(guard(exec(session, 'write', { file_path: 'docs/launch/VISUAL_GATE.md' }))?.info.code, 'VISUAL_GATE_FILE_OWNED');
  assert.match(statusLine(session), /visual gate: FAILED/i);
  assert.equal(readFileSync(path.join(root, 'docs/launch/VISUAL_GATE.md'), 'utf8'), EXISTING_GATE, 'the gate file is still intact');
});

test('only an explicit on enables the gate; a marker file alone no longer does', () => {
  const root = project();
  assert.equal(gateEnabled(root, 'on'), true);
  for (const mode of ['off', 'auto', undefined, '']) assert.equal(gateEnabled(root, mode), false, String(mode));
  assert.equal(gateEnabled(undefined, 'on'), false);
  assert.equal(existsSync(path.join(root, 'docs/launch/VISUAL_GATE.md')), true);
});

/* Risky work still calls for independent review --------------------------------------------- */

test('every instruction surface asks for independent review of the risky categories and drops the provider rule', () => {
  const patch = read('cordis.patch.yml');
  const docs = {
    patch,
    skill: read('skills/roblox-tiered-workflow/SKILL.md'),
    lifecycle: read('skills/roblox-tiered-workflow/references/lifecycle.md'),
    routing: read('skills/roblox-tiered-workflow/references/routing.md'),
    teams: read('skills/roblox-tiered-workflow/references/teams.md'),
    readme: read('README.md'),
  };
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, /saves and migrations/i, `${name}: saves and migrations`);
    assert.match(text, /purchase grants/i, `${name}: purchase grants`);
    assert.match(text, /multiplayer authority/i, `${name}: multiplayer authority`);
    assert.match(text, /releases?/i, `${name}: releases`);
    assert.match(text, /two repair attempts/i, `${name}: two repair attempts`);
    assert.match(text, /concrete bug/i, `${name}: concrete bugs block`);
    assert.doesNotMatch(text, /different provider from the implementer|different worker and provider|cross-provider review|final review cannot be independent/i, `${name}: no provider rule`);
  }
  for (const [name, text] of Object.entries(docs)) {
    assert.match(text, /one implementer|ONE implementer/i, `${name}: one implementer`);
    assert.match(text, /Visual gate/i, `${name}: visual gate`);
  }
  assert.match(patch, /Reserve independent review for consequential work/);
  assert.match(patch, /Default to ONE focused check/);
  assert.match(patch, /Lune for logic regressions, two clients for shared multiplayer behavior, capture_device_matrix when responsive layout is at risk/);
  assert.doesNotMatch(patch, /Visual quality gate \(when the project has docs/, 'the persona no longer hard-codes the gate rules');
  assert.match(read('README.md'), /npm test/);
});
