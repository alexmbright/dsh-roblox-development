#!/usr/bin/env node
/**
 * Visual gate check for a Roblox project: the single source of truth for the gate rules.
 *
 * Usage: node tools/check-visual-gate.mjs [scope] [--rules]
 *   Checks docs/<scope>/VISUAL_GATE.md, or every docs/<scope>/VISUAL_GATE.md when no scope is given.
 *   Exits 0 when every gate passes, 1 otherwise, printing one "[RULE] problem" per line.
 *   --rules prints the rule table and the watched/ignored path defaults, then exits 0.
 *
 * The Roblox mode runs exactly these checks in-process (roblox_visual_gate and goal completion);
 * it never runs a different project copy. A project may keep a copy of this file so the gate can
 * be checked outside DSH; when the copy is older than the installed bundle, run the bundled one.
 */
import { readFileSync, readdirSync, realpathSync, statSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_FILE = 'VISUAL_GATE.md';
export const DEFAULT_CLIENT_SOURCE = ['src/client', 'src/StarterGui', 'src/StarterPlayer', 'src/ReplicatedFirst', 'assets'];
/** Never count as a visual change, whatever the gate file says. */
export const ALWAYS_IGNORED = ['**/.DS_Store', '**/*.bak', '**/*.tmp', '**/*.lock'];
/** Ignored unless the gate file lists its own `Ignore:` line. */
export const DEFAULT_IGNORE = ['assets/backup/**', '**/*.backup.rbxm', '**/*.backup.rbxmx', '**/backup/**'];
export const MIN_SCREENSHOTS = 3;
export const MIN_CHECKLIST = 5;
export const MIN_QUERIES = 6;

/** Every rule the gate enforces. Problems carry the id. */
export const RULES = {
  GATE_MISSING: `docs/<scope>/${GATE_FILE} exists and is readable`,
  VERDICT: 'Verdict: PASS (the entire value must be PASS or FAIL)',
  CLIENT_SOURCE: 'explicit Client source: paths are existing project-relative files or folders, not globs or escapes',
  ASSET_SOURCING: 'an explicit "## Asset sourcing" section contains Piece records or "Not applicable: <substantive UI-only reason>"',
  REVIEWER: 'Reviewer: <worker name> (visual/standard) or (visual/expert)',
  SCREENSHOTS: `at least ${MIN_SCREENSHOTS} distinct screenshots (capture ids or names) under "Screenshots:"`,
  CHECKLIST: `a checklist of at least ${MIN_CHECKLIST} "- [x]" items`,
  CHECKLIST_OPEN: 'PASS only with every checklist item checked',
  STALE: 'the gate file is newer than every watched client-source file (see "Client source:" and "Ignore:")',
  ASSET_FINAL: '"Final:" names the kept asset id or says primitive',
  ASSET_QUERIES: `primitive final art: at least ${MIN_QUERIES} distinct search_assets queries`,
  ASSET_CANDIDATES: 'primitive final art: shortlisted candidates with rejection reasons',
  ASSET_THUMBNAIL: 'every candidate: thumbnail viewed (get_asset_thumbnail)',
  ASSET_DETAILS: 'every candidate: details read (get_asset_details)',
  ASSET_REJECT_REASON: 'a rejection gives a reason beyond scripts, triangles, pivot or scale (all fixable)',
  ASSET_REJECT_IN_SCENE: 'a rejected candidate was seen in the scene first',
  ASSET_KEPT_RECORD: 'a kept asset records creator and price',
  ASSET_AUTHORIZED: 'a kept cross-owner asset has "authorized: YYYY-MM-DD"',
  ASSET_STATUS: 'every candidate is kept or rejected',
};

const OWN_CREATOR = /^(?:own|self|project|ours|first-party|roblox)$/i;
const FIXABLE_ONLY = /^(?:[\s,;.&/+-]|and|or|too|many|high|has|have|contains|script|scripts|tri|tris|triangle|triangles|triangle-count|count|poly|polys|polygon|polygons|bad|wrong|off|pivot|pivots|scale|scaled|size|sized|backdoor|backdoors|virus|malicious)+$/i;
const problem = (rule, text) => ({ rule, text });

/** Every docs/<scope>/VISUAL_GATE.md under the project root, as scope names. */
export function gateScopes(root) {
  let entries;
  try {
    entries = readdirSync(path.join(root, 'docs'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory() && existsSync(path.join(root, 'docs', entry.name, GATE_FILE)))
    .map(entry => entry.name).sort();
}

const field = (text, label) => new RegExp(`^[ \\t>*_-]*${label}:[*_]*[ \\t]*(.*)$`, 'im').exec(text)?.[1]?.trim();
const list = value => (value ?? '').split(/[,;]/).map(item => item.trim().replace(/^`|`$/g, '')).filter(Boolean);

function bullets(lines, start) {
  const out = [];
  for (let index = start; index < lines.length; index += 1) {
    const match = /^[ \t]*[-*+][ \t]+(.+)$/.exec(lines[index]);
    if (match) out.push(match[1].trim());
    else if (lines[index].trim() === '' && out.length === 0) continue;
    else break;
  }
  return out;
}

/** Parse "id | key: value | key: value" candidate rows. */
function candidateRow(text) {
  const parts = text.split('|').map(part => part.trim());
  const id = /(\d{4,})/.exec(parts[0] ?? '')?.[1];
  const fields = {};
  for (const part of parts.slice(1)) {
    const match = /^([A-Za-z -]+):\s*(.*)$/.exec(part);
    if (match) fields[match[1].trim().toLowerCase().replace(/\s+/g, '-')] = match[2].trim();
  }
  return { id, fields, text };
}

/** Parse one gate file. */
export function parseGate(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const verdict = /^(PASS|FAIL)$/i.exec(field(text, 'Verdict') ?? '')?.[1]?.toUpperCase();
  const reviewerLine = field(text, 'Reviewer') ?? '';
  const reviewerMatch = /^`?([A-Za-z0-9][\w./-]*)`?\s*(?:\(([^)]*)\))?/.exec(reviewerLine);
  const reviewer = reviewerMatch?.[1];
  const role = /visual\/(?:fast|standard|expert)/i.exec(reviewerMatch?.[2] ?? reviewerLine)?.[0]?.toLowerCase();
  const shotsIndex = lines.findIndex(line => /^[ \t>*_-]*Screenshots:[*_]*[ \t]*$/i.test(line));
  const screenshots = shotsIndex >= 0 ? bullets(lines, shotsIndex + 1) : list(field(text, 'Screenshots'));
  const checklist = lines.map(line => /^[ \t]*[-*+][ \t]+\[( |x|X)\][ \t]+(.+)$/.exec(line))
    .filter(Boolean).map(match => ({ checked: match[1] !== ' ', text: match[2].trim() }));
  const ignoreLine = field(text, 'Ignore');
  const clientSourceLine = field(text, 'Client source');

  const pieces = [];
  const assetSourcing = { sections: 0, notApplicable: [], outsidePieces: 0 };
  let inSourcing = false;
  let current;
  let mode;
  for (const line of lines) {
    if (/^##[ \t]+Asset sourcing[ \t]*$/i.test(line)) {
      assetSourcing.sections += 1;
      inSourcing = true;
      current = undefined;
      mode = undefined;
      continue;
    }
    if (/^#{1,2}[ \t]/.test(line)) inSourcing = false;
    const piece = /^###[ \t]+Piece:[ \t]*(.+)$/i.exec(line);
    if (!inSourcing) {
      if (piece) assetSourcing.outsidePieces += 1;
      current = undefined;
      continue;
    }
    const notApplicable = /^[ \t>*_-]*Not applicable:[*_]*[ \t]*(.*)$/i.exec(line);
    if (notApplicable) assetSourcing.notApplicable.push(notApplicable[1].trim());
    if (piece) {
      current = { name: piece[1].trim(), final: '', queries: [], candidates: [] };
      pieces.push(current);
      mode = undefined;
      continue;
    }
    if (/^#{1,3}[ \t]/.test(line)) { current = undefined; continue; }
    if (current === undefined) continue;
    const final = /^[ \t>*_-]*Final:[*_]*[ \t]*(.*)$/i.exec(line);
    if (final) { current.final = final[1].trim(); mode = undefined; continue; }
    const queries = /^[ \t>*_-]*Queries:[*_]*[ \t]*(.*)$/i.exec(line);
    if (queries) {
      mode = 'queries';
      current.queries.push(...queries[1].split(';').map(q => q.trim().replace(/^["`]|["`]$/g, '')).filter(Boolean));
      continue;
    }
    if (/^[ \t>*_-]*Candidates:/i.test(line)) { mode = 'candidates'; continue; }
    const bullet = /^[ \t]*[-*+][ \t]+(.+)$/.exec(line);
    if (bullet && /^Candidate\b/i.test(bullet[1].trim())) {
      current.candidates.push(candidateRow(bullet[1].trim().replace(/^Candidate[ \t:]*/i, '')));
      continue;
    }
    if (bullet && mode === 'queries') current.queries.push(bullet[1].trim().replace(/^["`]|["`]$/g, ''));
    else if (bullet && mode === 'candidates') current.candidates.push(candidateRow(bullet[1].trim()));
  }
  return {
    verdict, reviewer, role, screenshots: [...new Set(screenshots)], checklist,
    clientSource: list(clientSourceLine),
    clientSourceExplicit: clientSourceLine !== undefined,
    ignore: ignoreLine === undefined ? undefined : list(ignoreLine),
    pieces, assetSourcing,
  };
}

/** Compile a glob (`**`, `*`, `?`) over forward-slash relative paths. */
export function globToRegExp(glob) {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** The watched files/folders and ignore patterns one gate applies. */
export function watchSpec(gate) {
  return {
    watched: gate?.clientSourceExplicit || gate?.clientSource?.length > 0 ? gate.clientSource : DEFAULT_CLIENT_SOURCE,
    ignored: [...ALWAYS_IGNORED, ...(gate?.ignore ?? DEFAULT_IGNORE)],
  };
}

const within = (root, full) => {
  const relative = path.relative(root, full);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const invalidWatch = value => typeof value !== 'string' || value.trim() === ''
  || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)
  || /[\\\\*?\[\]{}\x00-\x1f]/.test(value) || value.split('/').includes('..');

/**
 * Newest non-ignored file mtime, plus fail-closed CLIENT_SOURCE problems.
 * Only omitted default roots may be absent; explicit files/folders must exist.
 * Symlinks are followed only within the real project root, with cycle detection.
 */
export function latestChange(root, sources, ignored = [...ALWAYS_IGNORED, ...DEFAULT_IGNORE], { allowMissing = false } = {}) {
  const matchers = ignored.map(globToRegExp);
  const problems = [];
  const fail = (relative, detail) => problems.push(problem('CLIENT_SOURCE', `Client source "${relative}": ${detail}`));
  const rootPath = path.resolve(root);
  let realRoot;
  try { realRoot = realpathSync(rootPath); }
  catch { return { time: 0, path: undefined, problems: [problem('CLIENT_SOURCE', 'project root is missing or unreadable')] }; }
  let newest = 0;
  let newestPath;
  const walk = (full, ancestors = new Set(), optional = false) => {
    const relative = path.relative(rootPath, full).split(path.sep).join('/') || '.';
    let info;
    let real;
    try {
      // lstat distinguishes an absent optional default from a dangling symlink.
      lstatSync(full);
    } catch (error) {
      if (!(optional && error.code === 'ENOENT')) fail(relative, `missing or unreadable (${error.code ?? 'unknown error'})`);
      return;
    }
    try {
      real = realpathSync(full);
      if (!within(realRoot, real)) { fail(relative, 'symlink escapes the project root'); return; }
      info = statSync(full);
    } catch (error) { fail(relative, `missing or unreadable (${error.code ?? 'unknown error'})`); return; }
    if (info.isFile()) {
      if (!matchers.some(matcher => matcher.test(relative)) && info.mtimeMs > newest) {
        newest = info.mtimeMs;
        newestPath = relative;
      }
      return;
    }
    if (!info.isDirectory()) { fail(relative, 'must be a regular file or directory'); return; }
    if (ancestors.has(real)) { fail(relative, 'symlink directory cycle'); return; }
    if (matchers.some(matcher => matcher.test(`${relative}/`) || matcher.test(`${relative}/x`))) return;
    let entries;
    try { entries = readdirSync(full, { withFileTypes: true }); }
    catch (error) { fail(relative, `directory is unreadable (${error.code ?? 'unknown error'})`); return; }
    const nextAncestors = new Set([...ancestors, real]);
    for (const entry of entries) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') walk(path.join(full, entry.name), nextAncestors);
    }
  };
  for (const source of sources) {
    if (invalidWatch(source)) { fail(String(source), 'must be a project-relative file or folder; globs, absolute paths, backslashes and .. escapes are not supported'); continue; }
    const full = path.resolve(rootPath, source);
    if (!within(rootPath, full)) { fail(source, 'escapes the project root'); continue; }
    walk(full, new Set(), allowMissing);
  }
  return { time: newest, path: newestPath, problems };
}

function validAuthorization(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Asset-sourcing problems for one piece. */
export function pieceProblems(piece) {
  const problems = [];
  const label = `piece "${piece.name}"`;
  const primitive = /\b(?:primitive|part|parts|csg|code-built|procedural|placeholder|greybox)\b/i.test(piece.final);
  const finalIds = piece.final.match(/\d{4,}/g) ?? [];
  const finalId = finalIds.length === 1 ? finalIds[0] : undefined;
  if ((primitive && finalIds.length > 0) || (!primitive && finalId === undefined)) {
    problems.push(problem('ASSET_FINAL', `${label}: "Final:" must unambiguously name one kept asset id or say primitive, not both`));
  }
  if (primitive) {
    const distinct = new Set(piece.queries.map(q => q.toLowerCase()));
    if (distinct.size < MIN_QUERIES) problems.push(problem('ASSET_QUERIES', `${label}: primitive final art needs at least ${MIN_QUERIES} distinct search_assets queries (found ${distinct.size})`));
    if (piece.candidates.length === 0) problems.push(problem('ASSET_CANDIDATES', `${label}: primitive final art needs the shortlisted candidates and why each was rejected`));
  }
  for (const candidate of piece.candidates) {
    const name = `${label} candidate ${candidate.id ?? '(no id)'}`;
    const f = candidate.fields;
    if (candidate.id === undefined) problems.push(problem('ASSET_STATUS', `${name}: no asset id`));
    if (!/^(?:yes|viewed|seen|true)$/i.test(f.thumbnail ?? '')) problems.push(problem('ASSET_THUMBNAIL', `${name}: thumbnail not viewed (get_asset_thumbnail)`));
    if (!/^(?:yes|viewed|read|seen|true)$/i.test(f.details ?? '')) problems.push(problem('ASSET_DETAILS', `${name}: details not read (get_asset_details)`));
    const status = (f.status ?? '').toLowerCase();
    if (status === 'rejected') {
      const reason = f.reason ?? '';
      if (reason.length < 12 || FIXABLE_ONLY.test(reason)) {
        problems.push(problem('ASSET_REJECT_REASON', `${name}: rejection reason "${reason}" is missing or only a fixable issue (scripts, triangles, pivot and scale are fixable)`));
      }
      if (!/^(?:yes|viewed|seen|true)$/i.test(f['in-scene'] ?? '')) problems.push(problem('ASSET_REJECT_IN_SCENE', `${name}: rejected without being seen in the scene (insert in Edit mode, strip scripts, rescale, then judge)`));
    } else if (status === 'kept') {
      const creator = f.creator ?? '';
      if (creator === '') problems.push(problem('ASSET_KEPT_RECORD', `${name}: kept asset must record its owner creator`));
      if ((f.price ?? '') === '') problems.push(problem('ASSET_KEPT_RECORD', `${name}: kept asset must record its price`));
      if (creator !== '' && !OWN_CREATOR.test(creator) && !validAuthorization(f.authorized)) {
        problems.push(problem('ASSET_AUTHORIZED', `${name}: kept cross-owner asset needs a dated authorizing decision with a valid calendar date ("authorized: YYYY-MM-DD")`));
      }
    } else {
      problems.push(problem('ASSET_STATUS', `${name}: status must be kept or rejected`));
    }
  }
  if (!primitive && finalId !== undefined && !piece.candidates.some(c => c.id === finalId && (c.fields.status ?? '').toLowerCase() === 'kept')) {
    problems.push(problem('ASSET_KEPT_RECORD', `${label}: final asset ${finalId} has no kept candidate row with creator, price and authorization`));
  }
  return problems;
}

const isoOf = time => (time > 0 ? new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'never');

/**
 * Check one gate.
 * @returns `{ scope, file, ok, problems: [{ rule, text }], gate, mtime, latest, watch }`.
 */
export function checkGate(root, scope) {
  const file = path.join(root, 'docs', scope, GATE_FILE);
  const problems = [];
  let text;
  let mtime = 0;
  try {
    text = readFileSync(file, 'utf8');
    mtime = statSync(file).mtimeMs;
  } catch {
    return { scope, file, ok: false, problems: [problem('GATE_MISSING', `docs/${scope}/${GATE_FILE} is missing or unreadable`)],
      gate: undefined, mtime, latest: { time: 0 }, watch: watchSpec(undefined) };
  }
  const gate = parseGate(text);
  if (gate.verdict !== 'PASS') problems.push(problem('VERDICT', `verdict is ${gate.verdict ?? 'missing'}, not PASS`));
  if (gate.reviewer === undefined) problems.push(problem('REVIEWER', 'no "Reviewer: <worker name> (visual/standard|visual/expert)" line'));
  else if (gate.role !== 'visual/standard' && gate.role !== 'visual/expert') problems.push(problem('REVIEWER', `reviewer ${gate.reviewer} is not a visual/standard or visual/expert worker`));
  if (gate.screenshots.length < MIN_SCREENSHOTS) problems.push(problem('SCREENSHOTS', `lists ${gate.screenshots.length} screenshot(s); at least ${MIN_SCREENSHOTS} are required`));
  if (gate.checklist.length < MIN_CHECKLIST) problems.push(problem('CHECKLIST', `checklist has ${gate.checklist.length} item(s); at least ${MIN_CHECKLIST} are required`));
  const open = gate.checklist.filter(item => !item.checked);
  if (gate.verdict === 'PASS' && open.length > 0) problems.push(problem('CHECKLIST_OPEN', `PASS with ${open.length} unchecked checklist item(s): ${open.map(item => item.text).join('; ')}`));
  const watch = watchSpec(gate);
  if (gate.clientSourceExplicit && watch.watched.length === 0) {
    problems.push(problem('CLIENT_SOURCE', 'explicit "Client source:" must list at least one existing project-relative file or folder; omit the line to use defaults'));
  }
  const latest = latestChange(root, watch.watched, watch.ignored, { allowMissing: !gate.clientSourceExplicit });
  problems.push(...latest.problems);
  if (latest.time > 0 && mtime <= latest.time) {
    problems.push(problem('STALE', `${latest.path} changed ${isoOf(latest.time)}, after the gate file (${isoOf(mtime)}); re-review with fresh screenshots, or add the path to "Ignore:" if it is not a visual change`));
  }
  const sourcing = gate.assetSourcing;
  const reason = sourcing.notApplicable[0] ?? '';
  // A deliberate UI-only exemption must describe the work, not just say N/A/no assets.
  const substantiveUiOnly = reason.length >= 24 && /\bUI[- ]only\b/i.test(reason)
    && (reason.match(/[A-Za-z]{2,}/g) ?? []).length >= 5 && !/[<>]/.test(reason);
  if (sourcing.sections !== 1 || sourcing.outsidePieces > 0
    || (gate.pieces.length === 0 ? sourcing.notApplicable.length !== 1 || !substantiveUiOnly : sourcing.notApplicable.length > 0)) {
    problems.push(problem('ASSET_SOURCING', 'include exactly one "## Asset sourcing" section with at least one "### Piece:" block, or "Not applicable: <substantive UI-only reason>" without Piece blocks'));
  }
  for (const piece of gate.pieces) problems.push(...pieceProblems(piece));
  return { scope, file, ok: problems.length === 0, problems, gate, mtime, latest, watch };
}

/**
 * Check every gate (or one scope).
 * @returns `{ ok, gates }`; ok is false when no gate exists.
 */
export function checkVisualGate(root, { scope } = {}) {
  const scopes = scope === undefined ? gateScopes(root) : [scope];
  if (scopes.length === 0) {
    return { ok: false, gates: [{ scope: '', file: '', ok: false, problems: [problem('GATE_MISSING', `no docs/<scope>/${GATE_FILE} found`)],
      gate: undefined, mtime: 0, latest: { time: 0 }, watch: watchSpec(undefined) }] };
  }
  const gates = scopes.map(name => checkGate(root, name));
  return { ok: gates.every(gate => gate.ok), gates };
}

/** The rule table as printable lines. */
export function ruleLines() {
  return [
    ...Object.entries(RULES).map(([id, text]) => `${id.padEnd(22)} ${text}`),
    '',
    `Watched by default ("Client source:" overrides): ${DEFAULT_CLIENT_SOURCE.join(', ')}`,
    `Ignored by default ("Ignore:" overrides): ${DEFAULT_IGNORE.join(', ')}`,
    `Always ignored: ${ALWAYS_IGNORED.join(', ')}`,
  ];
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--rules')) {
    for (const line of ruleLines()) console.log(line);
  } else {
    const result = checkVisualGate(process.cwd(), { scope: args.find(arg => !arg.startsWith('--')) });
    for (const gate of result.gates) {
      const where = gate.scope === '' ? 'visual gate' : `docs/${gate.scope}/${GATE_FILE}`;
      if (gate.ok) console.log(`${where}: PASS`);
      else for (const item of gate.problems) console.log(`${where}: [${item.rule}] ${item.text}`);
    }
    console.log(result.ok ? 'visual gate PASSED' : 'visual gate FAILED');
    process.exitCode = result.ok ? 0 : 1;
  }
}
