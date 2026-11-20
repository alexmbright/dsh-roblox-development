/**
 * Apply a saved setting without restarting DSH.
 *
 * The model allowlist is read from routing state at profile composition. DSH's HMR service
 * owns recomposition: `reconcileProfile()` re-reads
 * the patch, commits volatile-only changes in place, restarts only the entries whose resolved
 * configuration changed, and leaves everything else running.
 * @module @alexturbo/dsh-roblox-development/apply-profile
 */

/**
 * Recompose the profile so the patch expressions see what was just saved.
 *
 * Never throws: a save has already succeeded by the time this runs, so a failure here must only
 * downgrade the answer to "restart DSH to apply", never fail the save.
 * @param ctx - registrant context; `hmr` is optional (a composition without HMR applies on restart).
 * @returns `{ applied: true }`, or `{ applied: false, reason }` with a short, value-free reason.
 */
export async function applyProfileChange(ctx) {
  let hmr;
  try {
    hmr = ctx.get('hmr');
  } catch {
    hmr = undefined;
  }
  if (typeof hmr?.runExclusive !== 'function' || typeof hmr?.reconcileProfile !== 'function') {
    return { applied: false, reason: 'live reload is unavailable in this composition' };
  }
  try {
    await hmr.runExclusive(() => hmr.reconcileProfile());
    return { applied: true };
  } catch (error) {
    // Keep it short and generic; the detail belongs in the log, not in a browser response.
    console.warn(`[roblox-settings] live apply failed: ${error?.name ?? 'error'}`);
    return { applied: false, reason: 'DSH could not reload the profile' };
  }
}
