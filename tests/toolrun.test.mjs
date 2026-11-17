import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runTool } from '../toolrun.js';

/** A ctx carrying a ready toolchain and a captured subprocess seam. */
function harness(options = {}) {
  const spawned = [];
  const toolchain = {
    current: options.current ?? {
      status: 'ready',
      installRoot: '/profile/roblox-toolchain',
      issues: [],
      tools: [
        { name: 'lune', version: '0.11.1', executable: '/profile/roblox-toolchain/lune' },
        { name: 'selene', version: '0.32.0', executable: '/profile/roblox-toolchain/selene' },
        { name: 'stylua', version: '2.6.0', executable: '/profile/roblox-toolchain/stylua' },
      ],
    },
    ready: Promise.resolve(),
  };
  const subprocess = {
    resolveExecutable: async command => command,
    spawn: spec => {
      spawned.push(spec);
      return {
        done: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: options.stdout ?? 'ok', nextOffset: 2, lossy: false }) },
          stderr: { readFrom: () => ({ text: options.stderr ?? '', nextOffset: 0, lossy: false }) },
        },
      };
    },
  };
  const ctx = { get: key => (key === 'robloxToolchain' ? toolchain : key === 'subprocess' ? subprocess : undefined) };
  const exec = { agent: { session: { header: { cwd: '/workspace' } } } };
  return { ctx, exec, spawned };
}

test('a pinned tool runs with its exact executable and the session cwd', async () => {
  const { ctx, exec, spawned } = harness();
  const result = await runTool(ctx, { tool: 'lune', args: ['run', 'check.luau'] }, exec);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].argv, ['/profile/roblox-toolchain/lune', 'run', 'check.luau']);
  assert.equal(spawned[0].cwd, path.resolve('/workspace'));
  assert.equal(result.tool, 'lune');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, '');
  assert.equal(result.stdout, 'ok');
  assert.equal(result.truncated, false);
});

test('an explicit cwd inside the workspace is honoured', async () => {
  const { ctx, exec, spawned } = harness();
  await runTool(ctx, { tool: 'selene', args: ['check', 'src'], cwd: '/workspace/src' }, exec);
  assert.equal(spawned[0].cwd, path.resolve('/workspace/src'));
});

test('a cwd outside the session workspace is refused', async () => {
  const { ctx, exec } = harness();
  await assert.rejects(runTool(ctx, { tool: 'selene', args: ['check', '.'], cwd: '/elsewhere' }, exec), /outside the session workspace/);
  await assert.rejects(runTool(ctx, { tool: 'lune', args: ['run', 'x'], cwd: '/workspace/../../etc' }, exec), /outside the session workspace/);
});

test('a non-zero exit is reported, not thrown', async () => {
  const { ctx, exec } = harness({ exitCode: 1, stderr: 'lint failed' });
  const result = await runTool(ctx, { tool: 'selene', args: ['check', '.'] }, exec);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, 'lint failed');
});

test('an unknown tool name is refused', async () => {
  const { ctx, exec } = harness();
  await assert.rejects(runTool(ctx, { tool: 'rm', args: ['-rf', '/'] }, exec), /unknown tool/);
});

test('an argument carrying a NUL byte is refused', async () => {
  const { ctx, exec } = harness();
  await assert.rejects(runTool(ctx, { tool: 'lune', args: ['a\0b'] }, exec), /NUL/);
});

test('a missing pinned binary explains the toolchain state', async () => {
  const { ctx, exec } = harness({ current: { status: 'failed', installRoot: '/p', issues: ['download failed'], tools: [] } });
  await assert.rejects(runTool(ctx, { tool: 'lune', args: [] }, exec), /not installed.*download failed/);
});

test('a run without any working directory is refused', async () => {
  const { ctx } = harness();
  await assert.rejects(runTool(ctx, { tool: 'lune', args: [] }, {}), /working directory/);
});

test('an argument that escapes the workspace is refused', async () => {
  const { ctx, exec } = harness();
  await assert.rejects(runTool(ctx, { tool: 'stylua', args: ['--write', '/etc/passwd'] }, exec), /outside the session workspace/);
  await assert.rejects(runTool(ctx, { tool: 'selene', args: ['--config=../../etc/x.toml', '.'] }, exec), /outside the session workspace/);
  await assert.rejects(runTool(ctx, { tool: 'lune', args: ['run', '~/evil.luau'] }, exec), /outside the session workspace/);
});

test('workspace-relative arguments and flags are accepted', async () => {
  const { ctx, exec, spawned } = harness();
  await runTool(ctx, { tool: 'selene', args: ['--config=/workspace/selene.toml', 'src'] }, exec);
  await runTool(ctx, { tool: 'stylua', args: ['--check', '.'], cwd: '/workspace/src' }, exec);
  await runTool(ctx, { tool: 'lune', args: ['run', 'scripts/check.luau'] }, exec);
  assert.equal(spawned.length, 3);
});
