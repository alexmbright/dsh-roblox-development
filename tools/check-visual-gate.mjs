#!/usr/bin/env node
/**
 * Visual gate check for a Roblox project.
 *
 * Usage: node tools/check-visual-gate.mjs [scope]
 *   Checks docs/<scope>/VISUAL_GATE.md, or every docs/<scope>/VISUAL_GATE.md when no scope is given.
 *   Exits 0 when every gate passes, 1 otherwise, printing one problem per line.
 *
 * Self-contained (Node built-ins only) so a project can copy it verbatim. The Roblox mode runs the
 * same checks in-process when a goal is completed, and also runs the project's copy when present.
 *
 * A gate passes only when its file has:
 *   - "Verdict: PASS" and a checklist of at least 5 items, all checked;
 *   - "Reviewer: <worker name> (visual/standard)" or "(visual/expert)";
 *   - at least 3 distinct screenshot names under "Screenshots:";
 *   - a modified time newer than the newest file under the client source folders
 *     ("Client source:" line, default src/client, src/StarterGui, src/StarterPlayer,
 *     src/ReplicatedFirst, assets);
 *   - valid asset-sourcing evidence for every "### Piece:" under "## Asset sourcing".
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_FILE = 'VISUAL_GATE.md';
export const DEFAULT_CLIENT_SOURCE = ['src/client', 'src/StarterGui', 'src/StarterPlayer', 'src/ReplicatedFirst', 'assets'];
export const MIN_SCREENSHOTS = 3;
export const MIN_CHECKLIST = 5;
export const MIN_QUERIES = 6;
const OWN_CREATOR = /^(?:own|self|project|ours|first-party|roblox)$/i;
const FIXABLE_ONLY = /^(?:[\s,;.&/+-]|and|or|too|many|high|has|have|contains|script|scripts|tri|tris|triangle|triangles|triangle-count|count|poly|polys|polygon|polygons|bad|wrong|off|pivot|pivots|scale|scaled|size|sized|backdoor|backdoors|virus|malicious)+$/i;

/** Every docs/<scope>/VISUAL_GATE.md under the project root, as scope names. */
export function gateScopes(root) {
  const docs = path.join(root, 'docs');
  let entries;
  try {
    entries = readdirSync(docs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory() && existsSync(path.join(docs, entry.name, GATE_FILE)))
    .map(entry => entry.name).sort();
}

const field = (text, label) => new RegExp(`^[ \\t>*_-]*${label}:[*_]*[ \\t]*(.*)$`, 'im').exec(text)?.[1]?.trim();

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

/** Parse "key: value | key: value" candidate rows. */
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

/**
 * Parse one gate file.
 * @returns verdict, reviewer, role, screenshots, checklist and asset pieces.
 */
export function parseGate(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const verdict = /^(PASS|FAIL)\b/i.exec(field(text, 'Verdict') ?? '')?.[1]?.toUpperCase();
  const reviewerLine = field(text, 'Reviewer') ?? '';
  const reviewerMatch = /^`?([A-Za-z0-9][\w./-]*)`?\s*(?:\(([^)]*)\))?/.exec(reviewerLine);
  const reviewer = reviewerMatch?.[1];
  const role = /visual\/(?:fast|standard|expert)/i.exec(reviewerMatch?.[2] ?? reviewerLine)?.[0]?.toLowerCase();
  const shotsIndex = lines.findIndex(line => /^[ \t>*_-]*Screenshots:[*_]*[ \t]*$/i.test(line));
  const inlineShots = field(text, 'Screenshots');
  const screenshots = shotsIndex >= 0 ? bullets(lines, shotsIndex + 1)
    : (inlineShots ?? '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
  const checklist = lines.map(line => /^[ \t]*[-*+][ \t]+\[( |x|X)\][ \t]+(.+)$/.exec(line))
    .filter(Boolean).map(match => ({ checked: match[1] !== ' ', text: match[2].trim() }));
  const clientSource = (field(text, 'Client source') ?? '').split(/[,;]/).map(item => item.trim().replace(/^`|`$/g, '')).filter(Boolean);

  const pieces = [];
  let current;
  let mode;
  for (const line of lines) {
    const piece = /^###[ \t]+Piece:[ \t]*(.+)$/i.exec(line);
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
  return { verdict, reviewer, role, screenshots: [...new Set(screenshots)], checklist, clientSource, pieces };
}

/** Newest modification time (ms) of any file under the given folders, or 0. */
export function latestChange(root, folders) {
  let newest = 0;
  let newestPath;
  const walk = dir => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const time = statSync(full).mtimeMs;
          if (time > newest) { newest = time; newestPath = full; }
        } catch { /* vanished */ }
      }
    }
  };
  for (const folder of folders) walk(path.resolve(root, folder));
  return { time: newest, path: newestPath === undefined ? undefined : path.relative(root, newestPath) };
}

