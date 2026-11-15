/**
 * roblox-brain skill-use enforcement for the Roblox preset.
 *
 * Deny-only `tools.guard` checks that read the calling agent's own durable session log; nothing
 * here mutates a call, loads a skill on the model's behalf, or touches DSH access controls.
 *
 * - Lead gate: the coordinator may read, search and answer freely, but worker dispatch and file
 *   mutation require the workflow skill plus at least one roblox-brain domain skill.
 * - Assignment gate: every `subagent` dispatch (from the lead or from a worker) and every
 *   `send_message` that changes a worker's skill contract must state the pinned brain revision,
 *   the roblox-brain skills to load (all loaded by the sender), and the report owed.
 * - Worker gate: a worker may not mutate files until it has loaded every skill its active
 *   contract requires. A `Required skills: none — <reason>` contract is read-only.
 * - Acceptance gate: `update_goal` `complete` is refused while any descendant worker is missing a
 *   required skill or its evidence cannot be read; `roblox_skill_audit` reports the evidence.
 *
 * A skill counts as loaded only when a successful `skill` result (or a direct `/skill` invocation)
 * shows it was served from this bundle's pinned directory. A same-name project or user skill that
 * shadows the pin does not count.
 * @module @alexturbo/dsh-roblox-development/skill-policy
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_SKILL = 'roblox-tiered-workflow';
export const MUTATING_TOOLS = ['edit', 'write', 'apply_patch'];
export const DISPATCH_TOOL = 'subagent';
export const MESSAGE_TOOL = 'send_message';
export const GOAL_TOOL = 'update_goal';
const DENY_NAME = 'roblox-skill-guard';
const CONTRACT_LINE = /^[ \t>*_-]*Required skills:/im;

const realpath = dir => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/**
 * Read the pinned brain revision and the exact directories the pinned skills are served from.
 * @param root - bundle root URL (defaults to beside this module).
 * @returns commit, roblox-brain skill names, and name -> pinned directory (brain + workflow).
 */
export function loadBrain(root = new URL('./', import.meta.url)) {
  const bundle = fileURLToPath(root);
  const provenance = JSON.parse(readFileSync(path.join(bundle, 'vendor/roblox-brain/provenance.json'), 'utf8'));
  if (typeof provenance.commit !== 'string' || !/^[0-9a-f]{40}$/.test(provenance.commit)) {
    throw new Error('vendor/roblox-brain/provenance.json must record the pinned 40-character commit');
  }
  const skills = new Set();
  const dirs = new Map();
  for (const library of provenance.libraries ?? []) {
    const base = path.join(bundle, 'vendor/roblox-brain/skills', library);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      skills.add(entry.name);
      dirs.set(entry.name, realpath(path.join(base, entry.name)));
    }
  }
  if (skills.size === 0) throw new Error('vendor/roblox-brain contains no skills');
  dirs.set(WORKFLOW_SKILL, realpath(path.join(bundle, 'skills', WORKFLOW_SKILL)));
  return { commit: provenance.commit, skills, dirs };
}

const isSubagent = session => session?.header?.origin === 'subagent';
const deny = (reason, code) => ({ reason, info: { name: DENY_NAME, code, reason } });
const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text)
  .join('\n');

/* ------------------------------------------------------------------------------------------- */
/* Contract grammar                                                                             */
/* ------------------------------------------------------------------------------------------- */

