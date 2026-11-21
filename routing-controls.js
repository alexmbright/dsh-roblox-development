/**
 * Bundle-level routing state: one model choice, one switch and one description per
 * role/tier cell.
 *
 * The dispatch guard lives inside the Roblox agent preset, so this bundle-level row owns the
 * profile's routing state and publishes the *effective* matrix to that guard over the
 * `robloxRouting` service and a `roblox-routing/changed` event.
 *
 * A cell's model is the profile's stored choice. routes.json ships no models: a fresh install
 * seeds every cell with the operator's main model, which keeps it usable before anyone edits
 * anything.
 * @module @alexturbo/dsh-roblox-development/routing-controls
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadRoutes, routeKey } from './routing.js';
import { readJson, writeJson, rejectBrowserRequest } from './http-bridge.js';
import { mountScreenshotBridge } from './screenshot-bridge.js';
import { mountOpenCloudBridge } from './open-cloud-bridge.js';
import { applyProfileChange } from './apply-profile.js';

const BRIDGE_PREFIX = '/api/roblox-controls';
const ROUTE_FIELDS = ['provider', 'model', 'reasoning_effort'];
const ROLES = ['planner', 'scout', 'implementer', 'reviewer', 'qa', 'studio', 'visual'];

/** Plugin-owned state under the DSH home; written atomically by the bridge. */
/**
 * Resolve the state file for the profile this row is active in.
 *
 * `DSH_PROFILE_DIR` is injected into shells, not into the plugin process, so reading it here
 * silently fell back to a machine-global file. The profile directory comes from
 * `profileContext`, which the host does provide.
 * @param ctx - registrant context.
 * @returns the absolute state-file path.
 */
function stateFile(ctx) {
  const fromContext = ctx?.get?.('profileContext')?.dir ?? ctx?.profileContext?.dir;
  if (typeof fromContext === 'string' && fromContext !== '') return path.join(fromContext, 'roblox-routing.json');
  const home = process.env.DSH_HOME ?? '';
  const base = home === '' ? path.join(homedir(), '.dsh') : home;
  const profile = process.env.DSH_PROFILE ?? '';
  return profile === ''
    ? path.join(base, 'roblox-routing.json')
    : path.join(base, 'profiles', profile, 'roblox-routing.json');
}

/** The state file for the active mount. */
let STATE_FILE = path.join(homedir(), '.dsh', 'roblox-routing.json');

let current = { disabledCells: [], overrides: {}, descriptions: {} };
let effective = { roles: [], triples: [], models: [] };

// Deliberately empty: this row owns routing state and must run wherever the guard runs.
// The HTTP bridge is mounted separately, only where a web carrier exists.
export const inject = [];

/** @returns a detached copy of the active configuration. */
export const snapshot = () => structuredClone(current);

/** @returns the triples the guard should allow right now. */
export const triples = () => effective.triples.map(triple => ({ ...triple }));

/** @returns the grouped role/tier view the panel renders. */
export const roles = () => effective.roles.map(role => ({ ...role, tiers: role.tiers.map(tier => ({ ...tier })) }));

/** Read any accepted shape, keeping only well-formed members. */
export function normalize(config) {
  const list = value => (Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '') : []);
  const overrides = {};
  for (const [key, value] of Object.entries(config?.overrides ?? {})) {
    if (value !== null && typeof value === 'object'
      && ROUTE_FIELDS.every(field => typeof value[field] === 'string' && value[field].trim() !== '')) {
      overrides[key] = {
        ...Object.fromEntries(ROUTE_FIELDS.map(field => [field, value[field].trim()])),
        ...(value.auto === true ? { auto: true } : {}),
      };
    }
  }
  const descriptions = {};
  for (const [key, value] of Object.entries(config?.descriptions ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') descriptions[key] = value.trim().slice(0, 500);
  }
  return {
    disabledCells: [...new Set(list(config?.disabledCells))],
    overrides,
    descriptions,
  };
}

/**
 * Choose the model every cell starts on at first install.
 *
 * The operator's own default selection wins, then the first connected model. Nothing is
 * inherited from routes.json: its models are shipped documentation, not a default this
 * profile should dispatch on someone else's behalf.
 * @param ctx - registrant context.
 * @param models - the connected catalog.
 * @returns a provider/model/effort triple, or undefined when nothing is connected.
 */
