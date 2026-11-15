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
 *   `visual/*` reviewer assignment must reference a screenshot or image path, require
 *   `Verdict: PASS|FAIL` with a checklist, and name the VISUAL_GATE.md it records into. An
 *   assignment that touches Creator Store assets must carry the asset-sourcing rule.
 * - Gate file: only a visual worker may write VISUAL_GATE.md.
 * - Playtest: `insert_asset` / `generate_model` are refused while that session runs a playtest.
 * - Completion: `update_goal complete` on a visual objective needs a screenshot the coordinator
 *   viewed after the last client/asset change, a visual/standard|expert review dispatched after
 *   the last visual work, a passing gate (bundled check plus the project's own script) whose
 *   reviewer is one of this coordinator's visual workers, and asset evidence that matches the
 *   tool calls actually made in the worker logs.
 * @module @alexturbo/dsh-roblox-development/visual-policy
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { checkVisualGate, gateScopes, latestChange, DEFAULT_CLIENT_SOURCE, GATE_FILE } from './tools/check-visual-gate.mjs';
import { baseToolName } from './skill-policy.js';
import { captureRefs } from './screenshots.js';

/** An assignment carries something to look at: an image path or a shared capture id. */
const hasVisualRef = text => IMAGE_PATH.test(text) || captureRefs(text).length > 0;

const DENY_NAME = 'roblox-visual-gate';
const deny = (reason, code) => ({ reason, info: { name: DENY_NAME, code, reason } });

export const VISUAL_OBJECTIVE = /\b(?:visuals?|visually|art|artwork|ui|gui|hud|layout|scene|scenery|looks?|look and feel|lighting|vfx|style|styling|polish|menu|screens?|theme|aesthetic|graphics)\b/i;
export const VISUAL_WORK = /\b(?:visuals?|art|ui|gui|hud|layout|scene|lighting|vfx|style|menu|screen|theme|asset|assets|model|models|prop|props|mesh|texture|decal|icon|button|frame)\b|src\/client|StarterGui|StarterPlayer|ReplicatedFirst/i;
export const ASSET_WORK = /\b(?:creator store|toolbox|insert_asset|search_assets|search_asset|asset id|marketplace asset)\b/i;
const IMAGE_PATH = /[\w./\\-]+\.(?:png|jpe?g|webp|gif)\b/i;
const CLAIM = /\b(?:done|good|great|ready|finished|complete|completed|polished|looks? (?:good|great|fine|nice|clean)|ship(?:pable)?|approved|pass(?:es|ed)?)\b/i;
const STATUS = /\b(?:status|done|complete|completed|finished|ready|shipped|progress|summary|result)\b/i;
export const ASSET_RULE_TEMPLATE = 'Asset sourcing: run at least 6 varied search_assets queries per piece, get_asset_thumbnail and '
  + 'get_asset_details for every shortlisted candidate; scripts, triangle counts and bad pivots are fixable (insert in Edit mode, '
  + 'strip scripts, rescale), so reject a candidate only after seeing it in the scene, with a reason. Never insert during a playtest. '
  + 'Record queries and candidates in docs/<scope>/VISUAL_GATE.md.';

/** Project root of a session: the working directory service, else the header cwd. */
export function projectRoot(ctx, session) {
  try {
    const dir = ctx?.get?.('workingDirectory')?.get?.(session);
    if (typeof dir === 'string' && dir !== '') return dir;
  } catch { /* fall back */ }
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
}

/** Whether the visual gate applies to this project. */
export function gateEnabled(root, mode = 'auto') {
  if (mode === 'off' || root === undefined) return false;
  if (mode === 'on') return true;
  return gateScopes(root).length > 0;
}

/** Run the project's own tools/check-visual-gate.mjs when it has one. */
export function runProjectScript(root) {
  const script = path.join(root, 'tools', 'check-visual-gate.mjs');
  if (!existsSync(script)) return undefined;
  const run = spawnSync(process.execPath, [script], {
    cwd: root, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split(/\r?\n/).slice(-12).join('\n');
  return { status: run.error ? -1 : run.status ?? -1, output: run.error ? String(run.error.message ?? run.error) : output };
}

/** Full gate evaluation: bundled checks plus the project's own script. */
export function evaluateGate(root, { runScript = runProjectScript } = {}) {
  const result = checkVisualGate(root);
  const problems = result.gates.flatMap(gate => gate.problems.map(problem => (gate.scope ? `docs/${gate.scope}/${GATE_FILE}: ${problem}` : problem)));
  const script = runScript(root);
  if (script !== undefined && script.status !== 0) problems.push(`tools/check-visual-gate.mjs exited ${script.status}: ${script.output}`);
  return { ok: problems.length === 0, problems, gates: result.gates, script };
}

/** Newest client-source or asset change, in ms. */
export function lastVisualChange(root, gates, assetChanges = []) {
  const folders = new Set(DEFAULT_CLIENT_SOURCE);
  for (const gate of gates ?? []) for (const folder of gate.gate?.clientSource ?? []) folders.add(folder);
  const disk = root === undefined ? { time: 0 } : latestChange(root, [...folders]);
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
      problems.push(`the route ${routeLabel(args ?? {})} is not a ${parsedRole.role}/${parsedRole.tier} route `
        + `(expected ${routes.map(routeLabel).join(' or ')})`);
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
    + 'review with screenshot paths; it records "Verdict: PASS|FAIL", the checklist and the screenshots there.', 'VISUAL_GATE_FILE_OWNED');
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
      if (unlogged.length > 0) problems.push(`piece "${piece.name}": queries never run with search_assets: ${unlogged.join('; ')}`);
      for (const candidate of piece.candidates) {
        if (candidate.id === undefined) continue;
        if (/^(?:yes|viewed|seen|true)$/i.test(candidate.fields.thumbnail ?? '') && !thumbnails.has(candidate.id)) {
          problems.push(`piece "${piece.name}" candidate ${candidate.id}: no get_asset_thumbnail call in any log`);
        }
        if (/^(?:yes|viewed|read|seen|true)$/i.test(candidate.fields.details ?? '') && !details.has(candidate.id)) {
          problems.push(`piece "${piece.name}" candidate ${candidate.id}: no get_asset_details call in any log`);
        }
      }
    }
  }
  return problems;
}

