/**
 * On-demand Studio MCP tools.
 *
 * The community Studio MCP publishes about 50 tools (~13k tokens of schemas). Sending all of
 * them on every request is the largest fixed cost of the preset, so only a small core set is
 * always visible. Every other tool is registered with a step-time `when` condition and is
 * admitted for one agent after that agent finds it with `roblox_studio_tools`. The registry's
 * documented step admission decides both the declarations and dispatch, so a hidden tool can
 * neither be seen nor called until it is admitted.
 * @module @alexturbo/dsh-roblox-development/studio-tool-search
 */

export const SEARCH_TOOL = 'roblox_studio_tools';

/** Raw tool names that stay visible: the everyday read, edit, run and inspect loop. */
export const CORE_TOOLS = Object.freeze([
  'get_connected_instances', 'get_project_structure', 'get_instance_properties', 'search_objects', 'set_properties',
  'get_script_source', 'set_script_source', 'edit_script_lines', 'grep_scripts', 'execute_luau',
  'get_runtime_logs', 'solo_playtest', 'capture_screenshot', 'get_request_status',
]);

const MAX_MATCHES = 8;

/** First sentence of a description, for the search result. */
const summary = text => String(text ?? '').split(/(?<=\.)\s|\n/)[0].slice(0, 160);

/** Lower-case word set used for matching. */
const words = text => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1);

/**
 * Create the admission state for one MCP server.
 * @param options.serverName - MCP namespace; public names are `mcp__<serverName>__<raw>`.
 * @param options.core - raw names that are always visible.
 */
export function createStudioToolSearch({ serverName, core = CORE_TOOLS }) {
  const prefix = `mcp__${serverName}__`;
  const coreSet = new Set(core);
  /** public name -> { raw, description } for every registered deferred tool. */
  const deferred = new Map();
  /** agent key -> admitted public names. */
  const admitted = new Map();

  const rawOf = publicName => (publicName.startsWith(prefix) ? publicName.slice(prefix.length) : publicName);
  const keyOf = agent => agent?.id ?? agent?.session?.id ?? agent;
  const admittedFor = agent => {
    const key = keyOf(agent);
    if (key === undefined || key === null) return undefined;
    let set = admitted.get(key);
    if (set === undefined) admitted.set(key, set = new Set());
    return set;
  };

  /**
   * Wrap the host registry's `register` so non-core tools carry the admission condition.
   * @param register - the host `tools.register`, already bound to the caller's scope.
   */
  const wrapRegister = register => (definition, options = {}) => {
    const name = definition?.name;
    if (typeof name !== 'string' || coreSet.has(rawOf(name))) return register(definition, options);
    deferred.set(name, { raw: rawOf(name), description: definition.description ?? '' });
    const inner = options.when;
    const dispose = register(definition, {
      ...options,
      when: async context => (admittedFor(context?.agent)?.has(name) ?? false) && (inner === undefined || await inner(context)),
    });
    return () => {
      deferred.delete(name);
      return dispose();
    };
  };

  /** Rank deferred tools for a query; exact raw-name hits first. */
  const search = query => {
    const wanted = words(query);
    if (wanted.length === 0) return [];
    const scored = [];
    for (const [name, entry] of deferred) {
      const nameWords = words(entry.raw);
      const descWords = new Set(words(entry.description));
      let score = 0;
      for (const word of wanted) {
        if (entry.raw === word) score += 10;
        if (nameWords.includes(word)) score += 3;
        else if (nameWords.some(part => part.startsWith(word) || word.startsWith(part))) score += 2;
        if (descWords.has(word)) score += 1;
      }
      if (score > 0) scored.push({ name, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, MAX_MATCHES).map(item => item.name);
  };

  /** Resolve exact raw or public names to registered deferred public names. */
  const exact = names => (names ?? [])
    .map(item => String(item))
    .map(item => (deferred.has(item) ? item : `${prefix}${item}`))
    .filter(item => deferred.has(item));

  /** The model-facing search tool definition. */
  const definition = {
    name: SEARCH_TOOL,
    description: `Load Roblox Studio MCP tools on demand. Only the core Studio tools (${core.join(', ')}) are always loaded; `
      + 'the other Studio tools (assets, profiling, device and network simulation, multiplayer playtests, input simulation, '
      + 'rbxm import/export, uploads, monetization, experience settings, docs) load only after this call. Try these before official Roblox_Studio equivalents. Pass a short '
      + 'query such as "asset search" or "device simulator", or exact tool names. Matched tools are usable from your next step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Words describing the capability you need.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to load, with or without the mcp__ prefix.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const set = admittedFor(exec?.agent);
      if (set === undefined) return { loaded: [], note: 'No calling agent: nothing can be loaded.' };
      const chosen = [...new Set([...exact(args?.names), ...search(args?.query)])];
      for (const name of chosen) set.add(name);
      const loaded = chosen.map(name => ({ name, summary: summary(deferred.get(name)?.description) }));
      if (loaded.length > 0) return { loaded, note: 'These tools are usable from your next step.' };
      return {
        loaded: [],
        note: 'No Studio tool matched. Try other words, or pick a name from available.',
        available: [...deferred.values()].map(entry => entry.raw).sort(),
      };
    },
  };

  return { wrapRegister, definition, search, admittedFor, deferredNames: () => [...deferred.keys()] };
}

/**
 * Provide a `tools` service whose `register` defers non-core tools; every other member
 * forwards to the host registry unchanged.
 * @param ctx - the isolated realm the MCP plugin runs in.
 * @param options.host - returns the host registry bound to the parent plugin's scope.
 * @param options.state - from {@link createStudioToolSearch}.
 */
export function deferredTools(ctx, { host, state }) {
  const register = state.wrapRegister((definition, options) => host().register(definition, options));
  ctx.provide('tools', new Proxy({}, {
    get(_target, property) {
      if (property === 'register') return register;
      const registry = host();
      const value = registry?.[property];
      return typeof value === 'function' ? value.bind(registry) : value;
    },
    has: (_target, property) => property === 'register' || property in (host() ?? {}),
  }));
}
