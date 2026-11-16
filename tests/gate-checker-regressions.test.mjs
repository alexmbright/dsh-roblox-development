import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkVisualGate, parseGate, latestChange, watchSpec, globToRegExp, pieceProblems,
  DEFAULT_CLIENT_SOURCE, DEFAULT_IGNORE, MIN_QUERIES,
} from '../tools/check-visual-gate.mjs';

const T0 = Date.parse('2026-11-15T12:00:00Z');
const SCRIPT = fileURLToPath(new URL('../tools/check-visual-gate.mjs', import.meta.url));
const UI_ONLY = '## Asset sourcing\nNot applicable: UI-only menu layout changes; no scene art or imported assets were added or modified.\n';
const BASE = `# Visual gate
Verdict: PASS
Reviewer: reviewer (visual/standard)
Client source: src/client
Screenshots:
- screenshots/menu.png
- screenshots/hud.png
- screenshots/scene.png

## Checklist
- [x] readable on phone
- [x] clear hierarchy
- [x] consistent palette
- [x] no placeholder art
- [x] nothing clipped

${UI_ONLY}`;

function project(t, text = BASE) {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-checker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (relative, contents = 'return {}', time = T0) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    utimesSync(full, time / 1000, time / 1000);
    return full;
  };
  file('src/client/Menu.luau');
  const gate = value => file('docs/launch/VISUAL_GATE.md', value, T0 + 60_000);
  gate(text);
  return { root, file, gate, check: () => checkVisualGate(root).gates[0] };
}
const rules = result => result.problems.map(item => item.rule);
const assetGate = piece => BASE.replace(UI_ONLY, `## Asset sourcing\n${piece}\n`);
const candidate = (id = '1234567', extra = '') => `${id} | creator: alice | price: free | thumbnail: yes | details: yes | status: kept | authorized: 2026-11-15${extra}`;
const piece = (final = '1234567', row = candidate()) => `### Piece: tree\nFinal: ${final}\nCandidates:\n- ${row}`;

test('Verdict must be the entire PASS or FAIL value, not a passing prefix', t => {
  const p = project(t);
  for (const value of ['PASS|FAIL', 'PASS pending review', 'PASS-ish', 'PASS FAIL', 'PASS <!-- draft -->']) {
    p.gate(BASE.replace('Verdict: PASS', `Verdict: ${value}`));
    assert.ok(rules(p.check()).includes('VERDICT'), value);
    assert.equal(parseGate(`Verdict: ${value}`).verdict, undefined);
  }
  assert.equal(parseGate('Verdict: pass').verdict, 'PASS');
  assert.equal(parseGate('Verdict: FAIL').verdict, 'FAIL');
  p.gate(BASE);
  assert.equal(p.check().ok, true);
});

test('absent default folders are okay but explicit missing or empty Client source fails', t => {
  const p = project(t, BASE.replace('Client source: src/client\n', ''));
  assert.equal(p.check().ok, true);
  assert.deepEqual(p.check().watch.watched, DEFAULT_CLIENT_SOURCE);
  for (const watch of ['src/typo', 'src/client, src/typo', '', ' ; , ']) {
    p.gate(BASE.replace('Client source: src/client', `Client source: ${watch}`));
    assert.ok(rules(p.check()).includes('CLIENT_SOURCE'), JSON.stringify(watch));
  }
});

test('explicit watched FILE paths participate in stale checks and Ignore filtering', t => {
  const p = project(t, BASE.replace('Client source: src/client', 'Client source: src/client/Menu.luau'));
  assert.equal(p.check().ok, true);
  p.file('src/client/Menu.luau', 'return { changed = true }', T0 + 120_000);
  assert.ok(rules(p.check()).includes('STALE'));
  assert.equal(p.check().latest.path, 'src/client/Menu.luau');
  p.gate(`${BASE.replace('Client source: src/client', 'Client source: src/client/Menu.luau')}Ignore: src/client/Menu.luau\n`);
  assert.equal(p.check().ok, true);
});

test('invalid watch syntax is rejected even when another watched path is valid', t => {
  const p = project(t);
  for (const invalid of ['src/**', 'src/client/*.luau', 'src/client/?.luau', 'src/[client]', 'src/{client}', '../outside', 'src/../src/client', '/tmp', 'C:\\temp', 'C:temp', '\\\\server\\share', 'src\\client']) {
    p.gate(BASE.replace('Client source: src/client', `Client source: src/client, ${invalid}`));
    assert.ok(rules(p.check()).includes('CLIENT_SOURCE'), invalid);
  }
  p.gate(BASE.replace('Client source: src/client', 'Client source: ./src/client/'));
  assert.equal(p.check().ok, true);
});