/**
 * Decide `update_goal complete` for a visual objective.
 * @param input.root - project root.
 * @param input.objective - current goal objective.
 * @param input.lead - the coordinator's folded session state.
 * @param input.workers - worker audit rows (`{ name, audit }`).
 * @param input.runScript - project script runner (test seam).
 */
export function completionDenial({ root, objective, lead, workers = [], runScript }) {
  if (typeof objective !== 'string' || !VISUAL_OBJECTIVE.test(objective)) return undefined;
  const problems = [];
  const gate = evaluateGate(root, { runScript });
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
  const lastShot = lead.screenshots.length > 0 ? Math.max(...lead.screenshots.map(shot => shot.time ?? 0)) : 0;
  if (lead.screenshots.length === 0) {
    problems.push('you have not viewed a screenshot yourself this session (screen_capture, capture_screenshot, capture_device_matrix, or read_image on a captured file)');
  } else if (lastShot <= change.time) {
    problems.push(`your last screenshot predates ${change.what}; look again`);
  }
  const visualDispatches = lead.dispatchLog.filter(entry => entry.role === 'visual' && (entry.tier === 'standard' || entry.tier === 'expert')
    && hasVisualRef(entry.prompt));
  const lastWork = lead.dispatchLog.reduce((latest, entry, index) => (entry.role !== 'visual' && VISUAL_WORK.test(entry.prompt) ? index : latest), -1);
  const reviewedAfter = lead.dispatchLog.some((entry, index) => index > lastWork && visualDispatches.includes(entry));
  if (!reviewedAfter) problems.push('no visual/standard or visual/expert review with screenshot paths was dispatched after the last visual work');
  const reviewers = new Set(visualDispatches.map(entry => entry.name).filter(Boolean));
  for (const result of gate.gates) {
    const named = result.gate?.reviewer;
    if (named !== undefined && !reviewers.has(named)) {
      problems.push(`docs/${result.scope}/${GATE_FILE} names reviewer "${named}", which is not a visual worker you dispatched`);
    } else if (named !== undefined) {
      const row = workers.find(worker => worker.name === named);
      if (row?.audit?.assets !== undefined && row.audit.assets.screenshots === 0) {
        problems.push(`reviewer "${named}" never viewed a screenshot (roblox_screenshots view, a capture tool, or read_image on a capture)`);
      }
    }
  }
  problems.push(...gate.problems);
  problems.push(...assetEvidenceProblems(gate.gates, evidence));
  if (problems.length === 0) return undefined;
  return deny(`Roblox visual gate FAILED: the objective is visual, so the goal cannot complete (${problems.join('; ')}). `
    + 'Report "visual gate FAILED" with these reasons, get fresh screenshots, dispatch a visual review, and retry.', 'VISUAL_GATE_FAILED');
}

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
 * @param input.lookedSinceChange - whether the coordinator viewed a screenshot after the last change.
 */
export function replyCorrections({ reply, dispatched = [], gate, lookedSinceChange = true, newCaptures = [] }) {
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
    const visualClaim = VISUAL_OBJECTIVE.test(reply) && CLAIM.test(reply);
    if (!gate.ok && (STATUS.test(reply) || visualClaim) && !/visual gate FAILED/i.test(firstLine)) {
      out.push(`The visual gate is FAILED (${gate.problems.slice(0, 4).join('; ')}). Open the report with "visual gate FAILED" `
        + 'and the reasons; do not call the visuals done, good or ready.');
    } else if (gate.ok && visualClaim && !lookedSinceChange) {
      out.push('You called the visuals done/good/ready without viewing a screenshot since the last change. A worker\'s rating is not '
        + 'evidence: view a capture yourself (read_image on the captured file) before making that claim, or withdraw it.');
    }
  }
  return out;
}