function firstInstallModel(ctx, models) {
  if (models.length === 0) return undefined;
  let main;
  try {
    main = ctx.get('agentDefaultModel')?.currentSelection?.();
  } catch {
    main = undefined;
  }
  const byKey = new Map(models.map(entry => [`${entry.provider}/${entry.model}`, entry]));
  const chosen = main !== undefined && byKey.has(`${main.provider}/${main.model}`)
    ? byKey.get(`${main.provider}/${main.model}`)
    : models[0];
  // The service reports `reasoningEffort`; accept either spelling rather than guessing.
  const wanted = typeof main?.reasoningEffort === 'string' ? main.reasoningEffort
    : typeof main?.reasoning_effort === 'string' ? main.reasoning_effort
    : '';
  return {
    provider: chosen.provider,
    model: chosen.model,
    reasoning_effort: effortFor(chosen, wanted === '' ? 'high' : wanted),
    auto: true,
  };
}

/** Whether every shipped cell already carries an explicit choice. */
function allCellsChosen() {
  return shippedCells().every(cell => current.overrides[cell.id] !== undefined);
}

/**
 * Ensure every cell has a stored model choice.
 *
 * The panel is the single source of truth: routes.json supplies the role/tier structure and
 * the purposes, never the model. Any cell without a stored choice is filled from the
 * first-install rule (the operator's default selection, else the first connected model) and
 * saved, so a legacy state file becomes complete without discarding existing choices.
 * @param ctx - registrant context.
 * @returns when the state is complete.
 */
let filling;
function ensureCells(ctx) {
  filling ??= (async () => {
    if (allCellsChosen()) return;
    const chosen = firstInstallModel(ctx, await catalog(ctx.get('llm')));
    if (chosen === undefined) return;
    for (const cell of shippedCells()) {
      if (current.overrides[cell.id] === undefined) current.overrides[cell.id] = { ...chosen };
    }
    const saved = saveState(current);
    // The profile's model allow-list is built from this file, and before the first seed it is
    // empty (subagent model selection stays off). Recompose now so the seeded main model becomes
    // dispatchable without a restart. Not awaited: it queues behind any reconcile in progress.
    if (saved.ok) void applyProfileChange(ctx);
  })().catch(error => console.warn(`[roblox-routing] could not seed cell defaults: ${error?.message ?? error}`));
  return filling;
}

/** Seed every cell once, so a fresh install starts from a real model instead of routes.json. */
async function seedFirstInstall(ctx, llm) {
  const chosen = firstInstallModel(ctx, await catalog(llm));
  if (chosen === undefined) return undefined;
  const overrides = {};
  for (const cell of shippedCells()) overrides[cell.id] = { ...chosen };
  return { disabledCells: [], overrides, descriptions: {} };
}

/** Every provider/model this installation can dispatch, with the efforts each declares. */
async function catalog(llm) {
  if (llm === undefined) return [];
  const out = [];
  let providers = [];
  try {
    providers = llm.listProviders();
  } catch {
    return [];
  }
  for (const provider of providers) {
    let models = [];
    try {
      models = await llm.listModels(provider.id);
    } catch {
      continue;
    }
    for (const model of models) {
      let efforts = [];
      let fallbackEffort;
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id);
        const declared = info?.reasoning?.efforts ?? [];
        efforts = declared.map(effort => effort.id);
        fallbackEffort = info?.reasoning?.defaultEffort;
      } catch {
        // An unreadable model stays selectable; effort falls back to the stored one.
      }
      out.push({
        provider: provider.id,
        model: model.id,
        label: `${provider.name ?? provider.id} / ${model.name ?? model.id}`,
        efforts,
        fallbackEffort,
      });
    }
  }
  return out;
}

/** The shipped cells, in role order, each with the purpose it documents. */
function shippedCells() {
  const routes = loadRoutes();
  const cells = [];
  for (const role of ROLES) {
    const tiers = routes.roles?.[role];
    if (tiers === undefined) continue;
    for (const [tier, entries] of Object.entries(tiers)) {
      const entry = (entries ?? [])[0];
      if (entry === undefined) continue;
      cells.push({
        id: `${role}/${tier}`,
        role,
        tier,
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
      });
    }
  }
  return cells;
}

/** Choose the effort for one cell: the requested one when the model declares it. */
function effortFor(entry, wanted) {
  if (entry === undefined || entry.efforts.length === 0) return wanted;
  if (wanted !== '' && entry.efforts.includes(wanted)) return wanted;
  if (entry.defaultEffort !== undefined && entry.efforts.includes(entry.defaultEffort)) return entry.defaultEffort;
  if (entry.efforts.includes('high')) return 'high';
  return entry.efforts[0];
}

