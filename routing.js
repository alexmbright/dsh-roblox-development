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
      + `(missing: ${missing.join(', ')}). Choose the assignment's role/tier route from routes.json `
      + 'roles.<role>.<tier>, confirm it with list_subagent_models, then dispatch the exact triple.',
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
    + 'routes.json role-tier matrix. Dispatch a matrix route from routes.json roles.<role>.<tier>, or record '
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
  return execution => {
    const verdict = evaluateDispatch(execution, policy);
    if (verdict.kind === 'deny') return { reason: verdict.reason, info: verdict.info };
    if (verdict.kind === 'fallback') {
      log(`[roblox-routing-guard] capacity fallback: route ${verdict.route.provider}/${verdict.route.model} `
        + `effort=${verdict.route.reasoning_effort} — ${verdict.fallbackReason}`);
    }
    return undefined;
  };
}

/** Mount the guard in the calling scope; the disposer unregisters it. */
export function apply(ctx) {
  return ctx.tools.guard(createGuard(loadPolicy(loadRoutes())));
}
