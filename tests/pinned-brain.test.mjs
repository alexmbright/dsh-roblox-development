import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
test('pinned skill snapshot has a complete offline catalog and preserved license', () => {
  const provenance = JSON.parse(read('vendor/roblox-brain/provenance.json'));
  assert.equal(provenance.commit, 'ceee4aaa5004502e2a51d78b3c33bba44d84742b');
  const skills = [];
  for (const library of provenance.libraries) {
    const base = new URL(`vendor/roblox-brain/skills/${library}/`, root);
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const body = readFileSync(new URL(`${dir.name}/SKILL.md`, base), 'utf8');
      assert.match(body, /^---\r?\nname: roblox-/);
      skills.push(dir.name);
    }
  }
  assert.equal(skills.length, provenance.skillCount);
  assert.equal(new Set(skills).size, 29);
  assert.match(read('vendor/roblox-brain/LICENSE'), /Copyright \(c\) 2026 TabooHarmony/);
  const patch = read('cordis.patch.yml');
  assert.match(patch, /path.join\(bundle, 'vendor', 'roblox-brain'\)/);
  assert.doesNotMatch(patch, /homedir\(\)|fetch and fast-forward the latest/);
});
