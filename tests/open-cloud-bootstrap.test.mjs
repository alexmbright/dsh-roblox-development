import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, studioArgs } from '../open-cloud-mcp.js';

const bootstrap = fileURLToPath(new URL('../open-cloud-bootstrap.mjs', import.meta.url));
const key = `synthetic-${randomBytes(18).toString('hex')}`;
const credentials = {
  ROBLOX_OPEN_CLOUD_API_KEY: key,
  ROBLOX_CREATOR_USER_ID: '712345678',
  ROBLOX_CREATOR_GROUP_ID: '876543217',
};

function temporaryHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roblox-open-cloud-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function testEnv(home, extra = {}) {
  return {
    PATH: process.env.PATH,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home } : { HOME: home }),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...credentials,
    ...extra,
  };
}

test('bootstrap fails closed without executing unexpected entry bytes or printing credential data', t => {
  const home = temporaryHome(t);
  const dist = join(home, 'dist');
  mkdirSync(dist);
  const entry = join(dist, 'index.js');
  writeFileSync(entry, 'console.log("unexpected entry ran", process.env.ROBLOX_OPEN_CLOUD_API_KEY);');
  const result = spawnSync(process.execPath, [bootstrap, entry, '--auto-install-plugin'], {
    env: testEnv(home), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\[roblox-open-cloud\] Refusing to start the Studio MCP/);
  for (const value of Object.values(credentials)) assert.ok(!result.stderr.includes(value));
});

test('explicit fixture args run unchanged with no credential templates or ambient credential values', async t => {
  const home = temporaryHome(t);
  const fixture = join(home, 'fixture.mjs');
  writeFileSync(fixture, 'console.log(JSON.stringify([process.argv.slice(2), ...Object.keys(process.env).filter(k => /ROBLOX_(OPEN_CLOUD_API_KEY|CREATOR_(GROUP|USER)_ID)/.test(k)).map(k => process.env[k])]));');
  const args = [fixture, '--fixture-option', 'fixture-value'];
  let result;
  let passedArgs;
  const registered = [];
  const realm = { plugin: (_, config) => ({ await: async () => {
    if (config?.transport !== 'stdio') return;
    passedArgs = config.args;
    result = spawnSync(config.command, config.args, {
      env: { ...testEnv(home), ...config.env }, encoding: 'utf8', timeout: 5000,
    });
  } }) };
  realm.isolate = () => realm;
  const ctx = {
    get: name => name === 'loader' ? { import: async () => null, unwrapExports: () => null } : undefined,
    isolate: () => realm,
    tools: { register: definition => { registered.push(definition.name); return () => {}; } },
    on() {},
  };
  await apply(ctx, { args });
  assert.deepEqual(passedArgs, args);
  assert.deepEqual(registered, ['roblox_studio_tools'], 'the on-demand Studio tool search is registered');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [['--fixture-option', 'fixture-value'], '', '', '']);
});

const dependencyDir = process.env.ROBLOX_OPEN_CLOUD_TEST_DEPENDENCY_DIR;
const packageName = '@chrrxs/robloxstudio-mcp';
let dependencyAvailable;
try {
  const require = createRequire(dependencyDir ? join(resolve(dependencyDir), 'package.json') : import.meta.url);
  require.resolve(packageName);
  dependencyAvailable = true;
} catch (error) {
  if (dependencyDir || error?.code !== 'MODULE_NOT_FOUND') throw error;
  dependencyAvailable = false;
}

const integration = { skip: !dependencyAvailable && `Dependency ${packageName} is not installed`, timeout: 10_000 };

