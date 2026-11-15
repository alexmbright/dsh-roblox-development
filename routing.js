/**
 * Role-tier dispatch guard for native subagent delegation.
 *
 * A separate package export so the Roblox preset can mount enforcement without
 * touching the compatibility listener in index.js. Registers one monotonic
 * `ctx.tools.guard` denial (DSH 0.2.2-rc.3 `@deepseek-ai/dsh-tools` contract:
 * `(execution) => string | ToolGuardDenial | undefined`, evaluated after
 * pre-execute policy and before the tool body, deny-only so no listener can
 * turn a denial back into permission).
 *
 * Policy comes from routes.json `dispatchGuard` plus the role/tier matrix in
 * `roles`: every worker dispatch must name an explicit provider, model and
 * reasoning_effort drawn from that matrix. Off-matrix dispatch survives only
 * through the recorded capacity-fallback opt-in, which is logged. Fork
 * dispatch is denied outright because forked children always inherit the
 * captain model and cannot carry a tier route. The guard never mutates a call,
 * never switches models, and never touches DSH access controls.
 * @module @alexturbo/dsh-roblox-development/routing
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadBrain, createSkillGuard, registerAuditTool, createEvidenceStore, isSkillGated, sessionState, parseRole, baseToolName } from './skill-policy.js';
import { statusContext } from './coordination.js';
import {
  projectRoot, gateEnabled, dispatchDenial, gateFileEditDenial, playtestInsertDenial, completionDenial,
  evaluateGate, lastVisualChange, finalReply, replyCorrections,
} from './visual-policy.js';
import { registerScreenshotTool, collectTree } from './screenshots.js';

export const inject = ['tools'];

/** Load the bundle's routes.json policy from beside this module. */
export function loadRoutes() {
  return JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'));
}

/**
 * Compile routes.json into the guard policy: exact dispatch names, the
 * required explicit route fields, the fallback marker, and the deduplicated
 * role/tier route matrix.
 * @param routes - Parsed routes.json content.
 * @returns the compiled dispatch policy.
 */
export function loadPolicy(routes) {
  const block = routes.dispatchGuard;
  if (block === undefined || typeof block !== 'object') {
    throw new Error('routes.json requires a dispatchGuard block for routing enforcement');
  }
  const requiredRouteFields = [...block.requiredRouteFields];
  if (requiredRouteFields.length === 0
    || requiredRouteFields.some(field => typeof field !== 'string' || field.length === 0)) {
    throw new Error('routes.json dispatchGuard.requiredRouteFields must name the explicit route fields');
  }
  const seen = new Set();
  const matrix = [];
  for (const [role, tiers] of Object.entries(routes.roles ?? {})) {
    for (const [tier, entries] of Object.entries(tiers ?? {})) {
      for (const entry of entries ?? []) {
        for (const field of requiredRouteFields) {
          if (typeof entry[field] !== 'string' || entry[field].length === 0) {
            throw new Error(`routes.json roles.${role}.${tier} route requires explicit ${field}`);
          }
        }
        const key = requiredRouteFields.map(field => entry[field]).join('\0');
        if (seen.has(key)) continue;
        seen.add(key);
        matrix.push(Object.fromEntries(requiredRouteFields.map(field => [field, entry[field]])));
      }
    }
  }
  return {
    spawnTools: [...block.spawnTools],
    forkTools: [...block.forkTools],
    requiredRouteFields,
    capacityFallbackArgument: block.capacityFallbackArgument,
    matrix,
  };
}

/** Stable switch identity for one route; dots and slashes would read as path segments. */
export const routeKey = route => `${route.provider}-${route.model}-${route.reasoning_effort}`.replace(/[^A-Za-z0-9_-]/g, '-');

/**
 * Compose the route briefing the lead reads: every enabled role/tier cell with the model it
 * actually dispatches and the purpose recorded for it.
 * @param roles - Grouped role/tier view from the bundle's routing state.
 * @returns the briefing text, or undefined when nothing is enabled.
 */