const NEGATION = /\b(?:do not|don't|dont|never|no need|skip|without|not required)\b/i;

/**
 * Parse the skill contract out of an assignment or follow-up.
 *
 * Grammar (one field per line, optional Markdown bullet/emphasis prefix):
 *   Brain revision: <hex SHA, 7-40 chars>
 *   Required skills: a, b and c   |  [a, b]  |  none — <reason>  |  (empty, then "- a" bullet lines)
 *   Report: ... loaded skills ... applied checks ...
 * @param prompt - assignment text.
 * @returns parsed fields; `skills` holds every listed token, valid or not.
 */
export function parseAssignment(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const lines = text.split(/\r?\n/);
  const field = label => {
    const re = new RegExp(`^[ \\t>*_-]*${label}:[*_]*[ \\t]*(.*)$`, 'i');
    for (let index = 0; index < lines.length; index += 1) {
      const match = re.exec(lines[index]);
      if (match) return { value: match[1].trim(), index };
    }
    return undefined;
  };

  const revisionField = field('Brain revision');
  const revisionMatch = /^`?([0-9a-f]{7,40})`?\b/i.exec(revisionField?.value ?? '');
  const revision = revisionField === undefined ? undefined : (revisionMatch?.[1]?.toLowerCase() ?? '');

  const skillsField = field('Required skills');
  let skills = [];
  let none = false;
  let noneReason;
  if (skillsField !== undefined) {
    const value = skillsField.value;
    const noneMatch = /^none\b[ \t]*[-—–:(,]?[ \t]*(.*)$/i.exec(value);
    if (noneMatch) {
      none = true;
      noneReason = noneMatch[1].replace(/\)[ \t]*$/, '').trim();
    } else {
      let raw = value;
      if (raw === '') {
        const bullets = [];
        for (let index = skillsField.index + 1; index < lines.length; index += 1) {
          const bullet = /^[ \t]*[-*+][ \t]+(.+)$/.exec(lines[index]);
          if (!bullet) break;
          bullets.push(bullet[1]);
        }
        raw = bullets.join(',');
      }
      skills = [...new Set(raw
        .replace(/[[\]`*]/g, ' ')
        .split(/,|;|\s+and\s+|\s+/i)
        .map(name => name.replace(/[.:]+$/, '').trim())
        .filter(name => name.length > 0))];
    }
  }

  const reportField = field('Report');
  const report = reportField !== undefined
    && /loaded skills/i.test(reportField.value)
    && /applied checks/i.test(reportField.value)
    && !NEGATION.test(reportField.value);

  return {
    revision,
    hasSkillsLine: skillsField !== undefined,
    skills,
    none,
    noneReason,
    report,
  };
}

function assignmentTemplate(brain) {
  return `Brain revision: ${brain.commit}\nRequired skills: <comma-separated roblox-brain skills for this scope>\n`
    + 'Report: loaded skills, applied checks, evidence and unresolved findings.';
}

/* ------------------------------------------------------------------------------------------- */
/* Incremental session evidence                                                                 */
/* ------------------------------------------------------------------------------------------- */

const eventCount = session => (typeof session?.seq === 'number' ? session.seq
  : Array.isArray(session?.events) ? session.events.length : 0);
const eventAt = (session, seq) => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : session?.events?.[seq]);

const realpathCache = new Map();
function samePinnedDir(reported, pinned) {
  if (typeof reported !== 'string' || reported === '' || pinned === undefined) return false;
  const normal = path.resolve(reported);
  if (normal === pinned) return true;
  if (!realpathCache.has(normal)) realpathCache.set(normal, realpath(normal));
  return realpathCache.get(normal) === pinned;
}

/**
 * Verify that rendered skill content was served from this bundle's pinned directory.
 * @returns the verified skill name, or undefined.
 */
export function pinnedSkillFrom(text, brain, expectedName) {
  const name = /<skill_content name="([^"]+)">/.exec(text ?? '')?.[1];
  if (name === undefined || (expectedName !== undefined && name !== expectedName)) return undefined;
  const base = /^Base directory for this skill: (.+)$/m.exec(text)?.[1]
    ?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return samePinnedDir(base, brain.dirs.get(name)) ? name : undefined;
}

/** Tool name without the `mcp__<server>__` prefix, so both Studio backends match. */
export const baseToolName = name => (typeof name === 'string' && name.startsWith('mcp__') ? name.split('__').pop() : name);
export const SCREENSHOT_TOOLS = ['screen_capture', 'capture_screenshot', 'capture_device_matrix'];
const TRACKED_TOOLS = new Set([...SCREENSHOT_TOOLS, 'read_image', 'solo_playtest', 'multiplayer_playtest', 'start_stop_play',
  'search_assets', 'search_asset', 'get_asset_thumbnail', 'get_asset_details', 'insert_asset', 'generate_model']);
/** A read_image path counts as a screenshot only when it names a capture. */
export const CAPTURED_FILE = /(?:^|[\\/])(?:screenshots?|captures?)[\\/]|screen[-_ ]?shot|screen[-_ ]?capture|capture|device[-_ ]?matrix/i;
const ROLE_LINE = /^[ \t>*_-]*Role:[*_]*[ \t]*`?([a-z]+)\/(fast|standard|expert)\b/im;
/** Parse the optional `Role: <role>/<tier>` line of an assignment. */
export const parseRole = text => {
  const match = ROLE_LINE.exec(typeof text === 'string' ? text : '');
  return match ? { role: match[1].toLowerCase(), tier: match[2].toLowerCase() } : undefined;
};
const parseArgs = raw => {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
};
const hasImage = content => Array.isArray(content) && content.some(block => block?.type === 'image');

function freshState() {
  return {
    offset: 0,
    pendingSkill: new Map(),
    pendingDispatch: new Map(),
    pendingTracked: new Map(),
    dispatchLog: [],
    screenshots: [],
    playing: false,
    assets: { searches: [], thumbnails: new Set(), details: new Set(), changes: [] },
    loaded: new Set(),
    shadowed: new Set(),
    contracts: [],
    dispatches: 0,
    sawAssignment: false,
  };
}

function foldEvent(state, event, session, brain) {
  const data = event?.data;
  switch (event?.type) {
    case 'tool/call':
      if (data?.name === 'skill') {
        try {
          const name = JSON.parse(data.arguments)?.name;
          if (typeof name === 'string') state.pendingSkill.set(data.callId, name);
        } catch { /* malformed arguments never loaded a skill */ }
      } else if (data?.name === DISPATCH_TOOL) {
        state.pendingDispatch.set(data.callId, parseArgs(data.arguments));
      } else if (TRACKED_TOOLS.has(baseToolName(data?.name))) {
        state.pendingTracked.set(data.callId, { tool: baseToolName(data.name), args: parseArgs(data.arguments) });
      }
      return;
    case 'tool/result': {
      const callId = data?.message?.toolCallId;
      const ok = data?.message?.isError !== true;
      if (state.pendingSkill.has(callId)) {
        const name = state.pendingSkill.get(callId);
        state.pendingSkill.delete(callId);
        if (!ok) return;
        if (!brain.dirs.has(name)) return;
        if (pinnedSkillFrom(textOf(data.message.content), brain, name) === name) state.loaded.add(name);
        else state.shadowed.add(name);
      } else if (state.pendingDispatch.has(callId)) {
        const args = state.pendingDispatch.get(callId);
        state.pendingDispatch.delete(callId);
        if (!ok) return;
        state.dispatches += 1;
        const started = /started subagent (\S+)/.exec(textOf(data.message.content))?.[1];
        const prompt = typeof args.prompt === 'string' ? args.prompt : '';
        state.dispatchLog.push({
          name: started ?? (typeof args.name === 'string' ? args.name : ''),
          provider: args.provider, model: args.model, reasoning_effort: args.reasoning_effort,
          ...parseRole(prompt), prompt, time: event.time ?? Date.now(), turn: data.turn,
        });
      } else if (state.pendingTracked.has(callId)) {
        const { tool, args } = state.pendingTracked.get(callId);
        state.pendingTracked.delete(callId);
        if (ok) foldTracked(state, tool, args, data.message.content, event.time ?? Date.now());
      }
      return;
    }
    case 'user/message': {
      const source = data?.source;
      const text = textOf(data?.content);
      if (source?.kind === 'skill-invocation' && typeof source.name === 'string' && brain.dirs.has(source.name)) {
        if (pinnedSkillFrom(text, brain, source.name) === source.name) state.loaded.add(source.name);
        else state.shadowed.add(source.name);
        return;
      }
      const fromParent = source?.kind === 'agent-message'
        && session?.header?.parentSession !== undefined
        && source.senderSessionId === session.header.parentSession;
      if (source?.kind === 'user' && !state.sawAssignment) {
        state.sawAssignment = true;
        state.role = parseRole(text);
        state.contracts.push(parseAssignment(text));
      } else if ((source?.kind === 'user' || fromParent) && CONTRACT_LINE.test(text)) {
        state.contracts.push(parseAssignment(text));
      }
      return;
    }
    default:
  }
}

/** Fold one successful Studio, asset or screenshot tool result. */
function foldTracked(state, tool, args, content, time) {
  if (SCREENSHOT_TOOLS.includes(tool)) {
    if (hasImage(content)) state.screenshots.push({ tool, time });
  } else if (tool === 'read_image') {
    if (hasImage(content) && typeof args.file_path === 'string' && CAPTURED_FILE.test(args.file_path)) {
      state.screenshots.push({ tool, time, path: args.file_path });
    }
  } else if (tool === 'solo_playtest' || tool === 'multiplayer_playtest') {
    if (args.action === 'start') state.playing = true;
    else if (args.action === 'stop' || args.action === 'end') state.playing = false;
  } else if (tool === 'start_stop_play') {
    const start = args.is_start ?? args.start ?? args.isStart;
    if (start === true) state.playing = true;
    else if (start === false) state.playing = false;
  } else if (tool === 'search_assets' || tool === 'search_asset') {
    state.assets.searches.push(String(args.query ?? '').trim().toLowerCase());
  } else if (tool === 'get_asset_thumbnail') {
    if (args.assetId !== undefined) state.assets.thumbnails.add(String(args.assetId));
  } else if (tool === 'get_asset_details') {
    if (args.assetId !== undefined) state.assets.details.add(String(args.assetId));
  } else if (tool === 'insert_asset' || tool === 'generate_model') {
    state.assets.changes.push(time);
  }
}

const states = new WeakMap();

/**
 * Evidence for one session, folded incrementally: only events appended since the last call are
 * read. A shorter log than the cached offset (replacement or test reuse) rebuilds from scratch.
 * @returns the folded state.
 */
export function sessionState(session, brain) {
  if (session === null || typeof session !== 'object') return freshState();
  let state = states.get(session);
  const count = eventCount(session);
  if (state === undefined || state.brain !== brain || count < state.offset) {
    state = freshState();
    state.brain = brain;
    states.set(session, state);
  }
  for (let seq = state.offset; seq < count; seq += 1) foldEvent(state, eventAt(session, seq), session, brain);
  state.offset = count;
  return state;
}

/** Skills a session loaded from the pinned directories. */
export const loadedSkills = (session, brain) => new Set(sessionState(session, brain).loaded);

/**
 * The active contract for a worker: required skills accumulate across the assignment and parent
 * follow-ups; read-only status and revision follow the latest contract that states them.
 */
export function activeContract(state, brain) {
  const required = new Set();
  let readOnly = false;
  let revision;
  let declared = false;
  let noneReason;
  for (const contract of state.contracts) {
    if (contract.revision !== undefined) revision = contract.revision;
    if (!contract.hasSkillsLine) continue;
    declared = true;
    readOnly = contract.none;
    noneReason = contract.none ? contract.noneReason : undefined;
    for (const name of contract.skills) if (brain.dirs.has(name)) required.add(name);
  }
  return { required: [...required], readOnly, revision, declared, noneReason };
}

/** Audit row for one worker session. */
export function auditSession(session, brain) {
  const state = sessionState(session, brain);
  const contract = activeContract(state, brain);
  const revisionPinned = typeof contract.revision === 'string' && contract.revision.length >= 7
    && brain.commit.startsWith(contract.revision);
  const contractProblems = [];
  if (!revisionPinned) contractProblems.push('no pinned brain revision');
  if (!contract.declared) contractProblems.push('no Required skills contract');
  else if (contract.readOnly && (contract.noneReason ?? '').length < 8) contractProblems.push('unjustified "none" exemption');
  else if (!contract.readOnly && contract.required.length === 0) contractProblems.push('no valid required skills');
  return {
    revision: contract.revision ?? '',
    revisionPinned,
    contractValid: contractProblems.length === 0,
    contractProblems,
    readOnly: contract.readOnly,
    required: contract.required,
    loaded: [...state.loaded].sort(),
    shadowed: [...state.shadowed].sort(),
    missing: contract.required.filter(name => !state.loaded.has(name)),
    assets: assetEvidence(state),
  };
}

/** Plain, serializable asset-sourcing evidence from one session. */
export function assetEvidence(state) {
  return {
    searches: [...state.assets.searches],
    thumbnails: [...state.assets.thumbnails].sort(),
    details: [...state.assets.details].sort(),
    changes: [...state.assets.changes],
    screenshots: state.screenshots.length,
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Decisions                                                                                    */
/* ------------------------------------------------------------------------------------------- */

const shadowNote = state => (state.shadowed.size > 0
  ? ` Note: ${[...state.shadowed].join(', ')} loaded from a non-pinned copy (a project or user skill with the same name), `
    + 'which does not count; rename or remove that copy so the pinned bundle skill is served.'
  : '');

/** Lead may not act substantively before grounding in the workflow and a domain skill. */
export function leadGroundingDenial(state, brain, toolName) {
  const needsWorkflow = !state.loaded.has(WORKFLOW_SKILL);
  const needsDomain = ![...state.loaded].some(name => brain.skills.has(name));
  if (!needsWorkflow && !needsDomain) return undefined;
  const parts = [];
  if (needsWorkflow) parts.push(`load ${WORKFLOW_SKILL}`);
  if (needsDomain) parts.push('load the roblox-brain domain skills relevant to this scope (see the workflow\'s references/skill-selection.md)');
  return deny(
    `Roblox mode: ${toolName} is substantive work and needs loaded guidance first. Call the skill tool to ${parts.join(' and ')}, `
      + `then retry. Reading, searching and answering questions need no skills.${shadowNote(state)}`,
    'SKILLS_LEAD_NOT_GROUNDED');
}

/** Validate one assignment (dispatch prompt or contract-changing follow-up). */
export function contractDenial(prompt, state, brain, { followUp = false } = {}) {
  const parsed = parseAssignment(prompt);
  const problems = [];
  if (parsed.revision === undefined) {
    problems.push(`missing "Brain revision: ${brain.commit}"`);
  } else if (parsed.revision.length < 7 || !brain.commit.startsWith(parsed.revision)) {
    problems.push(`brain revision "${parsed.revision}" is not the pinned ${brain.commit}`);
  }
  if (!parsed.hasSkillsLine) {
    problems.push('missing "Required skills: <names>"');
  } else if (parsed.none) {
    if ((parsed.noneReason ?? '').length < 8) problems.push('"Required skills: none" needs a reason, e.g. "none — read-only web research"');
  } else if (parsed.skills.length === 0) {
    problems.push('"Required skills:" lists no skills');
  } else {
    const unknown = parsed.skills.filter(name => !brain.dirs.has(name));
    if (unknown.length > 0) problems.push(`unknown skills: ${unknown.join(', ')} (use exact roblox-brain names)`);
    if (unknown.length === 0 && !parsed.skills.some(name => brain.skills.has(name))) {
      problems.push('name at least one roblox-brain domain skill');
    }
    const unloaded = parsed.skills.filter(name => brain.dirs.has(name) && !state.loaded.has(name));
    if (unloaded.length > 0) problems.push(`you have not loaded ${unloaded.join(', ')} yourself; load them before assigning them`);
  }
  if (!parsed.report) problems.push('add a "Report:" line requiring loaded skills and applied checks');
  if (problems.length === 0) return undefined;
  return deny(
    `Roblox mode: ${followUp ? 'contract change' : 'worker assignment'} rejected (${problems.join('; ')}). `
      + `Put these lines in the ${followUp ? 'message' : 'prompt'}:\n${assignmentTemplate(brain)}\n`
      + 'Use "Required skills: none — <reason>" only for read-only work such as web research; such a worker cannot edit files.'
      + shadowNote(state),
    followUp ? 'SKILLS_CONTRACT_CHANGE_INCOMPLETE' : 'SKILLS_ASSIGNMENT_INCOMPLETE');
}

/** Worker may not mutate until every required skill is loaded; `none` contracts stay read-only. */
export function workerDenial(state, brain, toolName) {
  const contract = activeContract(state, brain);
  if (contract.readOnly) {
    return deny(
      `Roblox mode: your assignment declared "Required skills: none", so it is read-only and ${toolName} is refused. `
        + 'Report your findings; the lead can send a contract change with required skills if you should edit.',
      'SKILLS_WORKER_READ_ONLY');
  }
  if (!contract.declared || contract.required.length === 0) {
    return deny(
      `Roblox mode: ${toolName} refused because your assignment names no "Required skills". Ask the lead with send_message `
        + 'for a contract (brain revision, required roblox-brain skills, report) before editing.',
      'SKILLS_WORKER_NO_CONTRACT');
  }
  const missing = contract.required.filter(name => !state.loaded.has(name));
  if (missing.length === 0) return undefined;
  return deny(
    `Roblox mode: load your required skills before editing. Missing: ${missing.join(', ')}. `
      + `Call the skill tool for each, apply its checks, and report loaded skills and applied checks when done.${shadowNote(state)}`,
    'SKILLS_WORKER_NOT_LOADED');
}

/** Whether this call is one the skill policy decides; used to fail closed on internal errors. */
export function isSkillGated(execution) {
  const name = execution?.name;
  const args = execution?.arguments;
  if (name === DISPATCH_TOOL || MUTATING_TOOLS.includes(name)) return true;
  if (name === GOAL_TOOL) return args?.action === 'complete';
  if (name === MESSAGE_TOOL) return typeof args?.message === 'string' && CONTRACT_LINE.test(args.message);
  return false;
}

/**
 * Build the skill guard.
 * @param options.brain - pinned brain from {@link loadBrain}.
 * @param options.evidence - worker evidence store from {@link createEvidenceStore}.
 * @param options.log - sink for logged `none` assignments.
 * @returns a ToolGuard.
 */
export function createSkillGuard({ brain, evidence, log = line => console.warn(line), parentNameOf = () => undefined }) {
  return execution => {
    if (!isSkillGated(execution)) return undefined;
    // A message to one's own parent is a report, not a contract for someone else.
    if (execution.name === MESSAGE_TOOL) {
      const target = execution.arguments?.agent;
      let parentName;
      try {
        parentName = parentNameOf(execution.agent);
      } catch { /* unknown parent: treat as downward */ }
      if (target === 'lead' || (parentName !== undefined && target === parentName)) return undefined;
    }
    const name = execution.name;
    const args = execution.arguments ?? {};
    const session = execution.agent?.session;
    if (session === undefined || session === null) return undefined;
    const state = sessionState(session, brain);
    const worker = isSubagent(session);
    if (worker) evidence?.observe(session);

    if (MUTATING_TOOLS.includes(name)) {
      return worker ? workerDenial(state, brain, name) : leadGroundingDenial(state, brain, name);
    }
    if (name === GOAL_TOOL) {
      return evidence?.completionDenial(session.id ?? execution.agent.id, state.dispatches)
        ?? (evidence === undefined && state.dispatches > 0
          ? deny('Roblox mode: worker skill evidence is unavailable in this scope, so the goal cannot be verified complete.',
            'SKILLS_EVIDENCE_UNAVAILABLE')
          : undefined);
    }
    if (!worker) {
      const grounding = leadGroundingDenial(state, brain, name);
      if (grounding !== undefined) return grounding;
    }
    const followUp = name === MESSAGE_TOOL;
    const text = followUp ? args.message : args.prompt;
    const denial = contractDenial(text, state, brain, { followUp });
    if (denial === undefined) {
      const parsed = parseAssignment(text);
      if (parsed.none) log(`[${DENY_NAME}] read-only skill-less assignment: ${parsed.noneReason}`);
    }
    return denial;
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Worker evidence across settlement and restart                                                */
/* ------------------------------------------------------------------------------------------- */

/**
 * Durable-enough record of every worker each lead created, with audit evidence that survives the
 * worker's handle being disposed. Evidence is read from the live session while one exists, and
 * from the durable log (`sessionQuery.inspectSession`) after settlement or restart.
 * @param options.brain - pinned brain.
 * @param options.ctx - registrant context supplying agents, sessions, sessionQuery and subagents.
 * @returns the store.
 */
export function createEvidenceStore({ brain, ctx }) {
  const records = new Map();
  const seeded = new Set();
  const seeding = new Map();
  const attempted = new Set();
  let endCounter = 0;
  const get = key => {
    try {
      return ctx.get?.(key);
    } catch {
      return undefined;
    }
  };
  const liveSession = id => get('agents')?.get?.(id)?.session ?? get('sessions')?.get?.(id);
  const ensure = (id, parent) => {
    let record = records.get(id);
    if (record === undefined) {
      record = { id, parent, name: String(id), state: 'running', audit: undefined, pending: false, error: undefined, final: false, generation: 0 };
      records.set(id, record);
    }
    if (parent !== undefined) record.parent = parent;
    return record;
  };
  const refresh = record => {
    const session = liveSession(record.id);
    if (session === undefined) return false;
    record.generation += 1;
    record.pending = false;
    record.audit = auditSession(session, brain);
    record.error = undefined;
    record.final = record.state === 'finished';
    return true;
  };
  const readDurable = async record => {
    // Earlier snapshots are not evidence of the final state: drop them before reading. Each read
    // owns a generation; a result is committed only if no lifecycle change or newer read happened
    // while it was outstanding, so an older read can never overwrite newer evidence.
    const generation = record.generation += 1;
    record.audit = undefined;
    record.final = false;
    record.error = undefined;
    const query = get('sessionQuery');
    if (typeof query?.inspectSession !== 'function') {
      record.error = 'session log unavailable';
      return;
    }
    record.pending = true;
    let audit;
    let error;
    try {
      audit = await query.inspectSession(record.id, session => auditSession(session, brain));
    } catch (caught) {
      error = caught?.message ?? String(caught);
    }
    if (record.generation !== generation) return;
    record.pending = false;
    if (error !== undefined) {
      record.error = error;
    } else {
      record.audit = audit;
      record.final = true;
    }
  };
  const descendants = leadId => {
    const out = [];
    const queue = [leadId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const parent = queue.shift();
      for (const record of records.values()) {
        if (record.parent !== parent || seen.has(record.id)) continue;
        seen.add(record.id);
        out.push(record);
        queue.push(record.id);
      }
    }
    return out;
  };

  return {
    start(info) {
      if (info?.id === undefined) return;
      const record = ensure(info.id, info.parentSessionId);
      record.state = 'running';
      record.generation += 1;
      record.pending = false;
      record.final = false;
      try {
        const agent = get('agents')?.get?.(info.id);
        const name = agent === undefined ? undefined : get('subagents')?.namesOf?.(agent)?.self;
        if (typeof name === 'string' && name !== '') record.name = name;
      } catch { /* keep the id */ }
      refresh(record);
    },
    end(info) {
      if (info?.id === undefined) return undefined;
      const record = ensure(info.id, info.parentSessionId);
      record.state = 'finished';
      record.outcome = info.stopReason ?? 'completed';
      record.endedAt = Date.now();
      record.endedOrder = endCounter += 1;
      record.final = false;
      record.generation += 1;
      record.pending = false;
      if (refresh(record)) return undefined;
      return readDurable(record);
    },
    observe(session) {
      if (session?.id === undefined) return;
      const record = ensure(session.id, session.header?.parentSession);
      record.generation += 1;
      record.pending = false;
      record.audit = auditSession(session, brain);
      record.error = undefined;
    },
    /**
     * Load every descendant from the durable subagent catalog and read missing evidence.
     * Used by the audit tool and whenever this process has not seen a lead's workers.
     */
    async seed(leadId, signal) {
      const subagents = get('subagents');
      if (typeof subagents?.listDescendants !== 'function') throw new Error('subagent catalog unavailable');
      const entries = await subagents.listDescendants(leadId, signal);
      for (const entry of entries ?? []) {
        if (entry?.kind === 'diagnostic') {
          // An unreadable child catalog is unresolved evidence, never an empty branch.
          const record = ensure(entry.id, entry.parentId);
          record.diagnostic = entry.reason ?? 'unavailable';
          continue;
        }
        if (entry?.kind !== 'child') continue;
        const record = ensure(entry.id, entry.parentId);
        record.diagnostic = undefined;
        if (typeof entry.name === 'string' && entry.name !== '') record.name = entry.name;
        else if (typeof entry.label === 'string' && entry.label !== '' && record.name === String(record.id)) record.name = entry.label;
        if (entry.activity !== 'running' && record.state === 'running') record.state = 'finished';
      }
      await Promise.all(descendants(leadId).map(record => (refresh(record) ? undefined : readDurable(record))));
      seeded.add(leadId);
      return descendants(leadId);
    },
    rows(leadId) {
      return descendants(leadId);
    },
    /**
     * Status view of a lead's direct workers for the prompt context. After a remount or resume
     * the first call starts a background catalog read, so the next step shows recovered workers.
     */
    view(leadId) {
      if (!attempted.has(leadId)) {
        attempted.add(leadId);
        seeding.set(leadId, this.seed(leadId).catch(() => {}).finally(() => seeding.delete(leadId)));
      }
      const direct = descendants(leadId).filter(record => record.parent === leadId);
      return {
        running: direct.filter(record => record.state === 'running'),
        finished: direct.filter(record => record.state === 'finished')
          .sort((a, b) => (b.endedOrder ?? 0) - (a.endedOrder ?? 0))
          .slice(0, 5),
      };
    },
    /** Deny goal completion unless every descendant's evidence is read and complete. */
    completionDenial(leadId, dispatched) {
      const workers = descendants(leadId);
      const direct = workers.filter(record => record.parent === leadId).length;
      if (direct < dispatched) {
        return deny(
          `Roblox mode: this session dispatched ${dispatched} worker(s) but evidence is available for ${direct}`
            + `${seeded.has(leadId) ? ' even after reading the worker catalog' : ' (for example after a restart)'}. `
            + 'Call roblox_skill_audit to read their logs, then retry; unaccounted workers cannot be verified.',
          'SKILLS_AUDIT_REQUIRED');
      }
      const problems = [];
      for (const record of workers) {
        if (record.state === 'running') refresh(record);
        if (record.diagnostic !== undefined) problems.push(`${record.name}: worker catalog ${record.diagnostic}`);
        else if (record.pending) problems.push(`${record.name}: evidence still being read`);
        else if (record.error !== undefined || record.audit === undefined) {
          problems.push(`${record.name}: evidence unavailable${record.error ? ` (${record.error})` : ''}`);
        } else if (record.state === 'finished' && !record.final) problems.push(`${record.name}: final evidence not read`);
        else if (!record.audit.contractValid) problems.push(`${record.name}: invalid contract (${record.audit.contractProblems.join(', ')})`);
        else if (record.audit.missing.length > 0) problems.push(`${record.name} missing ${record.audit.missing.join(', ')}`);
      }
      if (problems.length === 0) return undefined;
      return deny(
        `Roblox mode: cannot complete the goal; worker skill evidence is incomplete (${problems.join('; ')}). `
          + 'Run roblox_skill_audit, have the worker load the missing skills and redo the affected checks, or reassign.',
        'SKILLS_UNVERIFIED_WORK');
    },
  };
}

/**
 * Register `roblox_skill_audit`: per descendant worker, required vs actually-loaded pinned skills.
 * @returns the disposer, or undefined when tools are unavailable.
 */
export function registerAuditTool(ctx, brain, evidence) {
  if (typeof ctx.tools?.register !== 'function') return undefined;
  const list = { type: 'array', items: { type: 'string' } };
  return ctx.tools.register({
    name: 'roblox_skill_audit',
    description: 'Audit your Roblox workers from their session logs: the brain revision each was given, the roblox-brain '
      + 'skills its contract requires, the pinned skills it actually loaded, any loaded from a non-pinned copy, and any '
      + 'missing. Call before accepting worker or reviewer output and compare with the worker\'s reported loaded skills '
      + 'and applied checks.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pinnedRevision: { type: 'string' },
          workers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                parent: { type: 'string' },
                state: { type: 'string' },
                evidence: { type: 'string' },
                revision: { type: 'string' },
                revisionPinned: { type: 'boolean' },
                contractValid: { type: 'boolean' },
                contractProblems: list,
                readOnly: { type: 'boolean' },
                required: list,
                loaded: list,
                shadowed: list,
                missing: list,
                assets: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    searches: list,
                    thumbnails: list,
                    details: list,
                    changes: { type: 'array', items: { type: 'number' } },
                    screenshots: { type: 'integer' },
                  },
                  required: ['searches', 'thumbnails', 'details', 'changes', 'screenshots'],
                },
              },
              required: ['id', 'name', 'parent', 'state', 'evidence', 'revision', 'revisionPinned', 'contractValid',
                'contractProblems', 'readOnly',
                'required', 'loaded', 'shadowed', 'missing', 'assets'],
            },
          },
        },
        required: ['pinnedRevision', 'workers'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const leadId = exec?.agent?.session?.id ?? exec?.agent?.id;
      let records;
      try {
        records = await evidence.seed(leadId, exec?.signal);
      } catch (error) {
        records = evidence.rows(leadId);
        if (records.length === 0) throw new Error(`worker catalog unavailable: ${error?.message ?? error}`);
      }
      const empty = { revision: '', revisionPinned: false, contractValid: false, contractProblems: [], readOnly: false,
        required: [], loaded: [], shadowed: [], missing: [],
        assets: { searches: [], thumbnails: [], details: [], changes: [], screenshots: 0 } };
      return {
        pinnedRevision: brain.commit,
        workers: records.map(record => ({
          id: String(record.id),
          name: record.name,
          parent: String(record.parent ?? ''),
          state: record.state,
          evidence: record.diagnostic !== undefined ? `catalog ${record.diagnostic}`
            : record.pending ? 'pending'
              : record.error !== undefined || record.audit === undefined ? `unavailable${record.error ? `: ${record.error}` : ''}`
                : record.state === 'finished' && !record.final ? 'stale' : 'read',
          ...empty,
          ...record.audit,
        })),
      };
    },
  });
}
