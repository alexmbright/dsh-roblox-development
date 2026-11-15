import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply as runtimeApply, discoverStandardSeeds, selectManagedPlan } from '../workspace-runtime.js';
import { buildPreamble, stateLayout } from '../workspace-env.js';
const manifest = JSON.parse(fs.readFileSync(new URL('../toolchain/lock.json', import.meta.url), 'utf8'));
test('all advertised platforms include exact pins, fixed assets and SHA-256', () => {
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  for (const tool of Object.values(manifest.platforms).flatMap(platform => platform.tools)) {
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
    assert.match(tool.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\//);
    assert.ok(!tool.url.includes('latest'));
  }
  // Upstream publishes no Selene or Luau asset for these two targets.
  assert.deepEqual(manifest.platforms['linux-arm64'].tools.map(tool => tool.name).sort(), ['luau-lsp', 'lune', 'stylua']);
  assert.deepEqual(manifest.platforms['darwin-x64'].tools.map(tool => tool.name).sort(), ['luau-lsp', 'lune', 'stylua']);
  for (const platform of [manifest.platforms['win32-x64'], manifest.platforms['darwin-arm64'], manifest.platforms['linux-x64']]) {
    assert.deepEqual(platform.tools.map(tool => tool.name), ['lune', 'stylua', 'selene', 'luau', 'luau-lsp']);
    for (const tool of platform.tools) {
      assert.match(tool.sha256, /^[a-f0-9]{64}$/);
      assert.match(tool.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\//);
      assert.ok(!tool.url.includes('latest'));
      if (platform === manifest.platforms['win32-x64']) for (const binary of tool.binaries) assert.match(binary.sha256, /^[a-f0-9]{64}$/);
    }
  }
});
test('shell-native prep needs no installed Node and never rewrites an existing standard', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-native-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'selene.toml'), 'std = "roblox"');
  const source = path.join(root, 'seed.yml');
  fs.writeFileSync(source, 'base: luau');
  const seeds = discoverStandardSeeds({ root, workdir: path.join(root, 'src'), source });
  assert.deepEqual(seeds, [{ source, destination: path.join(root, 'roblox.yml') }]);
  const p = buildPreamble({ dialect: 'pwsh', layout: stateLayout(root), env: {}, writable: true, prepare: {seeds} });
  assert.match(p, /Copy-Item/);
  assert.ok(!p.includes('node') && !p.includes('ELECTRON_RUN_AS_NODE'));
  fs.writeFileSync(path.join(root, 'roblox.yml'), 'user');
  assert.deepEqual(discoverStandardSeeds({ root, workdir: root, source }), []);
  assert.throws(() => discoverStandardSeeds({ root, workdir: path.dirname(root), source }), /outside/);
  assert.throws(() => discoverStandardSeeds({ root, workdir: root, source, config: '../selene.toml' }), /outside/);
});
test('offline setup mounts shell and warns while basic commands stay available', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roblox-failed-toolchain-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh'), {recursive:true});
    fs.writeFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh','package.json'), JSON.stringify({name:'@deepseek-ai/dsh-tool-pwsh',type:'module',main:'index.js'}));
    fs.writeFileSync(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh','index.js'), 'export const apply=()=>{};');
    let delegate, mounted = false;
    const ctx = {shell:{resolve:q=>q,execute:q=>q},profileContext:{installAnchor:path.join(root,'anchor.js')},
      robloxToolchain:{current:{status:'failed',issues:['checksum mismatch']},ready:new Promise(()=>{})},
      tools:{guard(){}},isolate(){return{provide(_key,value){delegate=value;},plugin(){mounted=true;}}}};
    await runtimeApply(ctx, {platform:'win32'});
    assert.ok(mounted, 'pending ready promise must not block mounting');
    const spec={command:'Get-ChildItem',workdir:root,sandboxPolicy:{mode:'workspace-write',workspaceRoot:root}};
    const resolved=delegate.resolve(spec);
    const executed=delegate.execute(resolved);
    assert.match(executed.command,/checksum mismatch/);
    assert.match(executed.command,/function stylua/);
    assert.ok(executed.command.endsWith('Get-ChildItem'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('project pins match repository and canonical version; missing pins warn without breaking basic commands', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'roblox-pins-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const managed={tools:[{name:'luau',version:'0.745.0',executable:path.join(root,'shared','luau.exe')},{name:'stylua',version:'2.6.0',executable:path.join(root,'shared','stylua.exe')}]};
  fs.writeFileSync(path.join(root,'rokit.toml'),'[tools]\nluau = "luau-lang/luau@0.745"\nwally = "UpliftGames/wally@0.3.2"\n');
  const plan=selectManagedPlan({managed,workdir:root,root,originalEnv:{USERPROFILE:path.join(root,'empty')},platform:'win32'});
  assert.equal(plan.tools.length,2);
  assert.deepEqual(plan.blockedTools,['wally']);
  assert.equal(plan.warnings.length,1);
  fs.writeFileSync(path.join(root,'rokit.toml'),'[tools]\nstylua = "someone/else@2.6.0"\n');
  const wrong=selectManagedPlan({managed,workdir:root,root,originalEnv:{},platform:'win32'});
  assert.deepEqual(wrong.blockedTools,['stylua']);
  fs.writeFileSync(path.join(root,'rokit.toml'),'[tools]\nfmt = "JohnnyMorganz/StyLua@2.6.0"\n');
  const alias=selectManagedPlan({managed,workdir:root,root,originalEnv:{},platform:'win32'});
  assert.equal(alias.aliases[0].name,'fmt');
  assert.deepEqual(alias.blockedTools,[]);
});
