import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const text = p => readFile(path.join(root, p), 'utf8');
const manifest = JSON.parse(await text('package.json'));
const routes = JSON.parse(await text('routes.json'));
const patch = await text('cordis.patch.yml');
const skill = await text('skills/roblox-tiered-workflow/SKILL.md');
const refs = await Promise.all(['routing', 'teams', 'studio'].map(n => text(`skills/roblox-tiered-workflow/references/${n}.md`)));
const selection = await text('skills/roblox-tiered-workflow/references/skill-selection.md');
const docs = [skill, ...refs, selection].join('\n');

test('package declares preset compatibility plus shared toolchain bootstrap', () => {
  assert.equal(manifest.name, '@alexturbo/dsh-roblox-development');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.exports['.'], './index.js');
  assert.ok(manifest.files.includes('index.js'));
  assert.match(patch, /plugins:\n {10}- id: roblox-mcp-result-compat\n {12}name: '@alexturbo\/dsh-roblox-development'/);
  assert.ok(patch.includes("resolve('@alexturbo/dsh-roblox-development/routes.json')"));
  assert.ok(!patch.includes('@local/dsh-roblox-tiered'));
  assert.deepEqual(manifest.dependencies, { '@chrrxs/robloxstudio-mcp': '3.5.0' });
  assert.deepEqual(Object.keys(manifest.scripts), ['setup', 'test']);
  assert.match(patch, /^- insert:\s*\n {4}- id: roblox-routing-controls\n {6}name: '@alexturbo\/dsh-roblox-development\/routing-controls'\n {4}- id: roblox-toolchain/m);
  assert.match(patch, /name: '@alexturbo\/dsh-roblox-development\/toolchain'/);
  assert.doesNotMatch(patch, /roblox-worker-guard|roblox_worker_policy|roblox_studio_control/);
  assert.match(patch, /^ {4}- id: preset-roblox/m);
  assert.match(patch, /^ {8}id: roblox$/m);
  assert.match(patch, /^ {8}name: Roblox development$/m);
  assert.equal((patch.match(/name: '@deepseek-ai\/dsh-agent-preset'/g) || []).length, 1);
  assert.doesNotMatch(patch, /dsh-(?:workflow|tool-workflow|agent-teams|llm)-/);
  assert.match(patch, /^- id: subagent-model-selection-settings\n  config:\n    enabled: true/m);
  assert.equal((patch.match(/name: '@deepseek-ai\/dsh-mcp-client'/g)||[]).length, 2);
  assert.match(patch, /roblox_run_tool/);
  assert.match(patch, /serverName: Roblox_Studio/);
  assert.match(patch, /serverName: robloxstudio/);
  assert.match(patch, /resolve\('@chrrxs\/robloxstudio-mcp'\)[^]*?'--auto-install-plugin'/);
  assert.doesNotMatch(patch, /@latest|command: npx/);
  assert.doesNotMatch(patch, /\t|[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\//i);
  assert.match(patch, /command: !!js process.execPath/);
  assert.match(patch, /StudioMCP/);
});

test('standard tool subset retains explicit native spawn model selection', () => {
  for (const name of ['persona', 'agent-instructions', 'time-context', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'command-goal', 'tool-goal', 'skill-filesystem', 'tool-skill', 'tool-subagent-control', 'tool-subagent', 'tool-ask-user', 'tool-todo', 'compaction-basic', 'command-compact', 'compaction-tool-result-pruner']) {
    assert.ok(patch.includes(`'@deepseek-ai/dsh-${name}'`), name);
  }
  assert.match(patch, /provider: spawn\n\s+toolName: subagent\n\s+modelSelection: true\n\s+modelDiscovery: true/);
  assert.match(patch, /isolate:\n\s+compaction: true\n\s+toolResultPruner: true/);
  assert.doesNotMatch(patch, /provider: fork/);
  assert.match(patch, /dsh-roblox-development\/workspace-runtime/);
  assert.match(patch, /dsh-roblox-development\/routing/);
  assert.match(patch, /name: '@deepseek-ai\/dsh-plan-mode'\n\s+config:\n\s+section: \|\n\s+You are in plan mode\./);
  for (const name of ['command-goal','tool-goal','plan-mode','tool-web','tool-present']) assert.ok(patch.includes(`'@deepseek-ai/dsh-${name}'`), name);
  assert.doesNotMatch(patch, /tool-plugin-manager|tool-schedule/);
});

test('role-aware matrix specifies exact approved routes and explicit efforts', () => {
  assert.equal(routes.runtimeRouter, false);
  assert.equal(routes.automaticModelSwitch, false);
  assert.equal(routes.requireDiscovery, true);
  assert.equal(routes.requireExplicitEffort, true);
  const expected = {
    planner: [['xiaomi/mimo-v2.6-pro/high'], ['claude/claude-sonnet-5-5/high'], ['claude/claude-opus-5-5/high']],
    scout: [['deepseek-account/deepseek-flash/low'], ['xiaomi/mimo-v2.6-flash/high'], ['claude/claude-sonnet-5-5/high']],
    implementer: [['xiaomi/mimo-v2.6-pro/high'], ['claude/claude-sonnet-5-5/high'], ['claude/claude-opus-5-5/high']],
    reviewer: [['deepseek-account/deepseek-flash/high'], ['codex/gpt-6.1-sol/high'], ['codex/gpt-6-astra/high']],
    qa: [['xiaomi/mimo-v2.6-flash/high'], ['xiaomi/mimo-v2.6-pro/high'], ['claude/claude-sonnet-5-5/high']],
    studio: [['xiaomi/mimo-v2.6-flash/high'], ['xiaomi/mimo-v2.6-pro/high'], ['claude/claude-sonnet-5-5/high', 'claude/claude-opus-5-5/high']],
    visual: [['deepseek-account/deepseek-flash/high'], ['codex/gpt-6.1-terra/medium'], ['claude/claude-sonnet-5-5/high', 'claude/claude-opus-5-5/high']]
  };
  assert.deepEqual(Object.keys(routes.roles), Object.keys(expected));
  for (const [role, tiers] of Object.entries(routes.roles)) {
    assert.deepEqual(Object.keys(tiers), ['fast', 'standard', 'expert']);
    assert.deepEqual(Object.values(tiers).map(rs => rs.map(r => `${r.provider}/${r.model}/${r.reasoning_effort}`)), expected[role]);
  }
  assert.equal(routes.roles.implementer.fast[0].provisional, true);
  assert.equal(routes.roles.visual.standard[0].provisional, true);
  assert.match(routes.roles.reviewer.fast[0].restriction, /Preliminary only/);
  assert.deepEqual(routes.independentReview, {differentWorker: true, crossProvider: true, preliminaryIsApproval: false});
  assert.match(patch, /Captain uses the current session model/);
  assert.ok(routes.escalation.capacityFallback.includes('capacity evidence'));
});

test('upstream libraries and installed skill roots are portable', () => {
  assert.equal(routes.brain.commit, 'ceee4aaa5004502e2a51d78b3c33bba44d84742b');
  assert.equal(routes.brain.updatePolicy, 'pinned-bundle-release');
  assert.equal(routes.brain.updater, undefined);
  assert.equal(routes.brain.vendored, true);
  assert.deepEqual(routes.brain.libraries, ['core', 'gameplay', 'design', 'tools']);
  for (const library of routes.brain.libraries) assert.ok(patch.includes(library));
  assert.match(patch, /createRequire/);
  assert.match(patch, /path.join\(bundle, 'vendor', 'roblox-brain'\)/);
  assert.doesNotMatch(patch, /\{\{(?:BRAIN_DIR|PLUGIN_DIR)\}\}/);
  assert.match(docs, /update-brain\.mjs/);
});

test('task-specific teams and Studio guardrails remain discoverable and visible', () => {
  assert.equal(routes.execution, 'native-subagents');
  assert.equal(routes.initialReadyWorkers, 2);
  assert.deepEqual(routes.scaleAfterMeasurement, [3, 4]);
  assert.equal(routes.studioOperator, 'message-coordinated-single-operator');
  assert.equal(routes.permissions, 'normal-dsh-access-controls-no-custom-guard');
  assert.equal(routes.ownerPolicies, undefined);
  for (const phrase of ['studio_id', 'instance_id', 'Script Sync', 'Rojo', 'publish', 'save', 'upload']) assert.ok(patch.includes(phrase), phrase);
  assert.doesNotMatch(docs, /roblox_worker_policy|roblox_studio_control/);
  assert.match(docs, /normal DSH/i);
  assert.match(docs, /native (subagents|workers)/i);
  assert.match(docs, /Script Sync/);
  assert.match(docs, /capacity evidence/);
  assert.match(patch, /Use native subagent workers automatically/);
  assert.doesNotMatch(patch, /name:.*agent-teams/);
  assert.match(patch, /COORDINATOR.*not the default implementer/);
  assert.match(patch, /Tightly coupled changes belong together in ONE implementer assignment/);
  assert.match(docs, /coordinator/i);
  assert.doesNotMatch(patch, /Stay solo for small or tightly sequential work/);
});

test('all skill Markdown pointers resolve to files', async () => {
  for (const [relative, content] of [['skills/roblox-tiered-workflow/SKILL.md', skill], ...['routing', 'teams', 'studio'].map((n, i) => [`skills/roblox-tiered-workflow/references/${n}.md`, refs[i]])]) {
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = path.resolve(root, path.dirname(relative), match[1]);
      assert.ok(target.startsWith(root));
      assert.ok((await stat(target)).isFile(), target);
    }
  }
  assert.match(skill, /^---\nname: roblox-tiered-workflow\ndescription: .+\n---/);
  assert.ok(skill.length < 3000);
});