export function routesBriefing(roles) {
  const lines = [];
  for (const role of roles ?? []) {
    for (const tier of role.tiers ?? []) {
      if (tier.enabled === false) continue;
      const purpose = typeof tier.purpose === 'string' && tier.purpose !== '' ? `: ${tier.purpose}` : '';
      lines.push(`- ${tier.id} → ${tier.provider}/${tier.model} at ${tier.reasoning_effort}${purpose}`);
    }
  }
  if (lines.length === 0) return undefined;
  return [
    'Roblox routing: call roblox_routes before delegating to get the current role/tier routes, pick the one whose purpose matches the assignment, then pass its exact provider, model and reasoning_effort.',
    ...lines,
  ].join('\n');
}

/**
 * Build a policy from the published effective triples, keeping the shipped dispatch rules.
 * @param routes - Parsed routes.json content, source of the dispatch rules.
 * @param list - Effective provider/model/reasoning_effort triples.
 * @returns the compiled policy.
 */
export function policyFromTriples(routes, list) {
  const base = loadPolicy(routes);
  const matrix = list.map(triple => Object.fromEntries(
    base.requiredRouteFields.map(field => [field, triple[field]])));
  return { ...base, matrix };
}

const DENY_INFO = name => ({ name: 'roblox-routing-guard', code: name });
const deny = (reason, code) => ({ kind: 'deny', reason, info: { ...DENY_INFO(code), reason } });

/**
 * Decide one delegation dispatch against the compiled policy.
 * @param execution - Tool identity and model arguments (`name`, `arguments`).
 * @param policy - Compiled policy from {@link loadPolicy}.
 * @returns allow, an explicitly logged capacity-fallback pass, or a denial.
 */
export function evaluateDispatch(execution, policy) {
  const name = execution?.name;
  if (policy.forkTools.includes(name)) {
    return deny(
      'subagent_fork children inherit the captain model and cannot carry a tier route. '
      + 'Delegate with the subagent tool using provider, model and reasoning_effort from a routes.json role/tier.',
      'ROUTING_FORK_UNSUPPORTED');
  }
  if (!policy.spawnTools.includes(name)) return { kind: 'allow' };
  const args = execution?.arguments;
  const fields = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const missing = policy.requiredRouteFields
    .filter(field => typeof fields[field] !== 'string' || fields[field].trim().length === 0);
  if (missing.length > 0) {
    return deny(
      'Explicit child route required: supply provider, model and reasoning_effort together '
      + `(missing: ${missing.join(', ')}). Call roblox_routes to get the enabled role/tier routes, `
      + 'pick the one whose purpose matches the assignment, then dispatch that exact triple.',
      'ROUTING_ROUTE_REQUIRED');
  }
  const route = Object.fromEntries(policy.requiredRouteFields.map(field => [field, fields[field]]));
  const inMatrix = policy.matrix
    .some(candidate => policy.requiredRouteFields.every(field => candidate[field] === route[field]));
  if (inMatrix) return { kind: 'allow' };
  const fallback = fields[policy.capacityFallbackArgument];
  if (typeof fallback === 'string' && fallback.trim().length > 0) {
    return { kind: 'fallback', route, fallbackReason: fallback.trim() };
  }
  return deny(
    `Route "${route.provider}/${route.model}" at reasoning_effort "${route.reasoning_effort}" is outside the `
    + 'enabled role-tier matrix. Call roblox_routes for the current routes, dispatch one of those exact triples, or record '
    + `capacity fallback with ${policy.capacityFallbackArgument}: "<capacity reason>" on this call; off-matrix `
    + 'fallbacks are logged.',
    'ROUTING_OFF_MATRIX');
}

/**
 * Build the monotonic ToolGuard. Capacity-fallback passes are clearly logged;
 * everything else is allow or denial per {@link evaluateDispatch}.
 * @param policy - Compiled policy from {@link loadPolicy}.
 * @param options - Optional `log` sink for fallback records (default console.warn).
 * @returns a DSH ToolGuard for `ctx.tools.guard`.
 */
