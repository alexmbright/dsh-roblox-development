import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const UPSTREAM = 'https://github.com/TabooHarmony/roblox-brain.git';
export const DEFAULT_REPO = path.join(homedir(), '.cache', 'dsh-roblox-development', 'roblox-brain');

// Never include git output or command arguments in errors: either can contain credentials.
function git(repo, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  if (result.error || result.status !== 0) {
    throw new Error('Git operation failed; checkout was not reset. Check Git access and repository state.');
  }
  return result.stdout.trim();
}

export function isTrustedOrigin(remote) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)TabooHarmony\/roblox-brain(?:\.git)?\/?$/i.test(remote);
}

export function countSkills(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((count, entry) => {
    if (entry.isDirectory()) return count + countSkills(path.join(directory, entry.name));
    return count + Number(entry.isFile() && entry.name === 'SKILL.md');
  }, 0);
}

function requireClean(repo) {
  if (git(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'])) {
    throw new Error('Local changes present; preserving checkout.');
  }
}

// trustedRemote is an explicit programmatic test seam; CLI never accepts a remote override.
export function updateBrain(repo = DEFAULT_REPO, { trustedRemote } = {}) {
  repo = path.resolve(repo);
  const source = trustedRemote ?? UPSTREAM;
  const trusted = remote => trustedRemote === undefined ? isTrustedOrigin(remote) : remote === trustedRemote;
  const cloned = !existsSync(repo);
  if (cloned) {
    mkdirSync(path.dirname(repo), { recursive: true });
    git(path.dirname(repo), ['clone', '--origin', 'origin', '--', source, repo]);
  }
  // Do not accidentally operate on a parent repository when passed an ordinary subdirectory.
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (realpathSync(top) !== realpathSync(repo)) throw new Error('Path is not a repository root.');
  const remotes = git(repo, ['remote', 'get-url', '--all', 'origin']).split(/\r?\n/);
  if (remotes.length !== 1 || !trusted(remotes[0])) {
    throw new Error('Unexpected origin; preserving checkout.');
  }
  requireClean(repo);
  const branch = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD'])
    .match(/^ref: refs\/heads\/(\S+)\s+HEAD$/m)?.[1];
  if (!branch) throw new Error('Cannot discover upstream default branch.');
  git(repo, ['check-ref-format', `refs/heads/${branch}`]);
  if (git(repo, ['branch', '--show-current']) !== branch) {
    throw new Error('Not on upstream default branch; preserving checkout.');
  }
  const before = git(repo, ['rev-parse', 'HEAD']);
  // Fetch only the discovered branch. FETCH_HEAD avoids relying on a stale origin/HEAD.
  git(repo, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/heads/${branch}`]);
  const target = git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  const [ahead, behind] = git(repo, ['rev-list', '--left-right', '--count', `${before}...${target}`])
    .split(/\s+/).map(Number);
  if (ahead > 0) {
    throw new Error(behind > 0 ? 'Local branch diverged; preserving checkout.' : 'Local branch ahead; preserving checkout.');
  }
  // Detect concurrent edits before the only operation that can change the working tree.
  requireClean(repo);
  if (git(repo, ['rev-parse', 'HEAD']) !== before || git(repo, ['branch', '--show-current']) !== branch) {
    throw new Error('Checkout changed during update; refusing merge.');
  }
  git(repo, ['merge', '--ff-only', '--no-overwrite-ignore', '--no-edit', '--no-stat', target]);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  if (commit !== target) throw new Error('Checkout does not match fetched upstream; not claiming latest.');
  requireClean(repo);
  return {
    repository: UPSTREAM, branch, commit,
    skillCount: countSkills(path.join(repo, 'skills')), updated: true, cloned,
  };
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: node update-brain.mjs [repository-directory]');
    console.log(JSON.stringify(updateBrain(args[0])));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ updated: false, error: error instanceof Error ? error.message : 'Update failed.' }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
