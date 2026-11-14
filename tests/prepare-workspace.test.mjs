import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareWorkspace } from '../scripts/prepare-workspace.mjs';
const testRoot = fileURLToPath(new URL('../.cache/', import.meta.url));
function fixture(t) {
  mkdirSync(testRoot, { recursive: true });
  const base = mkdtempSync(path.join(testRoot, 'prepare-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const source = path.join(base, 'outside-profile');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(source, 'selene'), { recursive: true });
  writeFileSync(path.join(source, 'selene', 'roblox.yml'), 'base: lua51\nglobals: {}\n');
  writeFileSync(path.join(root, 'selene.toml'), 'std = "roblox"\n');
  return { root, source };
}
test('seeds Selene config-parent standard without modifying config or source cache', t => {
  const f = fixture(t);
  const result = prepareWorkspace({ workspace: f.root, cwd: path.join(f.root, 'src'), sourceAppData: f.source });
  assert.deepEqual(result.seeded, [path.join(f.root, 'roblox.yml')]);
  assert.equal(readFileSync(result.seeded[0], 'utf8'), 'base: lua51\nglobals: {}\n');
  assert.equal(readFileSync(path.join(f.root, 'selene.toml'), 'utf8'), 'std = "roblox"\n');
  assert.equal(readFileSync(path.join(f.source, 'selene', 'roblox.yml'), 'utf8'), 'base: lua51\nglobals: {}\n');
  writeFileSync(result.seeded[0], 'user standard');
  assert.deepEqual(prepareWorkspace({ workspace: f.root, sourceAppData: f.source }).seeded, []);
  assert.equal(readFileSync(result.seeded[0], 'utf8'), 'user standard');
});
test('missing cache needs explicit local generator, not a global write', t => {
  const f = fixture(t);
  assert.deepEqual(prepareWorkspace({ workspace: f.root }).seeded, []);
  assert.equal(existsSync(path.join(f.root, 'roblox.yml')), false);
});
test('refuses outside working directories and explicit configs before copying', t => {
  const f = fixture(t);
  assert.throws(() => prepareWorkspace({ workspace: f.root, cwd: f.source }), /outside/);
  assert.throws(() => prepareWorkspace({ workspace: f.root, config: '../outside-profile/selene.toml', sourceAppData: f.source }), /outside/);
});
