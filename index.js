const PREFIX = 'mcp__robloxstudio__';

export const inject = ['tools'];

// Only the preset's context should mount this listener. Cordis owns its lifetime
// and DSH scope-filtered dispatch limits it to calls from that preset's agents.
export function apply(ctx) {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const before = candidate(exec, result);
    const decision = await next(); // Downstream policy and errors always win.
    if (!before || decision.kind !== 'accept'
      || 'value' in decision || 'content' in decision) return decision;

    // Recheck cancellation after awaiting policy. Also fail closed if another
    // listener changed the readonly outcome in place, not just its decision.
    const after = candidate(exec, result);
    if (!after || before.valueRef !== after.valueRef || before.contentRef !== after.contentRef
      || before.value !== after.value || before.content !== after.content) return decision;
    return { ...decision, content: [{ type: 'text', text: before.text }] };
  });
}

function candidate(exec, result) {
  if (exec.signal.aborted || result.isError !== false
    || typeof exec.name !== 'string' || !exec.name.startsWith(PREFIX)) return;
  const rawName = exec.name.slice(PREFIX.length);
  if (!rawName) return;
  const value = result.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.content) || value.content.length !== 0
    || value.structuredContent === null || typeof value.structuredContent !== 'object') return;
  const content = result.content;
  if (!Array.isArray(content)) return;
  if (content.length !== 0) {
    const block = content[0];
    // A lossy/hashed public tool name cannot recover the raw name. In that case
    // this exact comparison intentionally fails closed rather than guessing.
    if (content.length !== 1 || block === null || typeof block !== 'object'
      || Object.keys(block).length !== 2 || block.type !== 'text'
      || block.text !== `(${rawName} returned no model-visible content)`) return;
  }
  try {
    const text = JSON.stringify(value.structuredContent);
    if (typeof text !== 'string') return;
    return { text, valueRef: value, contentRef: content,
      value: JSON.stringify(value), content: JSON.stringify(content) };
  } catch {
    // Canonical results are JSON. An out-of-contract value must not turn a
    // successful tool call into a compatibility-plugin failure.
    return;
  }
}
