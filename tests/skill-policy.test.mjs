import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadBrain, loadedSkills, parseAssignment, createSkillGuard, createEvidenceStore, registerAuditTool,
  isSkillGated, sessionState, WORKFLOW_SKILL,
} from '../skill-policy.js';

const brain = loadBrain();
const SHA = brain.commit;

let callSeq = 0;
/** Rendered skill content exactly as dsh-tool-skill returns it. */
const rendered = (name, dir) => `<skill_content name="${name}">\n<skill_resources>\nBase directory for this skill: ${dir}\n`
  + 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n'
  + `</skill_resources>\n\n<skill_instructions>\n# ${name}\n</skill_instructions>\n</skill_content>`;
/** Events for one skill tool call and its result, served from the pinned dir unless `dir` is given. */
function skillLoad(name, { error = false, dir = brain.dirs.get(name) } = {}) {
  const callId = `c${callSeq += 1}`;
  return [
    { type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } },
    { type: 'tool/result', data: { message: { toolCallId: callId, isError: error, content: error ? [] : [{ type: 'text', text: rendered(name, dir) }] } } },
  ];
}
function dispatched(ok = true) {
  const callId = `d${callSeq += 1}`;
  return [
    { type: 'tool/call', data: { name: 'subagent', callId, arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: callId, isError: !ok, content: [] } } },
  ];
}
const userMessage = (text, source = { kind: 'user' }) => ({ type: 'user/message', data: { source, content: [{ type: 'text', text }] } });

const lead = (events = [], id = 'lead-1') => ({ id, header: {}, events });
const worker = (prompt, events = [], { id = 'w-1', parent = 'lead-1' } = {}) => (
  { id, header: { origin: 'subagent', parentSession: parent }, events: [userMessage(prompt), ...events] });
const call = (session, name, args = {}) => ({ name, arguments: args, agent: { id: session.id, session } });

const goodPrompt = (skills = 'roblox-luau-core, roblox-networking') => [
  'Implement the trade remote.',
  `Brain revision: ${SHA}`,
  `Required skills: ${skills}`,
  'Report: loaded skills, applied checks, evidence and unresolved findings.',
].join('\n');
const grounded = () => [...skillLoad(WORKFLOW_SKILL), ...skillLoad('roblox-luau-core'), ...skillLoad('roblox-networking')];
const groundedLead = (...extra) => lead([...grounded(), ...extra]);
const guardOf = (options = {}) => createSkillGuard({ brain, log: () => {}, ...options });

test('the pinned brain is read offline from the vendored snapshot, not bumped', () => {
  assert.equal(SHA, 'ceee4aaa5004502e2a51d78b3c33bba44d84742b');
  assert.equal(brain.skills.size, 29);
  assert.ok(brain.dirs.get('roblox-networking').endsWith(path.join('vendor', 'roblox-brain', 'skills', 'core', 'roblox-networking')));
  assert.ok(brain.dirs.has(WORKFLOW_SKILL) && !brain.skills.has(WORKFLOW_SKILL));
});

test('only successful loads from the pinned directory count', () => {
  const shadow = mkdtempSync(path.join(tmpdir(), 'shadow-'));
  mkdirSync(path.join(shadow, 'roblox-data'));
  const session = lead([
    ...skillLoad('roblox-gui'),
    ...skillLoad('roblox-audio', { error: true }),
    ...skillLoad('roblox-data', { dir: path.join(shadow, 'roblox-data') }),
    { type: 'tool/call', data: { name: 'skill', callId: 'bad', arguments: '{not json' } },
    userMessage(rendered('roblox-input', brain.dirs.get('roblox-input')), { kind: 'skill-invocation', name: 'roblox-input' }),
  ]);
  assert.deepEqual([...loadedSkills(session, brain)].sort(), ['roblox-gui', 'roblox-input']);
  assert.deepEqual([...sessionState(session, brain).shadowed], ['roblox-data']);
});

test('a shadowing project skill does not satisfy the gate and the denial says why', () => {
  const guard = guardOf();
  const session = lead([...skillLoad(WORKFLOW_SKILL), ...skillLoad('roblox-networking', { dir: '/project/.agents/skills/roblox-networking' })]);
  const denial = guard(call(session, 'edit'));
  assert.equal(denial.info.code, 'SKILLS_LEAD_NOT_GROUNDED');
  assert.match(denial.reason, /roblox-networking loaded from a non-pinned copy/);
});

