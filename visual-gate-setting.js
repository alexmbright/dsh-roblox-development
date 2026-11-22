/**
 * The persisted "Visual gate" setting.
 *
 * One value, `on` or `off`, stored per profile in `roblox-settings.json` beside the routing
 * state. The same value drives two things, so they cannot disagree: the runtime guard's mode
 * and the visual-gate instructions in the lead's prompt. Both are read when the profile is
 * composed, so a change reaches new sessions (live profile reload) or the next DSH start.
 *
 * Resolution is deliberately small:
 * - an explicit `on` or `off` is kept;
 * - legacy `auto`, unset, unreadable and any other value mean `off`.
 *
 * Existing `docs/<scope>/VISUAL_GATE.md` files are never read or written here.
 * @module @alexturbo/dsh-roblox-development/visual-gate-setting
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = 'roblox-settings.json';
export const DEFAULT_VISUAL_GATE = 'off';

/** `on` and `off` survive; legacy `auto`, unset and anything else become `off`. */
export const normalizeVisualGate = value => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : value === true ? 'on' : value === false ? 'off' : '';
  return text === 'on' || text === 'off' ? text : DEFAULT_VISUAL_GATE;
};

/** Settings file for a profile directory. */
export const settingsPath = profileDir => path.join(profileDir, SETTINGS_FILE);

/**
 * Read the saved setting.
 * @param profileDir - the profile directory, or '' / undefined when unknown.
 * @returns `{ value, stored }`: the effective value and whether the file holds a usable explicit one.
 */
export function readVisualGate(profileDir) {
  if (typeof profileDir !== 'string' || profileDir === '') return { value: DEFAULT_VISUAL_GATE, stored: false };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(profileDir), 'utf8'));
    const raw = typeof parsed?.visualGate === 'string' ? parsed.visualGate.trim().toLowerCase() : undefined;
    return { value: normalizeVisualGate(raw), stored: raw === 'on' || raw === 'off', legacy: raw === 'auto' };
  } catch {
    return { value: DEFAULT_VISUAL_GATE, stored: false };
  }
}

/**
 * Save the setting atomically, keeping any other keys already in the file.
 * @returns `{ ok: true, value }` or `{ ok: false, code, message }`.
 */
export function writeVisualGate(profileDir, value) {
  const next = String(value).trim().toLowerCase();
  if (next !== 'on' && next !== 'off') {
    return { ok: false, code: 'value-rejected', message: 'visualGate must be "on" or "off"' };
  }
  if (typeof profileDir !== 'string' || profileDir === '') {
    return { ok: false, code: 'config-rejected', message: 'the profile directory is unknown' };
  }
  const file = settingsPath(profileDir);
  try {
    let existing = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
    } catch { /* absent or unreadable: start fresh */ }
    mkdirSync(profileDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...existing, visualGate: next }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    return { ok: true, value: next };
  } catch (error) {
    return { ok: false, code: 'config-rejected', message: `could not save the Visual gate setting: ${error?.message ?? error}` };
  }
}