/** Asset-sourcing problems for one piece. */
export function pieceProblems(piece) {
  const problems = [];
  const label = `piece "${piece.name}"`;
  const primitive = /\b(?:primitive|part|parts|csg|code-built|procedural|placeholder|greybox)\b/i.test(piece.final);
  const finalId = /(\d{4,})/.exec(piece.final)?.[1];
  if (!primitive && finalId === undefined) problems.push(`${label}: "Final:" must name the kept asset id or say primitive`);
  if (primitive) {
    const distinct = new Set(piece.queries.map(q => q.toLowerCase()));
    if (distinct.size < MIN_QUERIES) problems.push(`${label}: primitive final art needs at least ${MIN_QUERIES} distinct search_assets queries (found ${distinct.size})`);
    if (piece.candidates.length === 0) problems.push(`${label}: primitive final art needs the shortlisted candidates and why each was rejected`);
  }
  for (const candidate of piece.candidates) {
    const name = `${label} candidate ${candidate.id ?? '(no id)'}`;
    const f = candidate.fields;
    if (candidate.id === undefined) problems.push(`${name}: no asset id`);
    if (!/^(?:yes|viewed|seen|true)$/i.test(f.thumbnail ?? '')) problems.push(`${name}: thumbnail not viewed (get_asset_thumbnail)`);
    if (!/^(?:yes|viewed|read|seen|true)$/i.test(f.details ?? '')) problems.push(`${name}: details not read (get_asset_details)`);
    const status = (f.status ?? '').toLowerCase();
    if (status === 'rejected') {
      const reason = f.reason ?? '';
      if (reason.length < 12 || FIXABLE_ONLY.test(reason)) {
        problems.push(`${name}: rejection reason "${reason}" is missing or only a fixable issue (scripts, triangles, pivot and scale are fixable)`);
      }
      if (!/^(?:yes|viewed|seen|true)$/i.test(f['in-scene'] ?? '')) problems.push(`${name}: rejected without being seen in the scene (insert in Edit mode, strip scripts, rescale, then judge)`);
    } else if (status === 'kept') {
      const creator = f.creator ?? '';
      if (creator === '') problems.push(`${name}: kept asset must record its owner creator`);
      if ((f.price ?? '') === '') problems.push(`${name}: kept asset must record its price`);
      if (creator !== '' && !OWN_CREATOR.test(creator) && !/^\d{4}-\d{2}-\d{2}\b/.test(f.authorized ?? '')) {
        problems.push(`${name}: kept cross-owner asset needs a dated authorizing decision ("authorized: YYYY-MM-DD")`);
      }
    } else {
      problems.push(`${name}: status must be kept or rejected`);
    }
  }
  if (!primitive && finalId !== undefined && !piece.candidates.some(c => c.id === finalId && (c.fields.status ?? '').toLowerCase() === 'kept')) {
    problems.push(`${label}: final asset ${finalId} has no kept candidate row with creator, price and authorization`);
  }
  return problems;
}

/**
 * Check one gate.
 * @returns `{ scope, file, ok, problems, gate, mtime, latest }`.
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
    return { scope, file, ok: false, problems: [`docs/${scope}/${GATE_FILE} is missing or unreadable`], gate: undefined, mtime, latest: { time: 0 } };
  }
  const gate = parseGate(text);
  if (gate.verdict !== 'PASS') problems.push(`verdict is ${gate.verdict ?? 'missing'}, not PASS`);
  if (gate.reviewer === undefined) problems.push('no "Reviewer: <worker name> (visual/standard|visual/expert)" line');
  else if (gate.role !== 'visual/standard' && gate.role !== 'visual/expert') problems.push(`reviewer ${gate.reviewer} is not a visual/standard or visual/expert worker`);
  if (gate.screenshots.length < MIN_SCREENSHOTS) problems.push(`lists ${gate.screenshots.length} screenshot(s); at least ${MIN_SCREENSHOTS} are required`);
  if (gate.checklist.length < MIN_CHECKLIST) problems.push(`checklist has ${gate.checklist.length} item(s); at least ${MIN_CHECKLIST} are required`);
  const open = gate.checklist.filter(item => !item.checked);
  if (gate.verdict === 'PASS' && open.length > 0) problems.push(`PASS with ${open.length} unchecked checklist item(s): ${open.map(item => item.text).join('; ')}`);
  const folders = gate.clientSource.length > 0 ? gate.clientSource : DEFAULT_CLIENT_SOURCE;
  const latest = latestChange(root, folders);
  if (latest.time > 0 && mtime <= latest.time) {
    problems.push(`stale: ${latest.path} changed after the gate file was written; re-review with fresh screenshots`);
  }
  for (const piece of gate.pieces) problems.push(...pieceProblems(piece));
  return { scope, file, ok: problems.length === 0, problems, gate, mtime, latest };
}

/**
 * Check every gate (or one scope).
 * @returns `{ ok, gates }`; ok is false when no gate exists.
 */
export function checkVisualGate(root, { scope } = {}) {
  const scopes = scope === undefined ? gateScopes(root) : [scope];
  if (scopes.length === 0) {
    return { ok: false, gates: [{ scope: '', file: '', ok: false, problems: [`no docs/<scope>/${GATE_FILE} found`], gate: undefined, mtime: 0, latest: { time: 0 } }] };
  }
  const gates = scopes.map(name => checkGate(root, name));
  return { ok: gates.every(gate => gate.ok), gates };
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = checkVisualGate(process.cwd(), { scope: process.argv[2] });
  for (const gate of result.gates) {
    const where = gate.scope === '' ? 'visual gate' : `docs/${gate.scope}/${GATE_FILE}`;
    if (gate.ok) console.log(`${where}: PASS`);
    else for (const problem of gate.problems) console.log(`${where}: ${problem}`);
  }
  console.log(result.ok ? 'visual gate PASSED' : 'visual gate FAILED');
  process.exitCode = result.ok ? 0 : 1;
}