test('evidence is folded incrementally rather than rescanning the log', () => {
  const events = [...grounded()];
  let reads = 0;
  const session = { id: 'lead-x', header: {}, get seq() { return events.length; }, eventAt: seq => { reads += 1; return events[seq]; } };
  const guard = guardOf();
  for (let i = 0; i < 10; i += 1) guard(call(session, 'edit'));
  assert.equal(reads, events.length, 'each event read once across ten gated calls');
  events.push(...skillLoad('roblox-gui'));
  guard(call(session, 'edit'));
  assert.equal(reads, events.length);
});

test('parseAssignment handles documented list forms', () => {
  const forms = [
    'roblox-gui, roblox-input',
    'roblox-gui and roblox-input',
    '[roblox-gui, roblox-input]',
    '`roblox-gui`; `roblox-input`.',
  ];
  for (const form of forms) assert.deepEqual(parseAssignment(`Required skills: ${form}`).skills, ['roblox-gui', 'roblox-input'], form);
  const bullets = parseAssignment('Required skills:\n- roblox-gui\n- roblox-input\nReport: loaded skills and applied checks');
  assert.deepEqual(bullets.skills, ['roblox-gui', 'roblox-input']);
  assert.deepEqual(parseAssignment('- **Required skills:** roblox-gui').skills, ['roblox-gui']);
  const none = parseAssignment(`Required skills: none — read-only web research`);
  assert.equal(none.none, true);
  assert.equal(none.noneReason, 'read-only web research');
});

test('an empty skills line never swallows the next line', () => {
  const parsed = parseAssignment('Required skills:\nReport: loaded skills, applied checks');
  assert.deepEqual(parsed.skills, []);
  assert.equal(parsed.report, true);
});

test('the report requirement must be an affirmative Report: field', () => {
  assert.equal(parseAssignment('Report: loaded skills, applied checks, evidence').report, true);
  assert.equal(parseAssignment('Report: do not report loaded skills or applied checks').report, false);
  assert.equal(parseAssignment('Mention loaded skills and applied checks somewhere').report, false);
});

test('questions and lookups are never gated, even with no skills loaded', () => {
  const guard = guardOf();
  for (const name of ['read', 'grep', 'glob', 'web_search', 'bash', 'roblox_routes', 'list_agents', 'todo_write', 'skill', 'create_goal']) {
    assert.equal(guard(call(lead(), name, {})), undefined, name);
  }
  assert.equal(guard(call(lead(), 'send_message', { agent: 'w', message: 'how is it going?' })), undefined);
  assert.equal(isSkillGated({ name: 'update_goal', arguments: { action: 'pause' } }), false);
});

test('an ungrounded lead cannot dispatch or edit, and the denial says how to fix it', () => {
  const guard = guardOf();
  for (const name of ['subagent', 'edit', 'write', 'apply_patch']) {
    const denial = guard(call(lead(), name, { prompt: goodPrompt() }));
    assert.equal(denial.info.code, 'SKILLS_LEAD_NOT_GROUNDED', name);
    assert.match(denial.reason, /roblox-tiered-workflow/);
    assert.match(denial.reason, /skill-selection\.md/);
  }
  const denial = guard(call(lead(skillLoad(WORKFLOW_SKILL)), 'subagent', { prompt: goodPrompt() }));
  assert.equal(denial.info.code, 'SKILLS_LEAD_NOT_GROUNDED', 'the handoff incident: workflow only');
  assert.doesNotMatch(denial.reason, /load roblox-tiered-workflow/);
});

test('a grounded lead with a complete assignment dispatches', () => {
  const guard = guardOf();
  assert.equal(guard(call(groundedLead(), 'subagent', { prompt: goodPrompt() })), undefined);
  assert.equal(guard(call(groundedLead(), 'edit')), undefined, 'grounded lead may make a short integration fix');
  assert.equal(guard(call(groundedLead(), 'subagent', { prompt: goodPrompt().replace(SHA, SHA.slice(0, 8)) })), undefined);
});