test('watch symlinks escaping the project fail closed, including nested symlinks', t => {
  const p = project(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'gate-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'outside.luau'), 'return {}');
  symlinkSync(outside, path.join(p.root, 'src/client/external'), 'dir');
  assert.ok(rules(p.check()).includes('CLIENT_SOURCE'));
  p.gate(BASE.replace('Client source: src/client', 'Client source: src/client/external/outside.luau'));
  assert.ok(rules(p.check()).includes('CLIENT_SOURCE'));
});

test('inside-project symlink files are watched and cycles/dangling links fail closed', t => {
  const p = project(t);
  p.file('shared/Theme.luau', 'return { theme = "bright" }', T0 + 120_000);
  symlinkSync(path.join(p.root, 'shared/Theme.luau'), path.join(p.root, 'src/client/Theme.luau'));
  assert.ok(rules(p.check()).includes('STALE'));
  assert.equal(p.check().latest.path, 'src/client/Theme.luau');
  symlinkSync(path.join(p.root, 'src/client'), path.join(p.root, 'src/client/loop'), 'dir');
  assert.ok(p.check().problems.some(item => item.rule === 'CLIENT_SOURCE' && /cycle/.test(item.text)));
  const dangling = project(t, BASE.replace('Client source: src/client\n', ''));
  symlinkSync(path.join(dangling.root, 'absent'), path.join(dangling.root, 'assets'), 'dir');
  assert.ok(rules(dangling.check()).includes('CLIENT_SOURCE'), 'dangling default is not an absent optional folder');
});

test('ignored missing explicit sources still fail and equal mtimes remain stale', t => {
  const p = project(t, `${BASE.replace('Client source: src/client', 'Client source: absent.rbxm')}Ignore: absent.rbxm\n`);
  assert.ok(rules(p.check()).includes('CLIENT_SOURCE'));
  p.gate(BASE);
  p.file('src/client/Menu.luau', 'return {}', T0 + 60_000);
  assert.ok(rules(p.check()).includes('STALE'), 'gate must be strictly newer, not equal');
});

test('generated runtime assets and manifests remain watched by default', t => {
  const p = project(t, BASE.replace('Client source: src/client\n', ''));
  for (const relative of ['assets/generated/Tree.rbxm', 'assets/manifest.json']) {
    p.file(relative, '{}', T0 + 120_000);
    assert.ok(rules(p.check()).includes('STALE'), relative);
  }
  assert.ok(!DEFAULT_IGNORE.includes('assets/generated/**'));
  assert.ok(!DEFAULT_IGNORE.includes('assets/manifest.json'));
  p.file('assets/backup/Tree.rbxm', 'backup', T0 + 180_000);
  p.gate(`${BASE.replace('Client source: src/client\n', '')}Ignore: assets/generated/**, assets/manifest.json\n`);
  assert.ok(rules(p.check()).includes('STALE'), 'custom Ignore replaces backup defaults');
  p.gate(`${BASE.replace('Client source: src/client\n', '')}Ignore: ${DEFAULT_IGNORE.join(', ')}, assets/generated/**, assets/manifest.json\n`);
  assert.equal(p.check().ok, true);
});

test('Asset sourcing is mandatory with real Piece records or a substantive UI-only exemption', t => {
  const p = project(t);
  for (const section of ['', '## Asset sourcing\n', '## Asset sourcing\nNot applicable:\n', '## Asset sourcing\nNot applicable: N/A\n', '## Asset sourcing\nNot applicable: no assets\n', '## Findings\nNot applicable: UI-only layout changes without scene art or imported assets.\n', '### Piece: tree\nFinal: 1234567\n']) {
    p.gate(BASE.replace(UI_ONLY, section));
    assert.ok(rules(p.check()).includes('ASSET_SOURCING'), section);
  }
  p.gate(BASE);
  assert.equal(p.check().ok, true);
  p.gate(assetGate(piece()));
  assert.equal(p.check().ok, true);
  p.gate(BASE.replace(UI_ONLY, `${UI_ONLY}\n${piece()}`));
  assert.ok(rules(p.check()).includes('ASSET_SOURCING'), 'N/A cannot conceal art records');
  p.gate(`${BASE}\n${UI_ONLY}`);
  assert.ok(rules(p.check()).includes('ASSET_SOURCING'), 'duplicate sourcing sections are ambiguous');
  p.gate(BASE.replace(UI_ONLY, `## Asset sourcing\n\n## Findings\n${piece()}\n`));
  assert.ok(rules(p.check()).includes('ASSET_SOURCING'), 'Piece blocks must be inside the sourcing section');
});

test('primitive six-query sourcing policy remains intact', t => {
  const p = project(t, assetGate('### Piece: tree\nFinal: primitive'));
  assert.equal(MIN_QUERIES, 6);
  assert.ok(rules(p.check()).includes('ASSET_QUERIES'));
  assert.ok(rules(p.check()).includes('ASSET_CANDIDATES'));
  const rejected = '1234567 | thumbnail: yes | details: yes | in-scene: yes | status: rejected | reason: realistic foliage clashes with the flat scene palette';
  const queries = ['pine tree', 'stylized tree', 'low poly tree', 'forest pack', 'cartoon tree', 'tree model'];
  p.gate(assetGate(`### Piece: tree\nFinal: primitive\nQueries: ${queries.join('; ')}\nCandidates:\n- ${rejected}`));
  assert.equal(p.check().ok, true);
  p.gate(assetGate(`### Piece: tree\nFinal: primitive\nQueries: ${[...queries.slice(0, 5), 'PINE TREE'].join('; ')}\nCandidates:\n- ${rejected}`));
  assert.ok(rules(p.check()).includes('ASSET_QUERIES'));
});

test('cross-owner authorization must be a real complete calendar date', t => {
  const p = project(t);
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-11-15pending', '2026-11-15 pending', 'YYYY-MM-DD']) {
    p.gate(assetGate(piece('1234567', candidate().replace('2026-11-15', date))));
    assert.ok(rules(p.check()).includes('ASSET_AUTHORIZED'), date);
  }
  p.gate(assetGate(piece('1234567', candidate().replace('2026-11-15', '2024-02-29'))));
  assert.equal(p.check().ok, true);
});

