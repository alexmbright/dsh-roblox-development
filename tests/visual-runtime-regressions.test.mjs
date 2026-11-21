import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { replyCorrections, dispatchDenial, gateReport, completionDenial } from '../visual-policy.js';
import { visualTurnOf, createVisualGuard } from '../routing.js';
import { loadBrain } from '../skill-policy.js';

const failed = { ok: false, problems: [{ rule: 'VERDICT', text: 'FAIL' }] };
test('audit, routing, negative and unrelated completion statements do not claim visual approval', () => {
  for (const reply of ['The UI routing question is complete.', 'I finished the audit of the visual gate; these are bugs, not approval.',
    'The UI is not ready.', 'Upload routing is complete.', 'The visual gate plugin is fixed.']) {
    assert.deepEqual(replyCorrections({ reply, gate: failed }), [], reply);
  }
  for (const reply of ['The UI is ready.', 'The menu is done and looks good.', 'I finished the scene.',
    'The UI is ready, but the audit is pending.', 'The UI is ready to ship; the routing test is pending.', 'The UI looks good, not perfect.']) {
    assert.equal(replyCorrections({ reply, gate: failed }).length, 1, reply);
  }
});
test('routing-only dispatch and worker notices do not make a visual reporting turn', () => {
  const events = [{ type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { name: 'subagent', arguments: JSON.stringify({ prompt: 'Role: implementer/standard\nFix server persistence.' }) } },
    { type: 'user/message', data: { source: { kind: 'agent-message' } } }];
  assert.equal(visualTurnOf({ events }, 1), false);
  events.push({ type: 'tool/call', data: { name: 'subagent', arguments: JSON.stringify({ prompt: 'Role: implementer/standard\nFix the visual gate plugin and push.' }) } });
  assert.equal(visualTurnOf({ events }, 1), false);
  events.push({ type: 'tool/call', data: { name: 'subagent', arguments: JSON.stringify({ prompt: 'Role: visual/standard\nReview cap-1234567890' }) } });
  assert.equal(visualTurnOf({ events }, 1), true);
  events.pop();
  events.push({ type: 'tool/call', data: { name: 'subagent', arguments: JSON.stringify({ prompt: 'Role: implementer/standard\nBuild the menu UI in src/client.' }) } });
  assert.equal(visualTurnOf({ events }, 1), true);
});
test('wrong role route has a routing identity rather than a visual rejection', () => {
  const denial = dispatchDenial('Role: implementer/standard', { provider: 'a', model: 'b', reasoning_effort: 'low' },
    { role: 'implementer', tier: 'standard' }, () => [{ provider: 'x', model: 'y', reasoning_effort: 'high' }]);
  assert.equal(denial.info.name, 'roblox-routing-guard');
  assert.equal(denial.info.code, 'ROUTING_ROLE_MISMATCH');
});