test('the handoff incident is rejected with the template', () => {
  const denial = guardOf()(call(groundedLead(), 'subagent', { prompt: 'Implement the trade remote in src/Trade.luau.' }));
  assert.equal(denial.info.code, 'SKILLS_ASSIGNMENT_INCOMPLETE');
  assert.match(denial.reason, /missing "Brain revision: ceee4aaa/);
  assert.match(denial.reason, /missing "Required skills/);
  assert.match(denial.reason, /"Report:" line/);
  assert.match(denial.reason, new RegExp(`Brain revision: ${SHA}\\nRequired skills:`));
});

test('assignment problems are each named', () => {
  const guard = guardOf();
  const cases = [
    [goodPrompt().replace(SHA, '0123456789abcdef0123456789abcdef01234567'), /not the pinned/],
    [goodPrompt().replace(SHA, 'latest'), /not the pinned/],
    [goodPrompt('roblox-netcode'), /unknown skills: roblox-netcode/],
    [goodPrompt('roblox-gui'), /have not loaded roblox-gui yourself/],
    [goodPrompt(WORKFLOW_SKILL), /at least one roblox-brain domain skill/],
    [goodPrompt('[]'), /lists no skills/],
    [goodPrompt().replace(/Report:.*/, ''), /"Report:" line/],
    [goodPrompt('none'), /needs a reason/],
  ];
  for (const [prompt, pattern] of cases) {
    const denial = guard(call(groundedLead(), 'subagent', { prompt }));
    assert.equal(denial?.info.code, 'SKILLS_ASSIGNMENT_INCOMPLETE', String(pattern));
    assert.match(denial.reason, pattern);
  }
});

test('a reasoned none assignment passes and is logged', () => {
  const lines = [];
  const guard = guardOf({ log: line => lines.push(line) });
  const prompt = `Find the MemoryStore limits page.\nBrain revision: ${SHA}\nRequired skills: none — read-only web research\nReport: loaded skills and applied checks.`;
  assert.equal(guard(call(groundedLead(), 'subagent', { prompt })), undefined);
  assert.match(lines[0], /read-only web research/);
});

test('a worker cannot edit until it loads its required skills', () => {
  const guard = guardOf();
  const fresh = worker(goodPrompt());
  const denial = guard(call(fresh, 'edit'));
  assert.equal(denial.info.code, 'SKILLS_WORKER_NOT_LOADED');
  assert.match(denial.reason, /Missing: roblox-luau-core, roblox-networking/);
  assert.equal(guard(call(fresh, 'read')), undefined, 'workers may read before loading');
  const ready = worker(goodPrompt(), [...skillLoad('roblox-luau-core'), ...skillLoad('roblox-networking')]);
  assert.equal(guard(call(ready, 'apply_patch')), undefined);
});

test('injected context messages are not mistaken for the assignment', () => {
  const session = { id: 'w', header: { origin: 'subagent', parentSession: 'lead-1' },
    events: [userMessage('catalog', { kind: 'skill-catalog' }), userMessage(goodPrompt())] };
  assert.equal(guardOf()(call(session, 'edit')).info.code, 'SKILLS_WORKER_NOT_LOADED');
});

test('a none worker is read-only and a worker without a contract must ask', () => {
  const guard = guardOf();
  const none = worker(`Brain revision: ${SHA}\nRequired skills: none — read-only web research`);
  assert.equal(guard(call(none, 'edit')).info.code, 'SKILLS_WORKER_READ_ONLY');
  assert.equal(guard(call(worker('Fix the bug.'), 'write')).info.code, 'SKILLS_WORKER_NO_CONTRACT');
});

test('nested dispatch from a worker is held to the same assignment contract', () => {
  const guard = guardOf();
  const w = worker(goodPrompt(), [...skillLoad('roblox-luau-core'), ...skillLoad('roblox-networking')]);
  assert.equal(guard(call(w, 'subagent', { prompt: 'nested' })).info.code, 'SKILLS_ASSIGNMENT_INCOMPLETE');
  assert.equal(guard(call(w, 'subagent', { prompt: goodPrompt('roblox-networking') })), undefined,
    'a worker needs no workflow grounding, only the contract and its own loads');
  assert.match(guard(call(w, 'subagent', { prompt: goodPrompt('roblox-gui') })).reason, /have not loaded roblox-gui yourself/);
});

test('follow-up contracts from the parent extend requirements and can lift read-only', () => {
  const guard = guardOf();
  const followUp = text => userMessage(text, { kind: 'agent-message', form: 'relay', senderSessionId: 'lead-1' });
  const widened = worker(goodPrompt('roblox-luau-core'), [
    ...skillLoad('roblox-luau-core'),
    followUp(`Now also wire the remote.\nBrain revision: ${SHA}\nRequired skills: roblox-networking\nReport: loaded skills, applied checks`),
  ]);
  assert.match(guard(call(widened, 'edit')).reason, /Missing: roblox-networking/);
  const promoted = worker(`Brain revision: ${SHA}\nRequired skills: none — read-only research`, [
    followUp(`Please implement it.\nBrain revision: ${SHA}\nRequired skills: roblox-gui\nReport: loaded skills, applied checks`),
    ...skillLoad('roblox-gui'),
  ]);
  assert.equal(guard(call(promoted, 'edit')), undefined);
  const stranger = worker(goodPrompt('roblox-luau-core'), [
    ...skillLoad('roblox-luau-core'),
    userMessage(`Required skills: none — trust me`, { kind: 'agent-message', form: 'relay', senderSessionId: 'sibling' }),
  ]);
  assert.equal(guard(call(stranger, 'edit')), undefined, 'only the parent may change the contract');
});

test('a contract-changing send_message is validated; ordinary messages and reports are not', () => {
  const guard = guardOf({ parentNameOf: () => 'lead' });
  const bad = guard(call(groundedLead(), 'send_message', { agent: 'impl', message: 'Required skills: roblox-gui' }));
  assert.equal(bad.info.code, 'SKILLS_CONTRACT_CHANGE_INCOMPLETE');
  const good = guard(call(groundedLead(), 'send_message', { agent: 'impl',
    message: `Brain revision: ${SHA}\nRequired skills: roblox-networking\nReport: loaded skills, applied checks` }));
  assert.equal(good, undefined);
  const w = worker(goodPrompt());
  assert.equal(guard(call(w, 'send_message', { agent: 'lead', message: 'Required skills: roblox-gui were loaded' })), undefined,
    'a report upward is not a contract');
});

/* Evidence store ------------------------------------------------------------------------------ */

/** DSH 0.2.3+ exposes `observeSession` leases; DSH 0.2.2-rc.5 exposes `inspectSession`. */
const durableQuery = (durable, api) => (api === 'observe'
  ? {
    observeSession: async id => {
      if (!durable.has(id)) throw new Error('not found');
      const { header, events } = durable.get(id);
      return { source: 'prepared', header: { ...header, id }, events, cursor: events.length - 1, [Symbol.dispose]: () => {} };
    },
  }
  : {
    inspectSession: async (id, read) => {
      if (!durable.has(id)) throw new Error('not found');
      return read(durable.get(id));
    },
  });

function evidenceHarness({ live = new Map(), durable = new Map(), catalog = [], api = 'inspect' } = {}) {
  const ctx = {
    get: key => ({
      agents: { get: id => (live.has(id) ? { id, session: live.get(id) } : undefined) },
      sessions: { get: () => undefined },
      subagents: {
        namesOf: agent => ({ self: `name-${agent.id}` }),
        listDescendants: async () => catalog,
      },
      sessionQuery: durableQuery(durable, api),
    })[key],
  };
  return { ctx, store: createEvidenceStore({ brain, ctx }) };
}

for (const api of ['inspect', 'observe']) test(`a finished worker stays in the acceptance check after its handle is disposed (${api})`, async () => {
  const lagging = worker(goodPrompt(), skillLoad('roblox-luau-core'), { id: 'impl' });
  const live = new Map([['impl', lagging]]);
  const durable = new Map([['impl', lagging]]);
  const { store } = evidenceHarness({ live, durable, api });
  const guard = guardOf({ evidence: store });
  store.start({ id: 'impl', parentSessionId: 'lead-1' });
  live.delete('impl');
  await store.end({ id: 'impl', parentSessionId: 'lead-1', stopReason: 'completed' });
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.equal(denial.info.code, 'SKILLS_UNVERIFIED_WORK');
  assert.match(denial.reason, /name-impl missing roblox-networking/);
});

for (const api of ['inspect', 'observe']) test(`unreadable evidence blocks completion instead of counting as clean (${api})`, async () => {
  const { store } = evidenceHarness({ api });
  const guard = guardOf({ evidence: store });
  store.start({ id: 'gone', parentSessionId: 'lead-1' });
  await store.end({ id: 'gone', parentSessionId: 'lead-1', stopReason: 'completed' });
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.match(denial.reason, /evidence unavailable \(not found\)/);
});

for (const api of ['inspect', 'observe']) test(`after a restart, completion requires an audit before it can be verified (${api})`, async () => {
  const done = worker(goodPrompt(), [...skillLoad('roblox-luau-core'), ...skillLoad('roblox-networking')], { id: 'impl' });
  const { store } = evidenceHarness({ api, durable: new Map([['impl', done]]),
    catalog: [{ kind: 'child', id: 'impl', parentId: 'lead-1', activity: 'inactive', name: 'impl' }] });
  const guard = guardOf({ evidence: store });
  const leadSession = groundedLead(...dispatched());
  assert.equal(guard(call(leadSession, 'update_goal', { action: 'complete' })).info.code, 'SKILLS_AUDIT_REQUIRED');
  await store.seed('lead-1');
  assert.equal(guard(call(leadSession, 'update_goal', { action: 'complete' })), undefined);
});

test('descendants are audited, not just direct children', async () => {
  const nested = worker(goodPrompt('roblox-gui'), [], { id: 'grandchild', parent: 'impl' });
  const { store } = evidenceHarness({ live: new Map([['grandchild', nested]]) });
  store.start({ id: 'impl', parentSessionId: 'lead-1' });
  store.start({ id: 'grandchild', parentSessionId: 'impl' });
  const denial = guardOf({ evidence: store })(call(groundedLead(), 'update_goal', { action: 'complete' }));
  assert.match(denial.reason, /name-grandchild missing roblox-gui/);
});

test('without an evidence store, completion after dispatch fails closed', () => {
  const denial = guardOf()(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.equal(denial.info.code, 'SKILLS_EVIDENCE_UNAVAILABLE');
  assert.equal(guardOf()(call(groundedLead(), 'update_goal', { action: 'complete' })), undefined, 'no workers, nothing to verify');
});

test('roblox_skill_audit reads the durable catalog and reports evidence per worker', async () => {
  const w = worker(goodPrompt(), skillLoad('roblox-luau-core'), { id: 'impl' });
  const { ctx, store } = evidenceHarness({ durable: new Map([['impl', w]]),
    catalog: [{ kind: 'child', id: 'impl', parentId: 'lead-1', activity: 'inactive', name: 'implementer' }] });
  let tool;
  ctx.tools = { register: definition => { tool = definition; return () => {}; } };
  registerAuditTool(ctx, brain, store);
  assert.equal(tool.name, 'roblox_skill_audit');
  const value = await tool.execute({}, { agent: { id: 'lead-1', session: lead() } });
  assert.equal(value.pinnedRevision, SHA);
  const row = value.workers[0];
  assert.equal(row.name, 'implementer');
  assert.equal(row.evidence, 'read');
  assert.equal(row.revisionPinned, true);
  assert.deepEqual(row.missing, ['roblox-networking']);
  for (const key of tool.output.schema.items?.required ?? tool.output.schema.properties.workers.items.required) {
    assert.ok(key in row, key);
  }
});

test('the status view recovers workers from the catalog after a remount', async () => {
  const { store } = evidenceHarness({ catalog: [
    { kind: 'child', id: 'impl', parentId: 'lead-1', activity: 'running', name: 'implementer' },
  ] });
  assert.deepEqual(store.view('lead-1').running, [], 'first assembly starts recovery');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(store.view('lead-1').running.map(r => r.name), ['implementer']);
});

/* Second review regressions ------------------------------------------------------------------- */

test('an unreadable catalog branch blocks completion even after the catalog is read', async () => {
  const { store } = evidenceHarness({ catalog: [{ kind: 'diagnostic', id: 'w', parentId: 'lead-1', reason: 'corrupt' }] });
  const guard = guardOf({ evidence: store });
  const leadSession = groundedLead(...dispatched());
  await store.seed('lead-1');
  const denial = guard(call(leadSession, 'update_goal', { action: 'complete' }));
  assert.equal(denial.info.code, 'SKILLS_UNVERIFIED_WORK');
  assert.match(denial.reason, /worker catalog corrupt/);
});

test('reading the catalog never waives an unaccounted dispatch', async () => {
  const { store } = evidenceHarness({ catalog: [] });
  const guard = guardOf({ evidence: store });
  await store.seed('lead-1');
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.equal(denial.info.code, 'SKILLS_AUDIT_REQUIRED');
  assert.match(denial.reason, /even after reading the worker catalog/);
});

test('a failed final read does not fall back to an earlier clean snapshot', async () => {
  const followUp = text => userMessage(text, { kind: 'agent-message', form: 'relay', senderSessionId: 'lead-1' });
  const early = worker(`Brain revision: ${SHA}\nRequired skills: none — read-only research`, [], { id: 'impl' });
  const live = new Map([['impl', early]]);
  const { store } = evidenceHarness({ live });
  const guard = guardOf({ evidence: store });
  store.start({ id: 'impl', parentSessionId: 'lead-1' });
  early.events.push(followUp(`Brain revision: ${SHA}\nRequired skills: roblox-networking\nReport: loaded skills, applied checks`));
  live.delete('impl');
  await store.end({ id: 'impl', parentSessionId: 'lead-1', stopReason: 'completed' });
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.equal(denial.info.code, 'SKILLS_UNVERIFIED_WORK');
  assert.match(denial.reason, /name-impl: evidence unavailable \(not found\)/);
});

test('a worker with no valid contract does not audit as clean', async () => {
  const bare = worker('Implement game code.', [], { id: 'impl' });
  const { store } = evidenceHarness({ durable: new Map([['impl', bare]]),
    catalog: [{ kind: 'child', id: 'impl', parentId: 'lead-1', activity: 'inactive', name: 'impl' }] });
  const guard = guardOf({ evidence: store });
  await store.seed('lead-1');
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.match(denial.reason, /impl: invalid contract \(no pinned brain revision, no Required skills contract\)/);
  const exempt = worker(`Brain revision: ${SHA}\nRequired skills: none — read-only web research`, [], { id: 'impl' });
  const ok = evidenceHarness({ durable: new Map([['impl', exempt]]),
    catalog: [{ kind: 'child', id: 'impl', parentId: 'lead-1', activity: 'inactive', name: 'impl' }] });
  await ok.store.seed('lead-1');
  assert.equal(guardOf({ evidence: ok.store })(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' })), undefined,
    'a justified none exemption is a valid contract');
});

test('an older evidence read resolving late cannot overwrite newer settlement evidence', async () => {
  const clean = worker(goodPrompt(), [...skillLoad('roblox-luau-core'), ...skillLoad('roblox-networking')], { id: 'impl' });
  const lagging = worker(goodPrompt(), skillLoad('roblox-luau-core'), { id: 'impl' });
  const pending = [];
  const ctx = { get: key => ({
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    subagents: { namesOf: () => ({ self: 'impl' }), listDescendants: async () => [] },
    sessionQuery: { inspectSession: (_id, read) => new Promise(resolve => pending.push(session => resolve(read(session)))) },
  })[key] };
  const store = createEvidenceStore({ brain, ctx });
  const guard = guardOf({ evidence: store });
  store.start({ id: 'impl', parentSessionId: 'lead-1' });
  const first = store.end({ id: 'impl', parentSessionId: 'lead-1', stopReason: 'completed' });
  store.start({ id: 'impl', parentSessionId: 'lead-1' });
  const second = store.end({ id: 'impl', parentSessionId: 'lead-1', stopReason: 'completed' });
  pending[1](lagging);
  await second;
  pending[0](clean);
  await first;
  const denial = guard(call(groundedLead(...dispatched()), 'update_goal', { action: 'complete' }));
  assert.equal(denial?.info.code, 'SKILLS_UNVERIFIED_WORK');
  assert.match(denial.reason, /impl missing roblox-networking/);
});