export function createGuard(policy, options = {}) {
  const log = options.log ?? (line => console.warn(line));
  const resolve = typeof policy === 'function' ? policy : () => policy;
  return execution => {
    const verdict = evaluateDispatch(execution, resolve());
    if (verdict.kind === 'deny') return { reason: verdict.reason, info: verdict.info };
    if (verdict.kind === 'fallback') {
      log(`[roblox-routing-guard] capacity fallback: route ${verdict.route.provider}/${verdict.route.model} `
        + `effort=${verdict.route.reasoning_effort} — ${verdict.fallbackReason}`);
    }
    return undefined;
  };
}

/**
 * Allow the shared toolchain directory in one session's sandbox.
 *
 * The binaries live once, in the profile's `roblox-toolchain` directory, outside the session
 * workspace. Executing them from there is an outside-workspace operation: the sandbox escalates
 * it, Auto review may deny it, and a denial becomes an approval prompt. Declaring the directory
 * as an ordinary writable root for the session removes the escalation, so a plain shell command
 * works without a prompt. `roblox_run_tool` remains the preferred path, but nothing has to
 * depend on it.
 * @param ctx - registrant context.
 * @param session - session whose sandbox should allow the toolchain.
 * @param allowed - per-session registration map, so each session registers once.
 */
function allowToolchain(ctx, session, allowed) {
  if (session === undefined || session === null) return;
  const key = session.id ?? session;
  if (allowed.has(key)) return;
  const sandbox = ctx.get('sandboxPolicy');
  if (typeof sandbox?.registerWritableRoot !== 'function') return;
  const fromService = ctx.get('robloxToolchain')?.current?.installRoot;
  const fromProfile = typeof ctx.get('profileContext')?.dir === 'string'
    ? path.join(ctx.get('profileContext').dir, 'roblox-toolchain')
    : undefined;
  const root = typeof fromService === 'string' && fromService !== '' ? fromService : fromProfile;
  if (typeof root !== 'string' || root === '') return;
  try {
    allowed.set(key, sandbox.registerWritableRoot(session, root));
  } catch (error) {
    // The directory may not exist yet during first-run provisioning; the ready event retries.
    allowed.set(key, undefined);
  }
}

/** Mount the guard in the calling scope; the disposer unregisters it. */
/**
 * Refuse a blocking wait from a coordinator.
 *
 * `wait_agent` parks the turn until a worker reports, which stops the operator from adding or
 * redirecting work while workers run. Completion already resumes the coordinator, so the wait
 * costs interactivity for nothing. Workers keep the tool: a worker waiting on its own children
 * is a legitimate use.
 * @param execution - the pending tool call.
 * @returns a denial for a non-subagent caller, else undefined.
 */
export function blockingWaitDenial(execution) {
  if (execution?.name !== 'wait_agent') return undefined;
  const origin = execution?.agent?.session?.header?.origin;
  if (origin === 'subagent') return undefined;
  return {
    reason: 'Do not block on workers. Say what is running and end your turn: completion wakes you, '
      + 'and a parked turn stops the operator from adding, reprioritising or redirecting work. '
      + 'Workers may wait on their own children.',
    info: { name: 'roblox-routing-guard', code: 'ROUTING_NO_BLOCKING_WAIT' },
  };
}

/** Tools the visual gate decides; everything else skips its filesystem checks. */
const VISUAL_GATED = new Set(['subagent', 'edit', 'write', 'apply_patch', 'update_goal', 'insert_asset', 'generate_model']);

/**
 * Build the visual-gate guard and the coordinator reply check.
 * @param options.ctx - registrant context (workingDirectory, goals).
 * @param options.brain - pinned brain, for the folded session state.
 * @param options.evidence - worker evidence store.
 * @param options.roleRoutes - `(role, tier) => routes[] | undefined`.
 * @param options.mode - `auto` (marker file), `on` or `off`.
 * @param options.runScript - project gate script runner (test seam).
 */