test('final asset id must link to a kept candidate and cannot mix primitive and id', t => {
  const p = project(t);
  for (const [final, row] of [['7654321', candidate()], ['1234567', candidate().replace('status: kept', 'status: rejected')], ['primitive fallback for 1234567', candidate()]]) {
    p.gate(assetGate(piece(final, row)));
    assert.equal(p.check().ok, false, final);
    assert.ok(rules(p.check()).some(rule => rule === 'ASSET_KEPT_RECORD' || rule === 'ASSET_FINAL'));
  }
  p.gate(assetGate(piece()));
  assert.equal(p.check().ok, true);
});

test('helpers preserve glob semantics, defaults, file mtimes and invalid-watch evidence', t => {
  assert.equal(globToRegExp('**/backup/**').test('assets/backup/tree.rbxm'), true);
  assert.equal(globToRegExp('assets/*.rbxm').test('assets/generated/tree.rbxm'), false);
  assert.equal(globToRegExp('src/?.luau').test('src/A.luau'), true);
  assert.equal(globToRegExp('assets/file.json').test('assets/fileXjson'), false);
  assert.deepEqual(watchSpec({ clientSource: ['src/client'], ignore: [] }).watched, ['src/client']);
  assert.ok(watchSpec(undefined).ignored.includes('assets/backup/**'));
  const p = project(t);
  const found = latestChange(p.root, ['src/client/Menu.luau']);
  assert.equal(found.time, T0);
  assert.equal(found.path, 'src/client/Menu.luau');
  assert.deepEqual(found.problems, []);
  assert.ok(latestChange(p.root, ['../outside']).problems.some(item => item.rule === 'CLIENT_SOURCE'));
  assert.ok(pieceProblems({ name: 'tree', final: '7654321', queries: [], candidates: [] }).some(item => item.rule === 'ASSET_KEPT_RECORD'));
});

test('standalone CLI rejects malformed verdict and missing sourcing with rule ids', t => {
  const p = project(t, BASE.replace('Verdict: PASS', 'Verdict: PASS|FAIL').replace(UI_ONLY, ''));
  const failed = spawnSync(process.execPath, [SCRIPT], { cwd: p.root, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /\[VERDICT\]/);
  assert.match(failed.stdout, /\[ASSET_SOURCING\]/);
  p.gate(BASE);
  const passed = spawnSync(process.execPath, [SCRIPT, 'launch'], { cwd: p.root, encoding: 'utf8' });
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /visual gate PASSED/);
});