test('goal tracking and domain skill gates cover the full lifecycle', async () => {
  const lifecycle = await text('skills/roblox-tiered-workflow/references/lifecycle.md');
  const selection = await text('skills/roblox-tiered-workflow/references/skill-selection.md');
  assert.match(skill, /create_goal/);
  assert.match(skill, /lifecycle.md/);
  assert.match(patch, /Each delegated task must name its required skills/);
  for (const stage of ['Ground','Design and staff','Build','checks','Self-correct','review','Release']) assert.ok(lifecycle.includes(stage), stage);
  for (const name of ['roblox-networking','roblox-security','roblox-gui','roblox-luau-patterns','roblox-tooling','roblox-performance']) assert.ok(selection.includes(name), name);
});

test('localized metadata and original icon have public exports', async () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(await text(`locale/${locale}.json`)).meta;
    assert.ok(meta.title && meta.description);
  }
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  const icon = await text('icon.svg');
  assert.match(icon, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.match(icon, /<title[^>]*>.+<\/title>/);
  assert.doesNotMatch(icon, /<script|<image|href=|foreignObject/);
  assert.ok(Buffer.byteLength(icon) < 256 * 1024);
});

test('distribution list covers every authored resource and only intended runtime code', async () => {
  async function walk(dir = '') {
    const out = [];
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(relative)); else out.push(relative);
    }
    return out;
  }
  const patterns = manifest.files.map(p => new RegExp('^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$'));
  for (const file of await walk()) {
    assert.ok(file === 'package.json' || file.startsWith('vendor/') || file.startsWith('toolchain/') || patterns.some(p => p.test(file)), `unlisted: ${file}`);
    assert.ok(!/\.(?:js|mjs|cjs)$/.test(file) || file.startsWith('tests/') || file.startsWith('toolchain/') || ['index.js', 'routing.js', 'skill-policy.js', 'visual-policy.js', 'screenshots.js', 'screenshot-bridge.js', 'studio-ids.js', 'http-bridge.js', 'tools/check-visual-gate.mjs', 'coordination.js', 'routing-controls.js', 'toolrun.js', 'client.js', 'workspace-runtime.js', 'workspace-env.js', 'scripts/prepare-workspace.mjs', 'scripts/update-brain.mjs', 'scripts/setup.mjs'].includes(file), file);
  }
  assert.match(await text('THIRD-PARTY-NOTICES.md'), /Copyright \(c\) 2026 TabooHarmony/);
});
