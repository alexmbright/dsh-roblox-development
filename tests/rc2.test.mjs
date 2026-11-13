import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const text = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
test('rc2 compatibility and native delegation guidance remain explicit', async () => {
  const manifest = JSON.parse(await text('package.json'));
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.2 <0.3.0');
  const patch = await text('cordis.patch.yml');
  const teams = await text('skills/roblox-tiered-workflow/references/teams.md');
  assert.doesNotMatch(patch + teams, /interrupt_agent/);
  assert.match(patch, /prior assistant claim is not tool-availability evidence/);
  assert.match(patch, /Usually start with one or two workers/);
  assert.doesNotMatch(patch + teams, /at most 2|measure before 3 or 4|Increase toward three or four only/);
  assert.match(patch, /provider: spawn/);
  assert.match(patch, /provider: fork/);
  assert.match(teams, /distinguish the request from confirmed termination/);
});
