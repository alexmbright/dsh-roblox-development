/**
 * Visual-quality and asset-sourcing enforcement for the Roblox preset.
 *
 * Opt-in per project: active when the session workspace has a `docs/<scope>/VISUAL_GATE.md`, or
 * when the routing plugin config sets `visualGate: "on"`. With `visualGate: "off"`, or in a
 * project without the marker, nothing here applies.
 *
 * Deny-only `tools.guard` decisions, plus one `agent/turn-stopping` check that keeps the
 * coordinator's turn open (once) when its reply breaks the reporting rules:
 * - Dispatch: every worker assignment states `Role: <role>/<tier>` matching its route. A
 *   `visual/*` reviewer assignment must reference a capture id or image path, require
 *   `Verdict: PASS|FAIL` with a checklist, and name the VISUAL_GATE.md it records into. An
 *   assignment that touches Creator Store assets must carry the asset-sourcing rule.
 * - Gate file: only a visual worker may write VISUAL_GATE.md.
 * - Playtest: `insert_asset` / `generate_model` are refused while that session runs a playtest.
 * - Completion: `update_goal complete` on a visual objective needs a usable screenshot the
 *   coordinator viewed after the last client/asset change, a visual/standard|expert review
 *   dispatched after the last visual work, a passing gate (tools/check-visual-gate.mjs, the single
 *   rule source) whose reviewer is one of this coordinator's visual workers and viewed a
 *   screenshot, and asset evidence that matches the tool calls actually made in the session logs.
 * @module @alexturbo/dsh-roblox-development/visual-policy
 */
import path from 'node:path';
import { checkVisualGate, latestChange, watchSpec, GATE_FILE, RULES } from './tools/check-visual-gate.mjs';
import { baseToolName } from './skill-policy.js';
import { captureRefs } from './screenshots.js';

const DENY_NAME = 'roblox-visual-gate';
const deny = (reason, code) => ({ reason, info: { name: DENY_NAME, code, reason } });

