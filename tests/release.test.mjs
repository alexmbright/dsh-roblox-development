import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
test('tracked release files exclude local artifacts and personal home paths', t => {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0) return t.skip('Source archive without Git metadata; audit tracked files before release.');
  const files = git.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.doesNotMatch(name, /(^|\/)(?:\.env(?:\..*)?|\.cache|node_modules|\.agent-teams)(\/|$)|\.(?:tgz|log|pem|key)$/i);
    const body = readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(body, /[A-Z]:[\\/]Users[\\/][\w.-]+|\/(?:Users|home)\/[\w.-]+/, name);
    assert.doesNotMatch(body, /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, name);
    assert.doesNotMatch(body, /(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/, name);
  }
});
