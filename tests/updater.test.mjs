import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO, UPSTREAM, isTrustedOrigin, updateBrain } from '../scripts/update-brain.mjs';

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'brain updater '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'upstream.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'cache', 'brain');
  mkdirSync(seed);
  git(root, 'init', '--bare', remote);
  git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Updater Test');
  git(seed, 'config', 'user.email', 'updater@example.invalid');
  mkdirSync(path.join(seed, 'skills', 'one'), { recursive: true });
  writeFileSync(path.join(seed, 'skills', 'one', 'SKILL.md'), 'initial\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const update = () => updateBrain(repo, { trustedRemote: remote });
  const advance = () => {
    mkdirSync(path.join(seed, 'skills', 'two'));
    writeFileSync(path.join(seed, 'skills', 'two', 'SKILL.md'), 'second\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'upstream change');
    git(seed, 'push');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const localCommit = () => {
    git(repo, 'config', 'user.name', 'Updater Test');
    git(repo, 'config', 'user.email', 'updater@example.invalid');
    writeFileSync(path.join(repo, 'local.txt'), 'preserve me\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'local change');
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { repo, seed, remote, update, advance, localCommit };
}

test('import is silent and default checkout is a writable user cache', () => {
  assert.equal(DEFAULT_REPO, path.join(homedir(), '.cache', 'dsh-roblox-development', 'roblox-brain'));
  const url = new URL('../scripts/update-brain.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('origin matching allows only exact upstream HTTPS and SSH forms', () => {
  for (const url of [UPSTREAM, 'https://github.com/TabooHarmony/roblox-brain', 'git@github.com:TabooHarmony/roblox-brain.git', 'ssh://git@github.com/TabooHarmony/roblox-brain.git']) {
    assert.equal(isTrustedOrigin(url), true, url);
  }
  for (const url of ['https://token@github.com/TabooHarmony/roblox-brain.git', 'https://github.com.evil.test/TabooHarmony/roblox-brain.git', 'git@github.com:Other/roblox-brain.git', 'http://github.com/TabooHarmony/roblox-brain.git', 'https://github.com/TabooHarmony/roblox-brain.git?token=secret']) {
    assert.equal(isTrustedOrigin(url), false, url);
  }
});

test('initial clone uses upstream default branch and reports actual SHA and skills', t => {
  const f = fixture(t);
  const result = f.update();
  assert.equal(result.cloned, true);
  assert.equal(result.branch, 'main');
  assert.equal(result.commit, git(f.seed, 'rev-parse', 'HEAD'));
  assert.equal(result.commit, git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(result.skillCount, 1);
  assert.equal(result.repository, UPSTREAM);
});

test('clean refresh fast-forwards and is idempotent', t => {
  const f = fixture(t);
  f.update();
  const target = f.advance();
  const result = f.update();
  assert.equal(result.cloned, false);
  assert.equal(result.commit, target);
  assert.equal(result.skillCount, 2);
  assert.equal(f.update().commit, target);
});

test('dirty tracked or untracked content is preserved and refused', t => {
  const f = fixture(t);
  const before = f.update().commit;
  f.advance();
  const tracked = path.join(f.repo, 'skills', 'one', 'SKILL.md');
  writeFileSync(tracked, 'local edit\n');
  assert.throws(f.update, /Local changes/);
  assert.equal(readFileSync(tracked, 'utf8'), 'local edit\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  git(f.repo, 'restore', '--', 'skills/one/SKILL.md');
  writeFileSync(path.join(f.repo, 'untracked.txt'), 'keep\n');
  assert.throws(f.update, /Local changes/);
  assert.equal(readFileSync(path.join(f.repo, 'untracked.txt'), 'utf8'), 'keep\n');
});

for (const diverged of [false, true]) {
  test(`${diverged ? 'diverged' : 'ahead'} checkout is refused without losing commits`, t => {
    const f = fixture(t);
    f.update();
    const local = f.localCommit();
    if (diverged) f.advance();
    assert.throws(f.update, diverged ? /diverged/ : /ahead/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), local);
    assert.equal(readFileSync(path.join(f.repo, 'local.txt'), 'utf8'), 'preserve me\n');
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
  });
}

test('failed fast-forward preserves HEAD and ignored local files', t => {
  const f = fixture(t);
  const before = f.update().commit;
  writeFileSync(path.join(f.repo, '.git', 'info', 'exclude'), 'collision.txt\n');
  writeFileSync(path.join(f.repo, 'collision.txt'), 'local ignored content\n');
  writeFileSync(path.join(f.seed, 'collision.txt'), 'upstream content\n');
  git(f.seed, 'add', '.');
  git(f.seed, 'commit', '-m', 'add colliding file');
  git(f.seed, 'push');
  assert.throws(f.update, /Git operation failed/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(path.join(f.repo, 'collision.txt'), 'utf8'), 'local ignored content\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('changed upstream HEAD refuses old default branch', t => {
  const f = fixture(t);
  const before = f.update().commit;
  git(f.seed, 'checkout', '-b', 'next');
  git(f.seed, 'push', '-u', 'origin', 'next');
  git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/next');
  assert.throws(f.update, /default branch/);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
});

test('unexpected origin, alternate branch and detached HEAD are refused', t => {
  const f = fixture(t);
  const before = f.update().commit;
  git(f.repo, 'checkout', '-b', 'personal');
  assert.throws(f.update, /default branch/);
  git(f.repo, 'checkout', '--detach', before);
  assert.throws(f.update, /default branch/);
  git(f.repo, 'checkout', 'main');
  git(f.repo, 'remote', 'set-url', 'origin', 'https://secret@invalid.example/private');
  assert.throws(f.update, error => /Unexpected origin/.test(error.message) && !error.message.includes('secret'));
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before);
});
