import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { extractZip, crc32 } from '../toolchain/archive.mjs';
import { ensureToolchain, inspectToolchain, resolveToolchain } from '../toolchain/provision.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = Buffer.from('local fake executable bytes - never executed\n');
function zip(entries = [{ path: 'lune.exe', data: payload }]) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100755) * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function manifest(bytes, overrides = {}) {
  return { schemaVersion: 1, platforms: { 'win32-x64': { tools: [{ name: 'lune', version: '0.11.1', url: 'https://github.com/lune-org/lune/releases/download/v0.11.1/lune.zip', sha256: hash(bytes), binaries: [{ name: 'lune', path: 'lune.exe', sha256: hash(payload) }], ...overrides }] } } };
}
function fetchBytes(bytes, count = { value: 0 }) {
  return async (_url, options) => {
    count.value++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    return new Response(bytes, { status: 200 });
  };
}
async function fixture(t, bytes = zip()) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roblox-provision-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(sandbox)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith('roblox-provision-test-'));
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  const root = path.join(sandbox, 'profile', 'roblox-toolchain');
  return { sandbox, root, options: { root, manifest: manifest(bytes), platform: 'win32', arch: 'x64', fetchImpl: fetchBytes(bytes) } };
}

// Archive-only tests are all synthetic and require neither network nor extraction tools.
test('ZIP parses stored and deflated entries and validates CRC', () => {
  const entries = extractZip(zip([{ path: 'bin/a', data: 'a', method: 0 }, { path: 'bin/b', data: 'bbb' }]));
  assert.deepEqual(entries.map(entry => [entry.path, entry.data.toString()]), [['bin/a', 'a'], ['bin/b', 'bbb']]);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const damaged = zip([{ path: 'a', data: 'hello', method: 0 }]);
  damaged[31] ^= 1;
  assert.throws(() => extractZip(damaged), /CRC/);
});
test('ZIP rejects traversal, aliases, absolute paths, links, duplicate files and collisions', () => {
  for (const name of ['../evil', '/evil', 'C:/evil', 'a\\evil', 'a/../evil', 'a//evil', 'a./evil', 'NUL.txt', 'a:stream', 'a\u0000b', '\u00e9']) {
    assert.throws(() => extractZip(zip([{ path: name, data: 'x' }])), { code: 'INVALID_ARCHIVE' }, name);
  }
  assert.throws(() => extractZip(zip([{ path: 'link', data: '../outside', mode: 0o120777 }])), /links/);
  assert.throws(() => extractZip(zip([{ path: 'a', data: 'x' }, { path: 'A', data: 'y' }])), /colliding/);
  assert.throws(() => extractZip(zip([{ path: 'a', data: 'x' }, { path: 'a/b', data: 'y' }])), /parent directory/);
  assert.throws(() => extractZip(zip([{ path: 'a', flags: 1, data: 'x' }])), /encrypted/);
});
test('ZIP bounds archive bytes, entry count and declared/actual unpacked sizes', () => {
  const archive = zip([{ path: 'a', data: 'a'.repeat(10000) }, { path: 'b', data: 'x' }]);
  assert.throws(() => extractZip(archive, { maxArchiveBytes: 10 }), /size limit/);
  assert.throws(() => extractZip(archive, { maxUnpackedBytes: 50 }), /unpacked size/);
  assert.throws(() => extractZip(archive, { maxEntries: 1 }), /count/);
  assert.throws(() => extractZip(archive.subarray(0, -1)), /central directory/);
  const forged = zip([{ path: 'a', data: 'a'.repeat(10000) }]);
  const central = forged.readUInt32LE(forged.length - 6);
  forged.writeUInt32LE(2, 22);
  forged.writeUInt32LE(2, central + 24);
  assert.throws(() => extractZip(forged), /oversized deflate/);
});
test('ZIP rejects inconsistent local records, ZIP64 and overlapping records', () => {
  const archive = zip();
  const central = archive.readUInt32LE(archive.length - 6);
  archive.writeUInt16LE(0, 8);
  assert.throws(() => extractZip(archive), /inconsistent local/);
  const zip64 = zip();
  zip64.writeUInt32LE(0xffffffff, central + 20);
  assert.throws(() => extractZip(zip64), /ZIP64/);
});