const T = Date.parse('2026-11-15T12:00:00Z');
const ids = ['cap-1111111111', 'cap-2222222222', 'cap-3333333333'];
const assets = () => ({ searches: [], thumbnails: [], details: [], changes: [] });
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src/client'), { recursive: true });
  mkdirSync(path.join(root, 'docs/test'), { recursive: true });
  const source = path.join(root, 'src/client/UI.luau');
  writeFileSync(source, 'return {}');
  utimesSync(source, T / 1000, T / 1000);
  const gate = path.join(root, 'docs/test/VISUAL_GATE.md');
  writeFileSync(gate, `Verdict: PASS\nReviewer: review (visual/standard)\nScreenshots: ${ids.join(', ')}\n${[1,2,3,4,5].map(n => '- [x] check ' + n).join('\n')}\n## Asset sourcing\nNot applicable: UI-only text layout; no art pieces added or replaced.\n`);
  utimesSync(gate, (T + 3000) / 1000, (T + 3000) / 1000);
  const lead = { assets: assets(), screenshots: [{ time: T + 2000, suspicious: false }], dispatchLog: [
    { name: 'review', role: 'visual', tier: 'standard', time: T + 1000, prompt: `Review ${ids.join(' ')}` },
  ] };
  const shots = ids.map(id => ({ id, time: T + 500, viewedAt: T + 2000, suspicious: false }));
  const row = { name: 'review', audit: { assets: { ...assets(), screenshots: 3, screenshotEvidence: shots } } };
  return { root, lead, row, shots };
}
test('complete current reviewer evidence passes, missing worker evidence fails closed', t => {
  const f = fixture(t);
  assert.equal(gateReport({ ...f, workers: [f.row] }).ok, true);
  assert.ok(gateReport({ ...f, workers: [] }).problems.some(p => p.rule === 'REVIEWER_LOOKED'));
});
test('review evidence must cover every named capture, be fresh, and precede verdict', t => {
  const f = fixture(t);
  for (const shots of [f.shots.slice(0, 1), f.shots.map(s => ({ ...s, time: T - 1 })),
    f.shots.map(s => ({ ...s, viewedAt: T + 4000 })), f.shots.map(s => ({ ...s, viewedAt: T + 999 })),
    f.shots.map(s => ({ ...s, suspicious: true }))]) {
    const row = { name: 'review', audit: { assets: { ...assets(), screenshotEvidence: shots } } };
    assert.ok(gateReport({ ...f, workers: [row] }).problems.some(p => p.rule === 'REVIEWER_LOOKED'));
  }
});
test('named reviewer dispatch itself must follow watched changes, not another reviewer', t => {
  const f = fixture(t);
  f.lead.dispatchLog[0].time = T - 1;
  f.lead.dispatchLog.push({ ...f.lead.dispatchLog[0], name: 'other', time: T + 1000 });
  assert.ok(gateReport({ ...f, workers: [f.row] }).problems.some(p => p.rule === 'REVIEW_AFTER_WORK'));
});
test('reply checks use runtime failures even when every file check passes', async t => {
  const f = fixture(t);
  const steered = [];
  const events = [{ type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'The UI is ready.' }] } } }];
  const ctx = { get: key => key === 'workingDirectory' ? { get: () => f.root } : undefined };
  const guard = createVisualGuard({ ctx, brain: loadBrain(), evidence: { rows: () => [] }, previews: 'off' });
  await guard.turnStopping({ agent: { id: 'lead', session: { id: 'lead', events }, steer: m => steered.push(m) }, turn: 1 });
  assert.match(steered[0].content[0].text, /visual gate FAILED/);
});
test('natural language visual objectives remain gated without UI keywords', t => {
  const f = fixture(t);
  for (const objective of ['Make the Christmas tree beautiful', 'Fix button clipping', 'Implement responsive controls', '美化游戏界面']) {
    assert.equal(completionDenial({ ...f, objective, workers: [] })?.info.code, 'VISUAL_GATE_FAILED');
  }
  assert.equal(completionDenial({ ...f, objective: 'Fix the visual gate plugin and push', workers: [] }), undefined);
});
test('a new worker screenshot alone does not demand the gate opening, only the preview reminder', async t => {
  const f = fixture(t);
  const steered = [];
  let captures = [];
  const ctx = { get: key => key === 'workingDirectory' ? { get: () => f.root } : undefined };
  const guard = createVisualGuard({ ctx, brain: loadBrain(), evidence: { rows: () => [] }, collect: async () => ({ captures }) });
  const turn = (n, text) => [{ type: 'turn/start', data: { turn: n } },
    { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text }] } } }];
  const agent = events => ({ id: 'lead', session: { id: 'lead', events }, steer: m => steered.push(m) });
  await guard.turnStopping({ agent: agent(turn(1, 'Server data saved.')), turn: 1 });
  captures = [{ id: 'cap-4444444444', time: Date.now(), suspicious: false }];
  await guard.turnStopping({ agent: agent([...turn(1, 'Server data saved.'), ...turn(2, 'The DataStore retry works.')]), turn: 2 });
  assert.equal(steered.length, 1);
  const text = steered[0].content[0].text;
  assert.match(text, /new screenshot/);
  assert.doesNotMatch(text, /visual gate FAILED/);
});