/** Resolve the effective matrix from stored choices and what is connected. */
async function recompute(llm) {
  const models = await catalog(llm);
  const byKey = new Map(models.map(entry => [`${entry.provider}/${entry.model}`, entry]));
  const groups = new Map(ROLES.map(role => [role, []]));
  const triples = [];

  for (const [index, cell] of shippedCells().entries()) {
    const override = current.overrides[cell.id];
    // Only the stored choice counts. A cell without one is reported unset: routes.json ships no
    // models, and nothing is picked by position in the catalog.
    const chosen = override === undefined
      ? undefined
      : { provider: override.provider, model: override.model };
    const entry = chosen === undefined ? undefined : byKey.get(`${chosen.provider}/${chosen.model}`);
    if (chosen !== undefined) chosen.reasoning_effort = effortFor(entry, override.reasoning_effort);
    const source = chosen === undefined ? 'unset' : (override.auto === true ? 'auto' : 'override');
    const connected = entry !== undefined;
    const enabled = chosen !== undefined && !current.disabledCells.includes(cell.id);
    groups.get(cell.role)?.push({
      id: cell.id,
      tier: cell.tier,
      provider: chosen?.provider ?? '',
      model: chosen?.model ?? '',
      reasoning_effort: chosen?.reasoning_effort ?? '',
      source,
      connected,
      enabled,
      purpose: current.descriptions[cell.id] ?? cell.purpose,
      defaultPurpose: cell.purpose,
    });
    if (!enabled || chosen === undefined) continue;
    const triple = { provider: chosen.provider, model: chosen.model, reasoning_effort: chosen.reasoning_effort };
    if (!triples.some(other => other.provider === triple.provider && other.model === triple.model && other.reasoning_effort === triple.reasoning_effort)) {
      triples.push(triple);
    }
  }

  effective = {
    roles: [...groups.entries()].filter(([, tiers]) => tiers.length > 0).map(([role, tiers]) => ({ role, tiers })),
    triples,
    models: models.map(({ provider, model, label, efforts }) => ({ provider, model, label, efforts })),
  };
  return effective;
}

/** Write the state atomically. */
function saveState(next) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, STATE_FILE);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'config-rejected', message: `could not save routing state: ${error?.message ?? error}` };
  }
}

/** Read saved state; `undefined` when absent, unreadable, or malformed. */
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? normalize(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/** Build the exact routes this row serves. */
function buildRoutes(ctx) {
  const llm = () => ctx.get('llm');
  const post = handler => async (req, res) => {
    if (rejectBrowserRequest(ctx, req, res)) return;
    if (req.method !== 'POST') { writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'POST required' }); return; }
    try {
      await handler(req, res);
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'internal', message: error?.message ?? String(error) });
    }
  };
  return [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/read`,
      handler: post(async (req, res) => {
        const body = await readJson(req);
        if (body === undefined) { writeJson(res, 400, { ok: false, code: 'malformed', message: 'malformed JSON body' }); return; }
        await ensureCells(ctx);
        await recompute(llm());
        writeJson(res, 200, { ok: true, config: snapshot(), ...effective });
      }),
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/write`,
      handler: post(async (req, res) => {
        const body = await readJson(req);
        if (body === undefined) { writeJson(res, 400, { ok: false, code: 'malformed', message: 'malformed JSON body' }); return; }
        const candidate = normalize(body);
        const known = new Set(shippedCells().map(cell => cell.id));
        const unknown = [
          ...candidate.disabledCells.filter(id => !known.has(id)),
          ...Object.keys(candidate.overrides).filter(id => !known.has(id)),
          ...Object.keys(candidate.descriptions).filter(id => !known.has(id)),
        ];
        if (unknown.length > 0) {
          writeJson(res, 400, { ok: false, code: 'cell-rejected', message: `unknown cell: ${unknown.join(', ')}` });
          return;
        }
        const models = await catalog(llm());
        const byKey = new Map(models.map(entry => [`${entry.provider}/${entry.model}`, entry]));
        const problems = [];
        for (const [id, override] of Object.entries(candidate.overrides)) {
          const entry = byKey.get(`${override.provider}/${override.model}`);
          if (entry === undefined) { problems.push(`${id}: ${override.provider}/${override.model} is not connected to this DSH`); continue; }
          if (entry.efforts.length > 0 && !entry.efforts.includes(override.reasoning_effort)) {
            problems.push(`${id}: ${override.model} does not declare reasoning_effort "${override.reasoning_effort}"`);
          }
        }
        if (problems.length > 0) {
          writeJson(res, 400, { ok: false, code: 'model-rejected', message: problems.join('; '), problems });
          return;
        }
        const saved = saveState(candidate);
        if (!saved.ok) { writeJson(res, 409, saved); return; }
        current = candidate;
        const resolved = await recompute(llm());
        ctx.emit('roblox-routing/changed', snapshot());
        // The model allow-list is read by the profile patch, so recompose to make a newly chosen
        // model dispatchable for new sessions now instead of after a restart.
        const applied = await applyProfileChange(ctx);
        writeJson(res, 200, { ok: true, applied, config: snapshot(), ...resolved });
      }),
    },
  ];
}