export function createVisualGuard({ ctx, brain, evidence, roleRoutes = () => undefined, mode = 'auto', runScript,
  previews = 'on', collect = collectTree }) {
  const guard = execution => {
    const name = baseToolName(execution?.name);
    if (!VISUAL_GATED.has(name)) return undefined;
    const session = execution?.agent?.session;
    if (session === undefined || session === null) return undefined;
    const root = projectRoot(ctx, session);
    if (!gateEnabled(root, mode)) return undefined;
    const args = execution.arguments ?? {};
    const state = sessionState(session, brain);
    const worker = session.header?.origin === 'subagent';
    if (name === 'subagent') {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      return dispatchDenial(prompt, args, parseRole(prompt), roleRoutes);
    }
    if (name === 'edit' || name === 'write' || name === 'apply_patch') {
      return gateFileEditDenial(args.file_path ?? args.path, worker, state.role);
    }
    if (name === 'insert_asset' || name === 'generate_model') return playtestInsertDenial(name, state);
    if (name === 'update_goal' && args.action === 'complete' && !worker) {
      let objective;
      try {
        objective = ctx.get('goals')?.get?.(execution.agent)?.objective;
      } catch { /* no goal service: nothing to judge */ }
      const leadId = session.id ?? execution.agent.id;
      const workers = evidence?.rows(leadId) ?? [];
      return completionDenial({ root, objective, lead: state, workers, runScript });
    }
    return undefined;
  };

  const corrected = new Set();
  // Per lead: capture time already offered to the operator. Starts at the first turn seen, so a
  // resumed session is not asked to replay its whole history.
  const shownUntil = new Map();
  const newCapturesFor = async (agent, leadId, signal) => {
    if (previews === 'off') return [];
    const since = shownUntil.get(leadId);
    let captures = [];
    try {
      captures = (await collect(ctx, agent, signal)).captures;
    } catch { /* previews are best-effort */ }
    const newest = captures.reduce((latest, capture) => Math.max(latest, capture.time), since ?? 0);
    shownUntil.set(leadId, newest);
    if (since === undefined) return [];
    return captures.filter(capture => capture.time > since).map(capture => capture.id);
  };
  const turnStopping = async ({ agent, turn, signal }) => {
    const session = agent?.session;
    if (session === undefined || session?.header?.origin === 'subagent') return;
    const key = `${session.id ?? agent.id}:${turn}`;
    if (corrected.has(key)) return;
    const newCaptures = await newCapturesFor(agent, session.id ?? agent.id, signal);
    const state = sessionState(session, brain);
    const dispatched = state.dispatchLog.filter(entry => entry.turn === turn);
    const root = projectRoot(ctx, session);
    let gate;
    let lookedSinceChange = true;
    if (gateEnabled(root, mode)) {
      gate = evaluateGate(root, { runScript: () => undefined });
      const change = lastVisualChange(root, gate.gates, state.assets.changes);
      const lastShot = state.screenshots.reduce((latest, shot) => Math.max(latest, shot.time ?? 0), 0);
      lookedSinceChange = lastShot > change.time;
    }
    if (dispatched.length === 0 && gate === undefined && newCaptures.length === 0) return;
    const corrections = replyCorrections({ reply: finalReply(session, turn), dispatched, gate, lookedSinceChange, newCaptures });
    if (corrections.length === 0 || typeof agent.steer !== 'function') return;
    corrected.add(key);
    agent.steer({
      content: [{ type: 'text', text: `Roblox mode: before ending this turn, send a corrected reply.\n- ${corrections.join('\n- ')}` }],
      source: { kind: 'roblox-visual-gate' },
    });
  };
  return { guard, turnStopping };
}

