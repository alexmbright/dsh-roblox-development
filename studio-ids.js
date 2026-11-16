/**
 * Keep the two Studio MCP servers' target ids apart.
 *
 * The official server names targets with `studio_id` (from `list_roblox_studios`); the chrrxs
 * server with `instance_id` (from `get_connected_instances`). They are separate namespaces, and
 * an id from one passed to the other targets the wrong process or fails confusingly. This folds
 * each server's listing results from the calling session's log and refuses a call that passes an
 * id known only from the other server. Ids that were never listed are left alone.
 * @module @alexturbo/dsh-roblox-development/studio-ids
 */
const SERVERS = {
  official: { lister: 'list_roblox_studios', arg: 'studio_id' },
  chrrxs: { lister: 'get_connected_instances', arg: 'instance_id' },
};

const serverOf = name => {
  const match = /^mcp__(.+?)__(.+)$/.exec(typeof name === 'string' ? name : '');
  if (match === null) return undefined;
  if (match[1] === 'Roblox_Studio') return { server: 'official', tool: match[2] };
  if (match[1] === 'robloxstudio') return { server: 'chrrxs', tool: match[2] };
  return undefined;
};

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');

/** Every id-like string in a listing result (JSON fields named id, studio_id, instance_id, or role-suffixed keys). */
export function idsInListing(text) {
  const ids = new Set();
  const visit = value => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:id|studio_?id|instance_?id|studioId|instanceId)$/i.test(key) && typeof item === 'string' && item.length >= 4) ids.add(item);
      visit(item);
    }
  };
  for (const chunk of [text, ...String(text).split('\n')]) {
    try {
      visit(JSON.parse(chunk));
    } catch { /* not JSON */ }
  }
  for (const match of String(text).matchAll(/\b(?:studio_?id|instance_?id)\b["'\s:=]+([A-Za-z0-9._:-]{4,})/gi)) ids.add(match[1]);
  return ids;
}

const states = new WeakMap();

/** Ids each server has listed in this session, folded incrementally. */
export function listedIds(session) {
  let state = states.get(session);
  const count = typeof session?.seq === 'number' ? session.seq : session?.events?.length ?? 0;
  if (state === undefined || count < state.offset) {
    state = { offset: 0, pending: new Map(), official: new Set(), chrrxs: new Set() };
    states.set(session, state);
  }
  const at = seq => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : session?.events?.[seq]);
  for (let seq = state.offset; seq < count; seq += 1) {
    const event = at(seq);
    const data = event?.data;
    if (event?.type === 'tool/call') {
      const found = serverOf(data?.name);
      if (found !== undefined && SERVERS[found.server].lister === found.tool) state.pending.set(data.callId, found.server);
    } else if (event?.type === 'tool/result' && state.pending.has(data?.message?.toolCallId)) {
      const server = state.pending.get(data.message.toolCallId);
      state.pending.delete(data.message.toolCallId);
      if (data.message.isError !== true) for (const id of idsInListing(textOf(data.message.content))) state[server].add(id);
    }
  }
  state.offset = count;
  return state;
}

/**
 * Refuse a Studio call whose target id belongs to the other server.
 * @returns a guard denial or undefined.
 */
export function crossNamespaceDenial(execution) {
  const found = serverOf(execution?.name);
  if (found === undefined) return undefined;
  const session = execution?.agent?.session;
  if (session === undefined || session === null) return undefined;
  const own = SERVERS[found.server];
  const otherName = found.server === 'official' ? 'chrrxs' : 'official';
  const other = SERVERS[otherName];
  const value = execution.arguments?.[own.arg] ?? execution.arguments?.[other.arg];
  if (typeof value !== 'string' || value === '') return undefined;
  const ids = listedIds(session);
  const base = value.replace(/[:#@/].*$/, '');
  const knownHere = ids[found.server].has(value) || ids[found.server].has(base);
  const knownThere = ids[otherName].has(value) || ids[otherName].has(base);
  const wrongArg = execution.arguments?.[own.arg] === undefined && execution.arguments?.[other.arg] !== undefined;
  if (!wrongArg && (knownHere || !knownThere)) return undefined;
  const reason = wrongArg
    ? `Roblox Studio: ${execution.name} takes ${own.arg}, not ${other.arg}. Get its ids from ${own.lister}.`
    : `Roblox Studio: "${value}" came from ${other.lister} (${otherName} server); ${execution.name} needs a ${own.arg} from ${own.lister}. `
      + 'The two servers use separate id namespaces; call the lister on this server and use its id for the same Studio.';
  return { reason, info: { name: 'roblox-studio-ids', code: 'STUDIO_ID_NAMESPACE', reason } };
}
