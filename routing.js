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
 * @module @alexmbright/dsh-roblox-development/routing
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  const dispose = ctx.tools.guard(execution => {
    // The guard runs on every tool call in this scope; a policy failure must never surface as
    // a thrown tool error, so it degrades to "no routing opinion" with a warning.
    // Belt and braces: whatever session this dispatch belongs to is registered too.
    allowToolchain(ctx, execution?.agent?.session, allowed);
    try {
      return guard(execution);
    } catch (error) {
      console.warn(`[roblox-routing-guard] policy unavailable, dispatch not routed: ${error?.message ?? error}`);
      return undefined;
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

  const off = ctx.on?.('roblox-routing/changed', () => { /* compile() reads fresh state */ });
  return () => {
    off?.();
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