export function apply(ctx, config) {
  const service = () => ctx.get('robloxRouting');
  const fallback = () => normalizeState(config);

  // routes.json is shipped with the bundle and never changes at runtime, so it is read once.
  let routesCache;
  const shippedRoutes = () => (routesCache ??= loadRoutes());

  /**
   * Compile the active policy. The state row publishes asynchronously, so an absent service or
   * an empty published list before its first pass means "not computed yet" and falls back to
   * the shipped matrix. An empty list *with* published roles is the operator's own choice and
   * is honoured, rather than silently re-allowing every shipped route.
   */
  const compile = () => {
    const holder = service();
    if (typeof holder?.triples !== 'function') return loadPolicy(shippedRoutes());
    const published = holder.triples();
    if (!Array.isArray(published)) return loadPolicy(shippedRoutes());
    if (published.length === 0) {
      const known = holder.roles?.() ?? [];
      if (Array.isArray(known) && known.length > 0) {
        return { ...loadPolicy(shippedRoutes()), matrix: [] };
      }
      return loadPolicy(shippedRoutes());
    }
    return policyFromTriples(shippedRoutes(), published);
  };

  const allowed = new Map();
  /**
   * Register the toolchain for every live session. Called at mount, whenever a session appears
   * or receives a message (both happen before its first tool call, so a brand-new session is
   * covered before it can run anything), and again whenever provisioning settles.
   */
  const allowAllSessions = () => {
    const agents = ctx.get('agents');
    let live;
    try {
      live = agents?.list?.() ?? [];
    } catch {
      live = [];
    }
    for (const agent of live) allowToolchain(ctx, agent?.session, allowed);
    allowToolchain(ctx, agents?.currentInitiator?.()?.session, allowed);
  };
  allowAllSessions();
  const offLifecycle = [
    ctx.on?.('roblox-toolchain/ready', allowAllSessions),
    ctx.on?.('agent/status', allowAllSessions),
    ctx.on?.('agent/inbox/inserted', allowAllSessions),
    ctx.on?.('agent-preset/selected', allowAllSessions),
  ].filter(handler => typeof handler === 'function');

  let warnedMissingService = false;
  const guard = createGuard(() => {
    const state = compile();
    if (!warnedMissingService && typeof service()?.triples !== 'function') {
      warnedMissingService = true;
      console.warn('[roblox-routing-guard] routing state service not visible in this scope; '
        + 'enforcing the shipped routes.json matrix. Settings edits will not apply.');
    }
    return state;
  });
  let skillGuard;
  let skillError;
  let brain;
  let evidence;
  try {
    brain = loadBrain();
    evidence = createEvidenceStore({ brain, ctx });
    skillGuard = createSkillGuard({
      brain,
      evidence,
      parentNameOf: agent => ctx.get('subagents')?.namesOf?.(agent)?.parent,
    });
  } catch (error) {
    skillError = error?.message ?? String(error);
    console.warn(`[roblox-skill-guard] pinned brain unreadable: ${skillError}`);
  }

  const roleRoutes = (role, tier) => {
    const roles = service()?.roles?.();
    if (!Array.isArray(roles) || roles.length === 0) {
      const shipped = shippedRoutes().roles?.[role]?.[tier];
      return Array.isArray(shipped) ? shipped : undefined;
    }
    const cell = roles.find(entry => entry.role === role)?.tiers?.find(entry => entry.id === `${role}/${tier}` && entry.enabled !== false);
    return cell === undefined ? [] : [cell];
  };
  let visual;
  if (brain !== undefined) {
    const mode = ['on', 'off'].includes(config?.visualGate) ? config.visualGate : 'auto';
    const previews = config?.screenshotPreviews === 'off' ? 'off' : 'on';
    visual = createVisualGuard({ ctx, brain, evidence, roleRoutes, mode, previews });
  }
  const offTurn = visual === undefined ? undefined : ctx.on?.('agent/turn-stopping', async payload => {
    try {
      await visual.turnStopping(payload);
    } catch (error) {
      console.warn(`[roblox-visual-gate] reply check failed: ${error?.message ?? error}`);
    }
  });

  const dispose = ctx.tools.guard(execution => {
    // A coordinator must not park the turn waiting on workers.
    const blocking = blockingWaitDenial(execution);
    if (blocking !== undefined) return blocking;

    // The guard runs on every tool call in this scope; a policy failure must never surface as
    // a thrown tool error, so it degrades to "no routing opinion" with a warning.
    // Belt and braces: whatever session this dispatch belongs to is registered too.
    allowToolchain(ctx, execution?.agent?.session, allowed);
    let routed;
    try {
      routed = guard(execution);
    } catch (error) {
      console.warn(`[roblox-routing-guard] policy unavailable, dispatch not routed: ${error?.message ?? error}`);
    }
    if (routed !== undefined) return routed;

    // Skill enforcement fails closed for the calls it governs (dispatch, edits, contract changes,
    // goal completion) and never touches questions or lookups.
    if (visual !== undefined) {
      try {
        const verdict = visual.guard(execution);
        if (verdict !== undefined) return verdict;
      } catch (error) {
        console.warn(`[roblox-visual-gate] check failed, call refused: ${error?.message ?? error}`);
        return {
          reason: `Roblox visual gate could not verify this call (${error?.message ?? error}). Retry; reading and answering remain available.`,
          info: { name: 'roblox-visual-gate', code: 'VISUAL_POLICY_UNAVAILABLE' },
        };
      }
    }
    if (!isSkillGated(execution)) return undefined;
    const unavailable = detail => ({
      reason: `Roblox skill policy could not verify this call (${detail}). Retry; if it persists, reinstall the bundle `
        + 'and report it. Reading, searching and answering remain available.',
      info: { name: 'roblox-skill-guard', code: 'SKILLS_POLICY_UNAVAILABLE' },
    });
    if (skillGuard === undefined) return unavailable(skillError);
    try {
      return skillGuard(execution);
    } catch (error) {
      console.warn(`[roblox-skill-guard] check failed, call refused: ${error?.message ?? error}`);
      return unavailable(error?.message ?? String(error));
    }
  });

  /** Current briefing text; evaluated per assembly so edits apply without re-registering. */
  const briefing = () => routesBriefing(service()?.roles?.() ?? [])
    ?? 'Roblox routing: no role/tier route is enabled for this profile.';

  // Inject the route purposes into the lead's prompt. Operator text is plain prose, so it must
  // not be treated as a template: a stray {{...}} would abort prompt assembly.
  const prompt = ctx.get('systemPrompt');
  let dropSection;
  if (prompt !== undefined && typeof prompt.section === 'function') {
    try {
      dropSection = prompt.section({
        name: 'roblox-routing',
        order: typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('ROBLOX_ROUTING') : 900,
        text: briefing,
        interpolate: false,
      });
    } catch (error) {
      console.warn(`[roblox-routing-guard] prompt section unavailable: ${error?.message ?? error}`);
    }
  }

  // The lookup tool is a convenience: it must never be able to fail this plugin, because a
  // rejected apply fails the whole preset mount. Registered fire-and-forget, logged on failure.
  let removeTool;
  try {
    removeTool = registerRoutesTool(ctx, service);
  } catch (error) {
    console.warn(`[roblox-routing-guard] roblox_routes unavailable: ${error?.message ?? error}`);
  }

  // Skill audit tool: same fire-and-forget posture as roblox_routes.
  let removeAudit;
  if (brain !== undefined) {
    try {
      removeAudit = registerAuditTool(ctx, brain, evidence);
    } catch (error) {
      console.warn(`[roblox-skill-guard] roblox_skill_audit unavailable: ${error?.message ?? error}`);
    }
  }
  // Shared screenshot tool: same fire-and-forget posture.
  let removeScreenshots;
  try {
    removeScreenshots = registerScreenshotTool(ctx, session => projectRoot(ctx, session));
  } catch (error) {
    console.warn(`[roblox-screenshots] roblox_screenshots unavailable: ${error?.message ?? error}`);
  }

  // Worker lifecycle feeds both the acceptance evidence and the coordinator status context.
  // Evidence is captured at settlement because the worker's live handle is disposed around then.
  const offWorkers = evidence === undefined ? [] : [
    ctx.on?.('subagent/start', info => evidence.start(info)),
    ctx.on?.('subagent/end', info => { void evidence.end(info); }),
  ].filter(handler => typeof handler === 'function');
  let dropStatus;
  if (prompt !== undefined && typeof prompt.context === 'function') {
    let order = 950;
    try {
      if (typeof prompt.getContextOrder === 'function') order = prompt.getContextOrder('SUBAGENT_DELEGATION') + 1;
    } catch { /* keep the fallback order */ }
    try {
      dropStatus = prompt.context({
        name: 'roblox-worker-status',
        order,
        interpolate: false,
        text: context => {
          // Contexts receive the assembling agent (dsh-tool-subagent relies on the same field); the
          // scope key is that agent too, so it is the fallback.
          const agent = context?.agent ?? context?.scope;
          const session = agent?.session;
          if (evidence === undefined || session === undefined || session?.header?.origin === 'subagent') return '';
          const routes = new Map();
          try {
            for (const entry of sessionState(session, brain).dispatchLog) if (entry.name) routes.set(entry.name, entry);
          } catch { /* status without routes */ }
          return statusContext(evidence.view(session.id ?? agent.id), routes);
        },
      });
    } catch (error) {
      console.warn(`[roblox-routing-guard] worker status context unavailable: ${error?.message ?? error}`);
    }
  }

  const off = ctx.on?.('roblox-routing/changed', () => { /* compile() reads fresh state */ });
  return () => {
    off?.();
    offTurn?.();
    for (const disposeWorker of offWorkers) disposeWorker();
    dropStatus?.();
    removeAudit?.();
    removeScreenshots?.();
    for (const disposeLifecycle of offLifecycle) disposeLifecycle();
    removeTool?.();
    dropSection?.();
    dispose?.();
    for (const disposeRoot of allowed.values()) {
      if (typeof disposeRoot === 'function') disposeRoot();
    }
    allowed.clear();
  };
}