test('ensure provisions fake bytes atomically, reports ready and reuses verified files without fetch', async t => {
  const { root, options } = await fixture(t);
  assert.equal((await inspectToolchain(options)).status, 'missing');
  const count = { value: 0 };
  const progress = [];
  const envPath = process.env.PATH;
  const result = await ensureToolchain({ ...options, fetchImpl: fetchBytes(zip(), count), onProgress: event => progress.push(event.status) });
  assert.equal(result.status, 'ready');
  assert.equal(result.installRoot, root);
  assert.equal(result.tools[0].name, 'lune');
  assert.equal(result.tools[0].version, '0.11.1');
  assert.ok(result.tools[0].executable.startsWith(root + path.sep));
  assert.deepEqual(await fs.readFile(result.tools[0].executable), payload);
  assert.deepEqual(progress, ['downloading', 'installed']);
  const again = await ensureToolchain({ ...options, fetchImpl: async () => assert.fail('reuse downloaded') });
  assert.deepEqual(again, result);
  assert.deepEqual(await resolveToolchain(options), result);
  assert.equal(count.value, 1);
  assert.equal(process.env.PATH, envPath);
  assert.deepEqual(await fs.readdir(root), ['lune']);
});
test('complete receipt validates optional per-binary SHA and detects tampered existing binaries', async t => {
  const { options } = await fixture(t);
  const ready = await ensureToolchain(options);
  await fs.writeFile(ready.tools[0].executable, 'tampered');
  assert.equal((await inspectToolchain(options)).status, 'corrupt');
  await assert.rejects(ensureToolchain({ ...options, fetchImpl: async () => assert.fail('corrupt cache fetched') }), { code: 'CORRUPT_INSTALL' });
  assert.equal(await fs.readFile(ready.tools[0].executable, 'utf8'), 'tampered');
});
test('binary optional hashes are receipt-verified when the manifest does not include them', async t => {
  const archive = zip();
  const { options } = await fixture(t, archive);
  options.manifest.platforms['win32-x64'].tools[0].binaries[0] = { name: 'lune', path: 'lune.exe' };
  const result = await ensureToolchain(options);
  assert.equal((await inspectToolchain(options)).status, 'ready');
  const receiptPath = path.join(path.dirname(path.dirname(result.tools[0].executable)), '.complete.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  assert.equal(receipt.binaries[0].sha256, hash(payload));
});
test('checksum failure happens before extraction and leaves no partial install', async t => {
  const { root, options } = await fixture(t);
  let extracted = false;
  await assert.rejects(ensureToolchain({ ...options, fetchImpl: fetchBytes(Buffer.from('bad download')), extractImpl: () => { extracted = true; return []; } }), { code: 'HASH_MISMATCH' });
  assert.equal(extracted, false);
  assert.deepEqual(await fs.readdir(root), []);
});
test('missing or invalid binary fails and cleans only owned staging data', async t => {
  const { root, sandbox, options } = await fixture(t, zip([{ path: 'README.txt', data: 'not a tool' }]));
  const unrelated = path.join(sandbox, 'keep.txt');
  await fs.writeFile(unrelated, 'preserved');
  await assert.rejects(ensureToolchain(options), { code: 'MISSING_BINARY' });
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'preserved');
  options.manifest = manifest(zip(), { binaries: [{ name: 'lune', path: 'lune.exe', sha256: '0'.repeat(64) }] });
  options.fetchImpl = fetchBytes(zip());
  await assert.rejects(ensureToolchain(options), { code: 'HASH_MISMATCH' });
  assert.deepEqual(await fs.readdir(root), []);
});
test('injected extract seam is bounded and cannot return filesystem paths or execute anything', async t => {
  const { options } = await fixture(t);
  await assert.rejects(ensureToolchain({ ...options, extractImpl: () => [{ path: '../evil', data: payload }] }), { code: 'INVALID_ARCHIVE' });
});
test('unsupported platform/arch fails explicitly and malformed pins never reach fetch', async t => {
  const { options } = await fixture(t);
  await assert.rejects(ensureToolchain({ ...options, arch: 'arm64' }), { code: 'UNSUPPORTED_PLATFORM' });
  await assert.rejects(inspectToolchain({ ...options, platform: 'freebsd' }), { code: 'UNSUPPORTED_PLATFORM' });
  for (const override of [{ sha256: '' }, { version: '../escape' }, { name: 'CON' }, { binaries: [{ name: 'lune', path: 'C:/escape' }] }]) {
    await assert.rejects(ensureToolchain({ ...options, manifest: manifest(zip(), override), fetchImpl: async () => assert.fail('invalid pin fetched') }));
  }
});
test('trusts only fixed GitHub HTTPS downloads; rejects redirects before contacting foreign host', async t => {
  const { options } = await fixture(t);
  for (const url of ['http://github.com/a/b/releases/download/v1/a.zip', 'https://evil.example/a.zip', 'https://user:secret@github.com/a/b/releases/download/v1/a.zip', 'https://github.com/a/b/releases/latest/download/a.zip', 'https://github.com/a/b/releases/download/v1/a.zip?token=secret']) {
    await assert.rejects(ensureToolchain({ ...options, manifest: manifest(zip(), { url }), fetchImpl: async () => assert.fail('untrusted fetched') }), { code: 'UNTRUSTED_URL' });
  }
  let requests = 0;
  await assert.rejects(ensureToolchain({ ...options, fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/evil' } }); } }), { code: 'UNTRUSTED_URL' });
  assert.equal(requests, 1);
});
test('follows explicit bounded release-assets redirect and caps announced bytes', async t => {
  const { options } = await fixture(t);
  const urls = [];
  await ensureToolchain({ ...options, fetchImpl: async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/a?signature=fake' } }) : new Response(zip());
  } });
  assert.equal(urls.length, 2);
  const other = await fixture(t);
  await assert.rejects(ensureToolchain({ ...other.options, fetchImpl: async () => new Response('tiny', { headers: { 'content-length': String(129 * 1024 * 1024) } }) }), { code: 'DOWNLOAD_TOO_LARGE' });
});
test('same-process initialization is singleflight; independent callers race atomic publication', async t => {
  const { options } = await fixture(t);
  let requests = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const fetchImpl = async () => { requests++; entered(); await gate; return new Response(zip()); };
  const one = ensureToolchain({ ...options, fetchImpl });
  const two = ensureToolchain({ ...options, fetchImpl });
  assert.equal(one, two);
  await reached;
  const independent = ensureToolchain({ ...options, fetchImpl, signal: new AbortController().signal });
  // Wait until the independent caller also owns authenticated bytes; both then
  // construct unique stages and may race at the final atomic rename.
  let enteredSecond;
  const secondReached = new Promise(resolve => { enteredSecond = resolve; });
  entered = enteredSecond;
  await secondReached;
  release();
  assert.deepEqual(await one, await independent);
  assert.equal(requests, 2);
  assert.deepEqual(await fs.readdir(options.root), ['lune']);
});
test('independent cancellation does not cancel the active installer', async t => {
  const { options } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const active = ensureToolchain({ ...options, fetchImpl: async () => { entered(); await gate; return new Response(zip()); } });
  await reached;
  const controller = new AbortController();
  const waiting = ensureToolchain({ ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  release();
  assert.equal((await active).status, 'ready');
});
test('legacy live/stale locks and crashed stages never block installation and are never swept', async t => {
  const { root, options } = await fixture(t);
  const tool = options.manifest.platforms['win32-x64'].tools[0];
  const identity = hash(JSON.stringify({ target: 'win32-x64', ...tool }));
  const lock = path.join(root, `.lock-${identity}`);
  const abandoned = path.join(root, `.stage-${identity}-crashed-installer`);
  await fs.mkdir(lock, { recursive: true });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'foreign' }));
  await fs.mkdir(abandoned);
  await fs.writeFile(path.join(abandoned, 'partial'), 'do not touch');
  const ready = await ensureToolchain(options);
  assert.equal(ready.status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')).token, 'foreign');
  await fs.utimes(lock, new Date(0), new Date(0));
  assert.equal((await ensureToolchain({ ...options, fetchImpl: async () => assert.fail('reuse fetched') })).status, 'ready');
  assert.equal(await fs.readFile(path.join(abandoned, 'partial'), 'utf8'), 'do not touch');
  assert.deepEqual((await fs.readdir(root)).sort(), [path.basename(lock), path.basename(abandoned), 'lune'].sort());
});
test('symlink/junction cache ancestors are refused, without touching their targets', async t => {
  const { sandbox, options } = await fixture(t);
  const real = path.join(sandbox, 'real');
  const linked = path.join(sandbox, 'linked');
  await fs.mkdir(real);
  try { await fs.symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`symlink creation unavailable: ${error.code}`); return; } throw error; }
  assert.notEqual(await fs.realpath(linked), linked, 'fixture must resolve the junction to its target');
  try {
    await assert.rejects(ensureToolchain({ ...options, root: path.join(linked, 'tools') }), { code: 'UNSAFE_CACHE_PATH' });
    assert.deepEqual(await fs.readdir(real), []);
  } finally {
    assert.equal(path.dirname(path.resolve(linked)), path.resolve(sandbox));
    // POSIX rmdir refuses a symlink with ENOTDIR; a Windows junction must be unlinked with rmdir.
    if (process.platform === 'win32') await fs.rmdir(linked);
    else await fs.unlink(linked);
  }
});
test('malformed receipts are corrupt rather than throwing a JSON shape exception', async t => {
  const { options } = await fixture(t);
  const result = await ensureToolchain(options);
  const receiptPath = path.join(path.dirname(path.dirname(result.tools[0].executable)), '.complete.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  for (const value of [null, { ...receipt, binaries: [null] }, { ...receipt, identity: 'wrong' }]) {
    await fs.writeFile(receiptPath, JSON.stringify(value));
    assert.equal((await inspectToolchain(options)).status, 'corrupt');
  }
});
test('aborted-before-start and injected download failure leave no lock or executable', async t => {
  const { root, options } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(ensureToolchain({ ...options, signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(ensureToolchain({ ...options, fetchImpl: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await fs.readdir(root), []);
});

test('every pinned platform declares https URLs and 64-hex digests', async () => {
  const { readFileSync } = await import('node:fs');
  const lock = JSON.parse(readFileSync(new URL('../toolchain/lock.json', import.meta.url), 'utf8'));
  for (const [platform, spec] of Object.entries(lock.platforms)) {
    assert.ok(Array.isArray(spec.tools) && spec.tools.length > 0, platform + ' has tools');
    for (const tool of spec.tools) {
      assert.match(tool.url, /^https:\/\/github\.com\//, `${platform}/${tool.name} url`);
      assert.match(tool.sha256, /^[a-f0-9]{64}$/, `${platform}/${tool.name} digest`);
      for (const binary of tool.binaries) assert.ok(binary.path.length > 0, `${platform}/${tool.name} binary path`);
    }
  }
  for (const platform of ['win32-x64', 'darwin-arm64', 'linux-x64']) {
    assert.equal(lock.platforms[platform].tools.length, 5, platform + ' has the full set');
  }
});