test('pinned MCP uses synthetic credentials only on Open Cloud requests, not in subprocesses or errors', integration, async t => {
  const home = temporaryHome(t);
  const plugins = join(home, 'plugins');
  const preload = join(home, 'network-stub.mjs');
  const asset = join(home, 'fixture.rbxm');
  mkdirSync(plugins);
  writeFileSync(asset, 'synthetic test asset; never sent over the network');
  // Mock only the external network. This probe spawns an actual subprocess inside the
  // credential-bearing request and checks the environment it inherited without logging values.
  writeFileSync(preload, `
    import { spawnSync } from 'node:child_process';
    const expected = ${JSON.stringify(credentials)};
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith('https://apis.roblox.com/')) throw new Error('Unexpected network URL');
      const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { encoding: 'utf8' });
      const inherited = JSON.parse(result.stdout);
      if (Object.keys(expected).some(name => inherited.includes(name))) throw new Error('Child inherited credentials');
      if (new Headers(options.headers).get('x-api-key') !== expected.ROBLOX_OPEN_CLOUD_API_KEY || options.redirect !== 'error') {
        throw new Error('Wrong credential or redirect policy');
      }
      if (options.method === 'POST') {
        const creator = JSON.parse(options.body.get('request')).creationContext.creator;
        if (creator.groupId !== expected.ROBLOX_CREATOR_GROUP_ID || creator.userId !== undefined) throw new Error('Wrong creator');
        return Response.json({ path: expected.ROBLOX_OPEN_CLOUD_API_KEY, done: true, error: { message: expected.ROBLOX_OPEN_CLOUD_API_KEY } });
      }
      switch (new URL(url).pathname.split('/').pop()) {
        case '54': throw new Error(expected.ROBLOX_OPEN_CLOUD_API_KEY, { cause: expected });
        default: return Response.json({ detail: expected.ROBLOX_OPEN_CLOUD_API_KEY, errorCode: expected.ROBLOX_CREATOR_USER_ID, hint: expected.ROBLOX_CREATOR_GROUP_ID }, { status: 403 });
      }
    };
  `);
  const args = studioArgs(dependencyDir && resolve(dependencyDir));
  assert.deepEqual([args[0], args[2]], [bootstrap, '--auto-install-plugin']);
  const portProbe = createServer().listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const server = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...args], {
    cwd: home,
    env: testEnv(home, {
      MCP_PLUGINS_DIR: plugins, ROBLOX_STUDIO_PORT: String(port), ROBLOX_STUDIO_REQUIRE_PRIMARY: '1',
      ROBLOX_STUDIO_AUTH_TOKEN: 'synthetic-studio-token',
    }),
  });
  const exited = once(server, 'close');
  t.after(async () => {
    if (server.exitCode === null) server.kill('SIGKILL');
    await exited;
  });
  let stdout = '';
  let stderr = '';
  server.stdout.on('data', chunk => { stdout += chunk.toString(); });
  server.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  const send = message => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  async function request(id, method, params) {
    send({ id, method, params });
    for (;;) {
      const line = await lines.next();
      assert.equal(line.done, false, stderr);
      const answer = JSON.parse(line.value);
      if (answer.id === id) return answer;
    }
  }
  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bootstrap test', version: '1' },
  });
  assert.deepEqual(initialized.result.serverInfo, { name: 'robloxstudio-mcp', version: '3.5.0' });
  assert.match(stderr, /\[install-plugin\] Installed MCPPlugin\.rbxmx/);
  assert.ok(existsSync(join(plugins, 'MCPPlugin.rbxmx')));
  send({ method: 'notifications/initialized' });
  const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });
  const forbidden = await call(2, 'manage_experience', { action: 'get', universe_id: 53 });
  assert.match(JSON.stringify(forbidden), /API key lacks required permissions/);
  const transport = await call(3, 'manage_experience', { action: 'get', universe_id: 54 });
  assert.match(JSON.stringify(transport), /Open Cloud request failed/);
  const operation = await call(4, 'upload_asset', { filePath: asset, assetType: 'Model', displayName: 'synthetic' });
  assert.match(JSON.stringify(operation), /Open Cloud reported an asset upload error/);
  server.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
  for (const value of Object.values(credentials)) {
    assert.ok(!stdout.includes(value) && !stderr.includes(value), 'synthetic credential appeared in process output');
  }
});
