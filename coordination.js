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
 * @param routes - worker name -> dispatch record with provider, model and reasoning_effort.
 * @returns context text, or '' when this lead has no workers.
 */
export function statusContext(view, routes = new Map()) {
  const route = worker => {
    const entry = routes.get(worker.name);
    return entry?.model ? ` (${entry.provider}/${entry.model} at ${entry.reasoning_effort})` : '';
  };
  const running = view?.running ?? [];
  const finished = view?.finished ?? [];
  if (running.length === 0 && finished.length === 0) return '';
  const lines = ['Roblox worker status (live, from the runtime):'];
  if (running.length === 0) {
    lines.push('- Waiting on: nothing; no worker is running.');
  } else {
    lines.push(`- Waiting on ${running.length} worker(s):`);
    for (const worker of running) lines.push(`  - ${worker.name}${route(worker)}: running`);
  }
  if (finished.length > 0) {
    lines.push('- Recently finished:');
    for (const worker of finished) lines.push(`  - ${worker.name}${route(worker)}: ${worker.outcome ?? 'completed'}`);
    if (running.length <= 1) lines.push(IDLE_HINT);
  }
  lines.push('Every reply to the user must end with a "Waiting on:" line naming each running worker, its model and effort, and its task, '
    + 'or "Waiting on: nothing". Announce each finished worker by name with its outcome before using its results.');
  return lines.join('\n');
}

const IDLE_HINT = '- Few workers are running. Studio takes turns only for playtests and writes: send every remaining '
  + 'task to a worker now, with its offline part (read source, draft edits, compile, write test steps).';

// Reply wording that parks work in a serial queue. A real conflict (same script, same playtest) is
// fine, but the lead must name it; parking a worker "waiting for Studio" is not one.
const SERIAL_QUEUE = /\b(?:one (?:at a time|after (?:the )?other|after another|by one)|wait(?:s|ing)? (?:for|on) studio|idle until|until [\w-]+ (?:frees|hands back|releases|gives back) studio|studio (?:order|queue)|goes next|go(?:es)? into studio|hands? (?:it|studio) back|in (?:the|a) queue|take[s]? (?:its|their) turn in studio)\b/i;

/**
 * Correction owed when a reply queues work behind Studio while at most one worker runs, or ''
 * when the reply is fine. The runtime sends it once per turn, before the reply reaches the user.
 * @param input.reply - final assistant text.
 * @param input.running - number of workers running now.
 */
export function concurrencyCorrection({ reply = '', running = 0 }) {
  if (running > 1 || !SERIAL_QUEUE.test(reply)) return '';
  return `Only ${running} worker(s) are running, and your reply queues work. Studio takes turns only for playtests, scene changes `
    + 'and script writes; reads outside a playtest and all offline work can run now. Before you reply, dispatch or message each '
    + 'queued worker to do its offline part now (read source, draft exact edits, compile and lint with roblox_run_tool, write '
    + 'test steps). Keep a task queued only when it edits the same script or needs the same playtest, and name that conflict.';
}

/**
 * Join the worker status and the one-line visual gate status. The gate line changes only when a
 * gate rule's pass/fail set changes, so it is as cache-friendly as the worker status.
 */
export function promptContext(status, gateLine = '') {
  return [status, gateLine].filter(part => typeof part === 'string' && part !== '').join('\n');
}
