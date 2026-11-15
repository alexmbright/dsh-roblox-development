/**
 * Coordinator status text for the Roblox preset.
 *
 * Renders the lead's live worker view (running workers it is waiting on, recently finished ones
 * with their outcome) as a prompt context, so the coordinator has the facts it must announce.
 * The worker records come from the skill-policy evidence store, which follows
 * `subagent/start` / `subagent/end` and recovers workers from the durable catalog after a
 * remount or resume. Observation only; it never blocks, waits or changes a worker.
 * @module @alexturbo/dsh-roblox-development/coordination
 */

/**
 * Render the coordinator status context. The text deliberately carries no clock values: it
 * changes only when a worker starts or finishes, so the system prompt stays byte-identical
 * between those events and prompt caching keeps working.
 * @param view - `{ running, finished }` worker records (`name`, `outcome`) for one lead.
 * @returns context text, or '' when this lead has no workers.
 */
export function statusContext(view) {
  const running = view?.running ?? [];
  const finished = view?.finished ?? [];
  if (running.length === 0 && finished.length === 0) return '';
  const lines = ['Roblox worker status (live, from the runtime):'];
  if (running.length === 0) {
    lines.push('- Waiting on: nothing; no worker is running.');
  } else {
    lines.push(`- Waiting on ${running.length} worker(s):`);
    for (const worker of running) lines.push(`  - ${worker.name}: running`);
  }
  if (finished.length > 0) {
    lines.push('- Recently finished:');
    for (const worker of finished) lines.push(`  - ${worker.name}: ${worker.outcome ?? 'completed'}`);
  }
  lines.push('Every reply to the user must end with a "Waiting on:" line naming each running worker and its task, '
    + 'or "Waiting on: nothing". Announce each finished worker by name with its outcome before using its results.');
  return lines.join('\n');
}