/**
 * Publish the profile's routing state and serve the bundle's configuration bridge.
 * @param ctx - registrant context carrying `webServer` and `llm`.
 * @param config - the row's configured state.
 */
export function apply(ctx, config) {
  STATE_FILE = stateFile(ctx);
  // First install gets a seeded file; later starts keep whatever the operator has chosen.
  current = loadState() ?? normalize(config);
  filling = undefined;
  void ensureCells(ctx).then(() => recompute(ctx.get('llm'))).catch(() => {});
  // A saved file outlives matrix edits: drop entries whose cell no longer exists rather than
  // publishing switches and overrides that can never match anything.
  try {
    const known = new Set(shippedCells().map(cell => cell.id));
    const stale = [
      ...current.disabledCells.filter(id => !known.has(id)),
      ...Object.keys(current.overrides).filter(id => !known.has(id)),
      ...Object.keys(current.descriptions).filter(id => !known.has(id)),
    ];
    if (stale.length > 0) {
      current = {
        disabledCells: current.disabledCells.filter(id => known.has(id)),
        overrides: Object.fromEntries(Object.entries(current.overrides).filter(([id]) => known.has(id))),
        descriptions: Object.fromEntries(Object.entries(current.descriptions).filter(([id]) => known.has(id))),
      };
      console.warn(`[roblox-routing] dropped ${stale.length} stale cell entr${stale.length === 1 ? 'y' : 'ies'}: ${stale.join(', ')}`);
    }
  } catch {
    // A matrix that cannot be read leaves the loaded state untouched.
  }
  try {
    ctx.provide('robloxRouting', { snapshot, triples, roles });
  } catch (error) {
    console.warn(`[roblox-routing] service already provided: ${error?.message ?? error}`);
  }

  const compute = llm => recompute(llm).catch(error => console.warn(`[roblox-routing] matrix unavailable: ${error?.message ?? error}`));
  // Best effort now, and again whenever the model catalog becomes available, so a row that
  // activates before `llm` does not publish an unsubstituted matrix indefinitely.
  void compute(ctx.get('llm'));
  if (typeof ctx.inject === 'function') {
    ctx.inject(['llm'], sctx => { void compute(sctx.get('llm')); });
  }

  /** Register the bridge on one web carrier. */
  const mount = server => {
    const disposers = [];
    for (const route of buildRoutes(ctx)) {
      try {
        disposers.push(server.register({ kind: route.kind, path: route.path, handler: route.handler }));
      } catch (error) {
        console.warn(`[roblox-routing] bridge route ${route.path} unavailable: ${error?.message ?? error}`);
      }
    }
    return () => { for (const dispose of disposers) dispose(); };
  };

  // The screenshots tab's bridge rides the same bundle-level row, so it serves every Session.
  let dropScreenshots;
  try {
    dropScreenshots = mountScreenshotBridge(ctx);
  } catch (error) {
    console.warn(`[roblox-screenshots] bridge unavailable: ${error?.message ?? error}`);
  }

  // The Open Cloud settings section's bridge rides the same row; it only talks to the credential store.
  let dropOpenCloud;
  try {
    dropOpenCloud = mountOpenCloudBridge(ctx);
  } catch (error) {
    console.warn(`[roblox-open-cloud] bridge unavailable: ${error?.message ?? error}`);
  }
  const dropExtras = () => { dropScreenshots?.(); dropOpenCloud?.(); };

  const server = ctx.get('webServer');
  if (typeof ctx.inject === 'function') {
    // The carrier is optional: a headless composition still owns and publishes routing state.
    ctx.inject(['webServer'], sctx => sctx.effect(() => mount(sctx.get('webServer')), 'roblox-routing: bridge'));
    return dropExtras;
  }
  if (server === undefined) return dropExtras;
  const dropRouting = mount(server);
  return () => { dropRouting(); dropExtras(); };
}

/** Profile configuration: the same state, editable through the loader row as well. */
let Config;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  Config = z.object({
    disabledCells: z.array(z.string()).description('Role/tier cells switched off, such as planner/fast.'),
    overrides: z.object({}).description('Per-cell provider/model/reasoning_effort choices, keyed by role/tier.'),
    descriptions: z.object({}).description('Per-cell purpose text the lead reads before dispatching.'),
  });
} catch {
  Config = undefined;
}
export { Config };