export const VISUAL_OBJECTIVE = /\b(?:visuals?|visually|art|artwork|ui|gui|hud|layout|scene|scenery|looks?|look and feel|lighting|vfx|style|styling|polish|menu|screens?|theme|aesthetic|graphics|beautiful|beautify|clipping|responsive controls)\b|界面|视觉|美化|布局|灯光|场景/i;
export const VISUAL_WORK = /\b(?:visuals?|art|ui|gui|hud|layout|scene|lighting|vfx|style|menu|screen|theme|asset|assets|model|models|prop|props|mesh|texture|decal|icon|button|frame)\b|src\/client|StarterGui|StarterPlayer|ReplicatedFirst/i;
export const isVisualWork = text => VISUAL_WORK.test(String(text ?? '').replace(/\bvisual[ -]gate\b/gi, 'review policy'));
export const ASSET_WORK = /\b(?:creator store|toolbox|insert_asset|search_assets|search_asset|asset id|marketplace asset)\b/i;
const IMAGE_PATH = /[\w./\\-]+\.(?:png|jpe?g|webp|gif)\b/i;
// Match approval of the visual deliverable, not unrelated words anywhere in an audit/report.
export function claimsVisualCompletion(reply) {
  const subject = '(?:visuals?|art(?:work)?|ui|gui|hud|layout|scene|lighting|vfx|menu|screens?|theme|graphics)';
  return String(reply ?? '').split(/(?:[.!?;,]|\n|\bbut\b)+/i).some(sentence => {
    if (/\b(?:not|never|cannot|can't|isn't|aren't|doesn't|do not|don't|failed|fail|audit|routing|gate|checker|question)\b/i.test(sentence)) return false;
    return new RegExp(`\\b${subject}\\b[^,;:]{0,50}\\b(?:is|are|looks?|now|all)\\s+(?:done|good|great|ready|finished|complete|completed|polished|fine|nice|clean|approved|shippable)\\b`, 'i').test(sentence)
      || new RegExp(`\\b(?:finished|completed|polished|approved)\\s+(?:the\\s+)?${subject}\\b`, 'i').test(sentence);
  });
}
export const ASSET_RULE_TEMPLATE = 'Asset sourcing: run at least 6 varied search_assets queries per piece, get_asset_thumbnail and '
  + 'get_asset_details for every shortlisted candidate; scripts, triangle counts and bad pivots are fixable (insert in Edit mode, '
  + 'strip scripts, rescale), so reject a candidate only after seeing it in the scene, with a reason. Never insert during a playtest. '
  + 'Record queries and candidates in docs/<scope>/VISUAL_GATE.md.';

/** An assignment carries something to look at: an image path or a shared capture id. */
const hasVisualRef = text => IMAGE_PATH.test(text) || captureRefs(text).length > 0;

/** Project root of a session: the working directory service, else the header cwd. */
export function projectRoot(ctx, session) {
  try {
    const dir = ctx?.get?.('workingDirectory')?.get?.(session);
    if (typeof dir === 'string' && dir !== '') return dir;
  } catch { /* fall back */ }
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/** Whether the visual gate applies: only the explicit on setting, in a session with a project root. */
export function gateEnabled(root, mode = 'off') {
  return mode === 'on' && root !== undefined;
}

/**
 * Evaluate the gate with the bundled rules (the only rule source).
 * @returns `{ ok, problems: [{ rule, text, scope }], gates }`.
 */
export function evaluateGate(root) {
  const result = checkVisualGate(root);
  const problems = result.gates.flatMap(gate => gate.problems.map(item => ({
    ...item, scope: gate.scope, text: gate.scope ? `docs/${gate.scope}/${GATE_FILE}: ${item.text}` : item.text,
  })));
  return { ok: problems.length === 0, problems, gates: result.gates };
}

const formatProblem = item => `[${item.rule}] ${item.text}`;

/** Newest watched client-source or asset change, honoring each gate's Client source and Ignore lines. */
export function lastVisualChange(root, gates, assetChanges = []) {
  let disk = { time: 0 };
  if (root !== undefined) {
    const specs = (gates ?? []).length > 0 ? gates.map(gate => gate.watch ?? watchSpec(gate.gate)) : [watchSpec(undefined)];
    for (const spec of specs) {
      const found = latestChange(root, spec.watched, spec.ignored);
      if (found.time > disk.time) disk = found;
    }
  }
  const asset = assetChanges.length > 0 ? Math.max(...assetChanges) : 0;
  return asset > disk.time ? { time: asset, what: 'an asset insertion' } : { time: disk.time, what: disk.path ?? 'client source' };
}

const routeLabel = entry => `${entry.provider}/${entry.model} at ${entry.reasoning_effort}`;

/**
 * Validate one dispatch in an opted-in project.
 * @param prompt - assignment text.
 * @param args - dispatch arguments (provider, model, reasoning_effort).
 * @param roleRoutes - `(role, tier) => routes[] | undefined`; undefined skips the route match.
 */
export function dispatchDenial(prompt, args, parsedRole, roleRoutes = () => undefined) {
  const problems = [];
  if (parsedRole === undefined) {
    problems.push('state the worker role with a "Role: <role>/<tier>" line, for example "Role: visual/standard"');
  } else {
    const routes = roleRoutes(parsedRole.role, parsedRole.tier);
    if (Array.isArray(routes) && routes.length > 0 && !routes.some(route => route.provider === args?.provider
      && route.model === args?.model && route.reasoning_effort === args?.reasoning_effort)
      && !(typeof args?.capacityFallback === 'string' && args.capacityFallback.trim() !== '')) {
      const reason = `Roblox routing: worker assignment rejected (the route ${routeLabel(args ?? {})} is not a ${parsedRole.role}/${parsedRole.tier} route `
        + `(expected ${routes.map(routeLabel).join(' or ')})).`;
      return { reason, info: { name: 'roblox-routing-guard', code: 'ROUTING_ROLE_MISMATCH', reason } };
    }
    if (parsedRole.role === 'visual') {
      if (!hasVisualRef(prompt)) {
        problems.push('a visual review needs at least one screenshot to judge: pass capture ids from roblox_screenshots (e.g. cap-1a2b3c4d5e) or image paths');
      }
      if (!/Verdict:\s*`?PASS\s*\|\s*FAIL/i.test(prompt)) problems.push('require the verdict as "Verdict: PASS|FAIL" with a checklist');
      if (!new RegExp(GATE_FILE.replace('.', '\\.'), 'i').test(prompt)) problems.push(`name the docs/<scope>/${GATE_FILE} the reviewer records its verdict in`);
    }
  }
  if (ASSET_WORK.test(prompt) && !(/fixable/i.test(prompt) && /\bin(?:-| the )scene\b/i.test(prompt))) {
    problems.push(`asset work must carry the sourcing rule:\n${ASSET_RULE_TEMPLATE}`);
  }
  if (problems.length === 0) return undefined;
  return deny(`Roblox visual gate: worker assignment rejected (${problems.join('; ')}).`, 'VISUAL_ASSIGNMENT_INCOMPLETE');
}

/** Only a visual worker writes the gate file. */
export function gateFileEditDenial(filePath, isWorker, role) {
  if (typeof filePath !== 'string' || path.basename(filePath) !== GATE_FILE) return undefined;
  if (isWorker && role?.role === 'visual') return undefined;
  return deny(`Roblox visual gate: only the visual reviewer worker writes ${GATE_FILE}. Dispatch a visual/standard or visual/expert `
    + 'review with capture ids; it records "Verdict: PASS|FAIL", the checklist and the screenshots there.', 'VISUAL_GATE_FILE_OWNED');
}

/** Refuse asset insertion while this session runs a playtest. */
export function playtestInsertDenial(toolName, state) {
  const tool = baseToolName(toolName);
  if ((tool !== 'insert_asset' && tool !== 'generate_model') || state?.playing !== true) return undefined;
  return deny('Roblox visual gate: never insert assets during a playtest. Stop the playtest, insert in Edit mode, strip scripts, '
    + 'rescale and check the pivot, then capture a screenshot.', 'VISUAL_INSERT_DURING_PLAYTEST');
}

/** Problems where the gate's asset claims are not backed by the tool calls in the logs. */
export function assetEvidenceProblems(gates, evidence) {
  const searches = new Set(evidence.searches.map(query => query.toLowerCase()));
  const thumbnails = new Set(evidence.thumbnails);
  const details = new Set(evidence.details);
  const problems = [];
  for (const gate of gates ?? []) {
    for (const piece of gate.gate?.pieces ?? []) {
      const unlogged = piece.queries.filter(query => !searches.has(query.toLowerCase()));
      if (unlogged.length > 0) problems.push({ rule: 'ASSET_QUERIES', text: `piece "${piece.name}": queries never run with search_assets: ${unlogged.join('; ')}` });
      for (const candidate of piece.candidates) {
        if (candidate.id === undefined) continue;
        if (/^(?:yes|viewed|seen|true)$/i.test(candidate.fields.thumbnail ?? '') && !thumbnails.has(candidate.id)) {
          problems.push({ rule: 'ASSET_THUMBNAIL', text: `piece "${piece.name}" candidate ${candidate.id}: no get_asset_thumbnail call in any log` });
        }
        if (/^(?:yes|viewed|read|seen|true)$/i.test(candidate.fields.details ?? '') && !details.has(candidate.id)) {
          problems.push({ rule: 'ASSET_DETAILS', text: `piece "${piece.name}" candidate ${candidate.id}: no get_asset_details call or successful Assets API read (open_cloud_invoke GET /assets/v1/assets/<id>) in any log` });
        }
      }
    }
  }
  return problems;
}

/** Runtime-only rules (they need session evidence the file check cannot see). */
export const RUNTIME_RULES = {
  LEAD_LOOKED: 'the coordinator viewed a usable screenshot (not flagged suspicious) captured after the last watched change',
  REVIEW_AFTER_WORK: 'the named visual/standard or visual/expert reviewer was dispatched after the last visual work/change and before its verdict',
  REVIEWER_DISPATCHED: 'the gate reviewer is a visual worker this coordinator dispatched',
  REVIEWER_LOOKED: 'the named reviewer has readable evidence of a fresh usable screenshot viewed before its verdict',
  ASSET_LOGGED: 'claimed queries, thumbnails and details match the asset tool calls in the session logs',
};

/**
 * Every problem for a visual completion, file rules first then runtime rules.
 * @param input.root - project root.
 * @param input.lead - the coordinator's folded session state.
 * @param input.workers - worker audit rows (`{ name, audit }`).
 * @returns `{ ok, problems: [{ rule, text }], gate, change }`.
 */
export function gateReport({ root, lead, workers = [] }) {
  const gate = evaluateGate(root);
  const problems = [...gate.problems];
  const evidence = { searches: [...lead.assets.searches], thumbnails: [...lead.assets.thumbnails], details: [...lead.assets.details], changes: [...lead.assets.changes] };
  for (const worker of workers) {
    const assets = worker.audit?.assets;
    if (assets === undefined) continue;
    evidence.searches.push(...assets.searches);
    evidence.thumbnails.push(...assets.thumbnails);
    evidence.details.push(...assets.details);
    evidence.changes.push(...assets.changes);
  }
  const change = lastVisualChange(root, gate.gates, evidence.changes);
  const usable = lead.screenshots.filter(shot => shot.suspicious !== true);
  const lastShot = usable.reduce((latest, shot) => Math.max(latest, shot.time ?? 0), 0);
  if (usable.length === 0) {
    problems.push({ rule: 'LEAD_LOOKED', text: lead.screenshots.length > 0
      ? 'every screenshot you viewed was flagged suspicious (256x256 or smaller, or a fallback capture); capture the viewport again'
      : 'you have not viewed a screenshot yourself this session (a capture tool, roblox_screenshots view, or read_image on a captured file)' });
  } else if (lastShot <= change.time) {
    problems.push({ rule: 'LEAD_LOOKED', text: `your last usable screenshot predates ${change.what}; look again` });
  }
  const visualDispatches = lead.dispatchLog.filter(entry => entry.role === 'visual' && (entry.tier === 'standard' || entry.tier === 'expert')
    && hasVisualRef(entry.prompt));
  const lastWork = lead.dispatchLog.reduce((latest, entry) => (entry.role !== 'visual' && isVisualWork(entry.prompt)
    ? Math.max(latest, entry.time ?? 0) : latest), 0);
  const reviewBoundary = Math.max(lastWork, change.time);
  if (!visualDispatches.some(entry => (entry.time ?? 0) > reviewBoundary)) {
    problems.push({ rule: 'REVIEW_AFTER_WORK', text: 'no visual/standard or visual/expert review with capture ids was dispatched after the last visual work or watched change' });
  }
  const reviewers = new Set(visualDispatches.map(entry => entry.name).filter(Boolean));
  for (const result of gate.gates) {
    const named = result.gate?.reviewer;
    if (named === undefined) continue;
    if (!reviewers.has(named)) {
      problems.push({ rule: 'REVIEWER_DISPATCHED', text: `docs/${result.scope}/${GATE_FILE} names reviewer "${named}", which is not a visual worker you dispatched` });
    } else {
      const row = workers.find(worker => worker.name === named);
      const shots = row?.audit?.assets?.screenshotEvidence;
      const dispatch = visualDispatches.filter(entry => entry.name === named).at(-1);
      if ((dispatch?.time ?? 0) <= reviewBoundary || (dispatch?.time ?? 0) > result.mtime) {
        problems.push({ rule: 'REVIEW_AFTER_WORK', text: `reviewer "${named}" was not dispatched after the last visual work/change and before this verdict` });
      }
      const fresh = shot => shot.suspicious !== true && Number.isFinite(shot.time) && Number.isFinite(shot.viewedAt)
        && shot.time > change.time && shot.viewedAt >= shot.time && shot.viewedAt >= (dispatch?.time ?? Infinity)
        && shot.viewedAt <= result.mtime;
      if (!Array.isArray(shots) || !shots.some(fresh)) {
        problems.push({ rule: 'REVIEWER_LOOKED', text: `reviewer "${named}" has no readable evidence of viewing a fresh usable screenshot before the verdict` });
      }
      // Every gate reference must be an image actually opened, not just a typed filename or id.
      const refs = result.gate.screenshots.map(value => ({ ids: captureRefs(value), path: IMAGE_PATH.exec(value)?.[0] }));
      if (!Array.isArray(shots) || refs.some(ref => !shots.some(shot =>
        (ref.ids.includes(shot.id) || (ref.path && typeof shot.path === 'string'
          && path.resolve(root, ref.path) === path.resolve(root, shot.path)))
        && fresh(shot)))) {
        problems.push({ rule: 'REVIEWER_LOOKED', text: `reviewer "${named}" did not view every capture reference listed in this gate after the last change` });
      }
    }
  }
  for (const item of assetEvidenceProblems(gate.gates, evidence)) problems.push({ ...item, rule: 'ASSET_LOGGED' });
  return { ok: problems.length === 0, problems, gate, change };
}

/** Decide `update_goal complete` for a visual objective. */
export function completionDenial({ root, objective, lead, workers = [] }) {
  if (typeof objective !== 'string' || !VISUAL_OBJECTIVE.test(objective.replace(/\bvisual[ -]gate\b/gi, 'review policy'))) return undefined;
  const report = gateReport({ root, lead, workers });
  if (report.ok) return undefined;
  return deny(`Roblox visual gate FAILED: the objective is visual, so the goal cannot complete (${report.problems.map(formatProblem).join('; ')}). `
    + 'Report "visual gate FAILED" with these reasons, get fresh screenshots, dispatch a visual review, and retry. '
    + 'roblox_visual_gate shows the same check and every rule.', 'VISUAL_GATE_FAILED');
}

/**
 * The lead's visual-gate instructions for one mode. The guard and this text read the same
 * setting, so the lead is never told the gate is on while the runtime lets everything through.
 * @param mode - the resolved gate mode (`on`; anything else reads as Off).
 */
export function visualGateInstructions(mode) {
  if (mode === 'on') {
    return [
      'Visual gate: ON (Settings -> Roblox routing). The project gate is enforced for UI, art, scene, layout, polish and release work. '
      + 'Judge visuals only from screenshots you viewed yourself this session, never from a worker\'s or operator\'s text, and never call visuals done, good or ready on a rating alone. '
      + 'Every dispatch states "Role: <role>/<tier>". UI, art, scene and layout work is accepted only after a visual/standard (visual/expert for art direction) review whose prompt lists the screenshot capture ids, asks for "Verdict: PASS|FAIL" with a checklist, and names the docs/<scope>/VISUAL_GATE.md that only this reviewer writes. '
      + 'Edits after the review need a fresh review. roblox_visual_gate runs the same check as goal completion and explains each failing rule. '
      + 'When you report on visual work while the gate fails, open with "visual gate FAILED" and say in plain words what is missing, not rule ids; replies about other work do not mention the gate.',
      'Asset sourcing (gate On): before primitive or code-built geometry becomes final art, each piece needs at least 6 varied search_assets queries, get_asset_thumbnail and get_asset_details for every shortlisted candidate, and a rejection reason for each discarded one. Scripts, triangle counts and pivots are fixable, so reject a candidate only after seeing it in the scene. Never insert during a playtest. Show the user the creator, id and price of each kept cross-owner asset, with its dated authorization. Record this under "## Asset sourcing" in VISUAL_GATE.md; completion cross-checks it against the asset tool calls. Worker prompts that touch Creator Store assets carry this rule.',
    ].join('\n');
  }
  return [
    'Visual gate: OFF (default; Settings -> Roblox routing). Do not dispatch a formal visual reviewer, do not require a screenshot checklist or VISUAL_GATE.md, and do not ask for reapproval after edits. '
    + 'A routine UI, art, scene or content task finishes with one implementer who builds it and inspects it once in Studio: one screenshot of the changed view, plus capture_device_matrix only when responsive layout is at risk. '
    + 'Look at that capture yourself (roblox_screenshots view) before you call visuals done; a worker\'s rating alone is not evidence. '
    + 'Studio screenshots, playtests and the visual role stay available on demand, for example for art direction a user asks for. '
    + 'The gate\'s runtime checks are not active, so do not mention the gate in replies. Turning it On in Settings restores the full gate for polish or release work; that applies to new sessions.',
    'Assets: search the Creator Store (search_assets, then thumbnail and details) before final art is built from primitives, show the user the creator, id and price of each kept cross-owner asset, and never insert during a playtest.',
  ].join('\n');
}

/** Rule table for roblox_visual_gate. */
export const allRules = () => ({ ...RULES, ...RUNTIME_RULES });

/* ------------------------------------------------------------------------------------------- */
/* Coordinator reply checks (agent/turn-stopping)                                               */
/* ------------------------------------------------------------------------------------------- */

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');

/** Final assistant text of one turn. */
export function finalReply(session, turn) {
  const count = typeof session?.seq === 'number' ? session.seq : session?.events?.length ?? 0;
  const at = seq => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : session?.events?.[seq]);
  for (let seq = count - 1; seq >= 0; seq -= 1) {
    const event = at(seq);
    if (event?.type === 'turn/start' && event.data?.turn === turn) break;
    if (event?.type === 'assistant/message' && (turn === undefined || event.data?.turn === turn)) return textOf(event.data?.message?.content);
  }
  return '';
}

/**
 * Corrections owed by a coordinator reply, or [] when it is fine.
 * @param input.reply - final assistant text.
 * @param input.dispatched - dispatches made this turn (`{ name, provider, model, reasoning_effort }`).
 * @param input.gate - `{ ok, problems }` when the visual gate applies, else undefined.
 * @param input.visualTurn - whether this turn touched visual work (dispatch/finish, capture,
 *   asset insertion, gate change). The "visual gate FAILED" opening is owed only then, or when the
 *   reply itself claims visuals are done/good/ready.
 * @param input.lookedSinceChange - whether the coordinator viewed a screenshot after the last change.
 * @param input.newCaptures - capture ids new since the lead's last reply.
 */
export function replyCorrections({ reply, dispatched = [], gate, visualTurn = false, lookedSinceChange = true, newCaptures = [] }) {
  const out = [];
  if (newCaptures.length > 0 && !/!\[[^\]]*\]\(/.test(reply) && !/no (?:new )?(?:screenshots?|previews?|captures?) worth showing/i.test(reply)) {
    out.push(`Workers captured ${newCaptures.length} new screenshot(s) (${newCaptures.slice(0, 6).join(', ')}). Show the operator the `
      + 'ones that matter: pick them with roblox_screenshots (list/view) and embed each with ![caption](<path>) and a one-line note '
      + 'of what changed and who captured it, or say "no new screenshots worth showing".');
  }
  const lower = reply.toLowerCase();
  const unannounced = dispatched.filter(entry => typeof entry.model === 'string' && entry.model !== ''
    && !(lower.includes(entry.model.toLowerCase()) && lower.includes(String(entry.reasoning_effort ?? '').toLowerCase())));
  if (unannounced.length > 0) {
    out.push(`Announce each dispatch with its model and effort: ${unannounced.map(entry => `${entry.name || 'worker'} → `
      + `${entry.provider}/${entry.model} at ${entry.reasoning_effort}`).join('; ')}.`);
  }
  if (gate !== undefined) {
    const firstLine = reply.trim().split(/\r?\n/)[0] ?? '';
    const visualClaim = claimsVisualCompletion(reply);
    if (!gate.ok && (visualTurn || visualClaim) && !/visual gate FAILED/i.test(firstLine)) {
      out.push(`The visual gate is FAILED (${gate.problems.slice(0, 4).map(item => (typeof item === 'string' ? item : formatProblem(item))).join('; ')}). `
        + 'Open the report with "visual gate FAILED" and say in plain words what is missing, not rule ids; do not call the visuals done, good or ready.');
    } else if (gate.ok && visualClaim && !lookedSinceChange) {
      out.push('You called the visuals done/good/ready without viewing a screenshot since the last change. A worker\'s rating is not '
        + 'evidence: view a capture yourself (roblox_screenshots view) before making that claim, or withdraw it.');
    }
  }
  return out;
}

/**
 * One-line gate status for the lead's prompt, or '' when the gate does not apply or passes.
 * A passing gate needs no line: repeating it every turn made the lead mention the gate in
 * replies that had nothing to do with visual work.
 */
export function gateStatusLine(gate) {
  if (gate === undefined || gate.ok) return '';
  const rules = [...new Set(gate.problems.map(item => item.rule))].join(', ');
  return `Roblox visual gate: FAILED on ${rules}. Do not mention the gate in replies about other work. `
    + 'When you report on visual work, say in plain words what is missing (for example "the UI changed after the last visual review, '
    + 'so it needs a new review"), not rule ids; roblox_visual_gate lists each problem.';
}