/**
 * Register the `roblox_routes` tool: the same role/tier purposes the briefing carries,
 * queryable per role so the lead can look up one decision instead of reading the whole matrix.
 *
 * The definition is built directly rather than through `defineTool`: `ctx.tools.register` needs
 * only a name, a renderable output schema and an execute body, and importing
 * `@deepseek-ai/dsh-tools` from a linked checkout fails, which silently removed the tool.
 * @param ctx - registrant context.
 * @param service - accessor for the bundle-level routing service.
 * @returns the disposer, or undefined when tools are unavailable.
 */
function registerRoutesTool(ctx, service) {
  if (typeof ctx.tools?.register !== 'function') return undefined;
  return ctx.tools.register({
    name: 'roblox_routes',
    description: 'List the Roblox routing role/tier cells with the model each dispatches and the purpose it exists for. '
      + 'Call before delegating a worker so the assignment matches the intended tier.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: {
          type: 'string',
          description: 'Optional role to narrow the answer, such as planner, scout, implementer, reviewer, qa, studio or visual.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          routes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cell: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                reasoning_effort: { type: 'string' },
                purpose: { type: 'string' },
                source: { type: 'string' },
              },
              required: ['cell', 'provider', 'model', 'reasoning_effort', 'purpose', 'source'],
            },
          },
          count: { type: 'integer' },
        },
        required: ['routes', 'count'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args) {
      const wanted = typeof args?.role === 'string' && args.role.trim() !== '' ? args.role.trim() : undefined;
      const rows = [];
      for (const role of service()?.roles?.() ?? []) {
        if (wanted !== undefined && role.role !== wanted) continue;
        for (const tier of role.tiers ?? []) {
          if (tier.enabled === false) continue;
          rows.push({
            cell: tier.id,
            provider: tier.provider,
            model: tier.model,
            reasoning_effort: tier.reasoning_effort,
            source: tier.source ?? 'unset',
            purpose: tier.purpose ?? '',
          });
        }
      }
      return { routes: rows, count: rows.length };
    },
  });
}

/** Local fallback when the bundle-level row is not mounted. */
function normalizeState(config) {
  return config !== null && typeof config === 'object' ? config : {};
}
