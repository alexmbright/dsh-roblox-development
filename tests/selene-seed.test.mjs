import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyStandardSeeds, discoverStandardSeeds } from '../workspace-runtime.js';

const fsLike = { existsSync, copyFileSync, lstatSync, statSync, realpathSync };

test('a missing standard is seeded from the bundled asset', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  const project = path.join(root, 'Game One');   // a directory name containing a space
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'selene.toml'), 'std = "roblox"\n');
  const source = path.join(root, 'vendor-roblox.yml');
  writeFileSync(source, 'std: roblox\n');

  const seeds = discoverStandardSeeds({ root, workdir: project, source, config: undefined, fsLike });
  assert.equal(seeds.length, 1);
  const written = applyStandardSeeds(fsLike, seeds);
  assert.deepEqual(written, [path.join(project, 'roblox.yml')]);
  assert.equal(readFileSync(path.join(project, 'roblox.yml'), 'utf8'), 'std: roblox\n');
});

test('an existing project standard is never overwritten', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  const project = path.join(root, 'Game Two');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'selene.toml'), 'std = "roblox"\n');
  writeFileSync(path.join(project, 'roblox.yml'), 'user owned\n');
  const source = path.join(root, 'vendor-roblox.yml');
  writeFileSync(source, 'std: roblox\n');

  const seeds = discoverStandardSeeds({ root, workdir: project, source, config: undefined, fsLike });
  assert.deepEqual(seeds, [], 'nothing to seed when the file exists');
  assert.deepEqual(applyStandardSeeds(fsLike, seeds), []);
  assert.equal(readFileSync(path.join(project, 'roblox.yml'), 'utf8'), 'user owned\n');
});

test('a seed failure never throws', () => {
  const written = applyStandardSeeds({ existsSync: () => false, copyFileSync: () => { throw new Error('EACCES'); } },
    [{ source: '/nope', destination: '/nope/roblox.yml' }]);
  assert.deepEqual(written, []);
});

test('nearest selene.toml wins and a symlinked config path is refused', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  const nested = path.join(root, 'game', 'src');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(root, 'selene.toml'), 'std = "roblox"\n');
  const source = path.join(root, 'vendor-roblox.yml');
  writeFileSync(source, 'std: roblox\n');
  const seeds = discoverStandardSeeds({ root, workdir: nested, source, config: undefined, fsLike });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].destination, path.join(root, 'roblox.yml'));
});

test('the shell delegate seeds the standard before executing a command', async () => {
  const { createShellDelegate } = await import('../workspace-runtime.js');
  const root = mkdtempSync(path.join(tmpdir(), 'delegate-'));
  const project = path.join(root, 'Game Two');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'selene.toml'), 'std = "roblox"\n');
  const source = path.join(root, 'vendor-roblox.yml');
  writeFileSync(source, 'std: roblox\n');

  const executed = [];
  const base = {
    sandboxMode: 'workspace-write',
    resolve: request => request,
    execute: spec => { executed.push(spec); return { ok: true }; },
  };
  const delegate = createShellDelegate(base, {
    platform: process.platform,
    dialect: 'bash',
    fsLike,
    originalEnv: { PATH: process.env.PATH ?? '/usr/bin' },
    prepare: { seedSource: source },
    toolPlanFor: () => ({ tools: [], toolDirs: [], lune: null, warnings: [], blockedTools: [] }),
  });

  delegate.execute({
    command: 'selene src',
    workdir: project,
    env: {},
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: root },
  });

  assert.equal(existsSync(path.join(project, 'roblox.yml')), true, 'standard seeded before the shell ran');
  assert.equal(readFileSync(path.join(project, 'roblox.yml'), 'utf8'), 'std: roblox\n');
  assert.equal(executed.length, 1, 'the command still ran');
});
