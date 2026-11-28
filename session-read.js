/**
 * Read one stored (live or cold) Session's header and raw events through `ctx.sessionQuery`,
 * across DSH releases.
 *
 * - DSH 0.2.3+: `observeSession(id, { signal, projectionMode })` returns a disposable
 *   observation lease with `header` and `events`; `inspectSession` is removed.
 * - DSH 0.2.2-rc.5: `inspectSession(id, read, signal)` passes a prepared Session to `read`.
 *
 * The reader receives `{ id, header, events }` on the observation path, or the prepared Session on
 * the legacy path; both expose `header` and an `events`/`eventAt` view that the bundle's readers
 * (`capturesIn`, `auditSession`) already accept.
 * @module @alexturbo/dsh-roblox-development/session-read
 */

/** Whether the query service can read a stored Session on this DSH release. */
export const canReadStoredSession = query => typeof query?.observeSession === 'function'
  || typeof query?.inspectSession === 'function';

/**
 * Read a stored Session synchronously through `read` and release it.
 * @param query - the `sessionQuery` service (may be undefined).
 * @param sessionId - logical Session id.
 * @param read - synchronous reader over the Session view.
 * @param signal - optional cancellation.
 * @returns the reader's result.
 * @throws when the Session cannot be read or no read method is available.
 */
export async function readStoredSession(query, sessionId, read, signal) {
  if (typeof query?.observeSession === 'function') {
    const observation = await query.observeSession(sessionId, signal === undefined
      ? { projectionMode: 'none' }
      : { signal, projectionMode: 'none' });
    try {
      if (Array.isArray(observation?.events)) {
        return read({ id: observation.header?.id ?? sessionId, header: observation.header, events: observation.events });
      }
    } finally {
      try {
        observation?.[Symbol.dispose]?.();
      } catch { /* releasing a lease never fails the read */ }
    }
  }
  if (typeof query?.inspectSession === 'function') return query.inspectSession(sessionId, read, signal);
  throw new Error('session log unavailable');
}
