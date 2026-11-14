import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extractZip, DEFAULT_ARCHIVE_LIMITS, validateArchivePath } from './archive.mjs';

const flights = new Map();
const MARKER = '.complete.json';
const MAX_MARKER_BYTES = 128 * 1024;
const SUPPORTED = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
// Platform layout symlinks, not attacker-controlled ones. macOS ships /var and /tmp as
// links into /private, and some Linux images link /tmp, so a profile-owned root under
// either would otherwise be refused before the walk reached a single owned segment.
// These prefixes are followed and rebased onto their canonical target; every segment at
// or below the profile-owned root stays strictly symlink-free, so a link inside the
// cache path is still rejected. Windows has no equivalent layout link, so it stays strict.
const SYSTEM_SYMLINKS = new Set(process.platform === 'darwin' ? ['/var', '/tmp'] : process.platform === 'linux' ? ['/tmp'] : []);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const segmentPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function abort(signal) { signal?.throwIfAborted(); }
function safeSegment(value, label) {
  if (typeof value !== 'string' || !segmentPattern.test(value) || value.endsWith('.') || value === '.' || value === '..') fail('INVALID_MANIFEST', `Invalid ${label}`);
  validateArchivePath(value);
  return value;
}
function validateURL(value, initial = true) {
  let url;
  try { url = new URL(value); } catch { fail('UNTRUSTED_URL', 'Invalid download URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) fail('UNTRUSTED_URL', 'Download URL must use HTTPS without credentials, ports or fragments');
  if (initial) {
    if (url.hostname !== 'github.com' || url.search || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname) || /%2f|%5c|%00/i.test(url.pathname)) fail('UNTRUSTED_URL', 'Only fixed GitHub release asset URLs are trusted');
  } else if (!['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname)) {
    fail('UNTRUSTED_URL', 'Redirect left the GitHub release asset allowlist');
  } else if (url.hostname === 'github.com') validateURL(url.href, true);
  return url.href;
}
function selection({ root, manifest, platform = process.platform, arch = process.arch }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.parse(path.resolve(root)).root === path.resolve(root)) fail('INVALID_ROOT', 'An explicit non-filesystem-root profile-owned absolute toolchain root is required');
  const installRoot = path.resolve(root);
  const target = `${platform}-${arch}`;
  if (!SUPPORTED.has(target) || !manifest || manifest.schemaVersion !== 1 || !Object.hasOwn(manifest.platforms ?? {}, target)) fail('UNSUPPORTED_PLATFORM', `No pinned Roblox toolchain for ${target}; no architecture fallback is permitted`);
  const tools = manifest.platforms[target]?.tools;
  if (!Array.isArray(tools) || !tools.length || tools.length > 32) fail('INVALID_MANIFEST', 'Platform tools must be a non-empty bounded array');
  const names = new Set();
  const binaries = new Set();
  const selected = tools.map(tool => {
    const name = safeSegment(tool.name, 'tool name');
    const version = safeSegment(tool.version, 'tool version');
    if (names.has(name.toLowerCase())) fail('INVALID_MANIFEST', 'Duplicate tool name');
    names.add(name.toLowerCase());
    const url = validateURL(tool.url);
    if (!digestPattern.test(tool.sha256 ?? '') || tool.format && tool.format !== 'zip') fail('INVALID_MANIFEST', `Missing SHA-256 or unsupported archive format for ${name}`);
    if (!Array.isArray(tool.binaries) || !tool.binaries.length || tool.binaries.length > 32) fail('INVALID_MANIFEST', `Missing binaries for ${name}`);
    const entries = tool.binaries.map(binary => {
      const binaryName = safeSegment(binary.name, 'binary name');
      if (binaries.has(binaryName.toLowerCase())) fail('INVALID_MANIFEST', 'Duplicate binary name');
      binaries.add(binaryName.toLowerCase());
      validateArchivePath(binary.path);
      if (binary.sha256 !== undefined && !digestPattern.test(binary.sha256)) fail('INVALID_MANIFEST', 'Invalid binary SHA-256');
      return { name: binaryName, path: binary.path, ...(binary.sha256 ? { sha256: binary.sha256 } : {}) };
    });
    const descriptor = { name, version, url, sha256: tool.sha256, binaries: entries };
    const identity = sha256(JSON.stringify({ target, ...descriptor }));
    const directory = path.join(installRoot, name, version, `${target}-${identity}`);
    return { ...descriptor, identity, directory, output: entries.map(binary => ({ ...binary, relative: `bin/${binary.name}${platform === 'win32' ? '.exe' : ''}` })) };
  });
  return { installRoot, target, selected };
}

async function maybeStat(value) {
  try { return await fs.lstat(value); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Reject symbolic links / Windows junctions in every existing cache ancestor, following only the platform's own layout links. */
async function safeDirectories(directory, create = false) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat = await maybeStat(current);
    if (!stat && create) {
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = await maybeStat(current);
    }
    if (!stat) return false;
    if (SYSTEM_SYMLINKS.has(current)) {
      // Follow the layout link and rebase onto where the OS actually resolves it, so the
      // segments below it are compared against their canonical form rather than the link.
      const base = await fs.realpath(current);
      if (!(await fs.stat(base)).isDirectory()) fail('UNSAFE_CACHE_PATH', `Toolchain ancestor is not a real directory: ${current}`);
      current = base;
      continue;
    }
    let canonical;
    try { canonical = await fs.realpath(current); }
    catch (error) { if (error.code === 'ENOENT' && !create) return false; throw error; }
    const same = process.platform === 'win32' ? canonical.toLowerCase() === current.toLowerCase() : canonical === current;
    // Some constrained Windows filesystem adapters follow junctions even for lstat.
    // Canonical identity comparison therefore supplements isSymbolicLink, not just it.
    if (stat.isSymbolicLink() || !stat.isDirectory() || !same) fail('UNSAFE_CACHE_PATH', `Toolchain ancestor is not a real directory: ${current}`);
  }
  return true;
}
async function safeFile(file, maxBytes) {
  await safeDirectories(path.dirname(file));
  const stat = await maybeStat(file);
  if (!stat) return null;
  // Compare canonically on both sides: the parent may legitimately traverse a platform
  // layout link such as /var, so the literal path and the resolved path differ above the
  // owned root. A link for the file itself still differs from its canonical directory
  // plus own name, so the identity check keeps its meaning.
  const canonical = await fs.realpath(file);
  const expected = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  const same = process.platform === 'win32' ? canonical.toLowerCase() === expected.toLowerCase() : canonical === expected;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || !same) fail('UNSAFE_CACHE_PATH', `Unexpected toolchain file type/size: ${file}`);
  // The profile root is trusted. lstat/realpath plus handle identity detect accidental
  // links and replacements, but do not promise protection from a hostile local owner.
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > maxBytes) fail('UNSAFE_CACHE_PATH', 'Toolchain file changed while reading');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function inspectOne(tool) {
  if (!await safeDirectories(tool.directory)) return { status: 'missing', issue: `${tool.name}: not installed` };
  const bytes = await safeFile(path.join(tool.directory, MARKER), MAX_MARKER_BYTES);
  if (!bytes) return { status: 'corrupt', issue: `${tool.name}: completion receipt missing` };
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'corrupt', issue: `${tool.name}: malformed completion receipt` }; }
  if (!receipt || typeof receipt !== 'object' || receipt.schemaVersion !== 1 || receipt.identity !== tool.identity || receipt.archiveSha256 !== tool.sha256 || !Array.isArray(receipt.binaries) || receipt.binaries.length !== tool.output.length) return { status: 'corrupt', issue: `${tool.name}: receipt does not match pin` };
  const tools = [];
  for (let index = 0; index < tool.output.length; index++) {
    const binary = tool.output[index];
    const entry = receipt.binaries[index];
    if (!entry || typeof entry !== 'object' || entry.name !== binary.name || entry.path !== binary.relative || !digestPattern.test(entry.sha256 ?? '') || binary.sha256 && binary.sha256 !== entry.sha256) return { status: 'corrupt', issue: `${tool.name}: binary receipt mismatch` };
    const executable = path.join(tool.directory, ...binary.relative.split('/'));
    const data = await safeFile(executable, DEFAULT_ARCHIVE_LIMITS.maxUnpackedBytes);
    if (!data || sha256(data) !== entry.sha256) return { status: 'corrupt', issue: `${binary.name}: executable digest mismatch` };
    const stat = await fs.lstat(executable);
    if (process.platform !== 'win32' && !(stat.mode & 0o111)) return { status: 'corrupt', issue: `${binary.name}: not executable` };
    tools.push({ name: binary.name, executable, version: tool.version });
  }
  return { status: 'ready', tools };
}

/** Read-only: validates every receipt and executable digest; never downloads or modifies PATH. */
export async function inspectToolchain(options) {
  const { installRoot, selected } = selection(options);
  await safeDirectories(installRoot);
  const tools = [];
  const issues = [];
  let status = 'ready';
  for (const tool of selected) {
    const result = await inspectOne(tool);
    if (result.status !== 'ready') { issues.push(result.issue); if (status !== 'corrupt') status = result.status; }
    else tools.push(...result.tools);
  }
  return { status, installRoot, tools, issues };
}
export const resolveToolchain = inspectToolchain;

async function download(tool, options) {
  const { fetchImpl = globalThis.fetch, signal, timeoutMs = 120000 } = options;
  if (typeof fetchImpl !== 'function') fail('FETCH_UNAVAILABLE', 'Node fetch is unavailable');
  const timedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  let url = tool.url;
  for (let redirect = 0; redirect <= 5; redirect++) {
    abort(timedSignal);
    const response = await fetchImpl(url, { redirect: 'manual', signal: timedSignal, credentials: 'omit', headers: { Accept: 'application/octet-stream' } });
    if (response.url) validateURL(response.url, response.url === tool.url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirect === 5) fail('DOWNLOAD_FAILED', 'Invalid or excessive release redirects');
      url = validateURL(new URL(location, url).href, false);
      continue;
    }
    if (!response.ok || !response.body) fail('DOWNLOAD_FAILED', `${tool.name}: release download returned HTTP ${response.status}`);
    const advertised = response.headers.get('content-length');
    if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes)) { await response.body.cancel(); fail('DOWNLOAD_TOO_LARGE', 'Release exceeds archive size limit'); }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        abort(timedSignal);
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes) fail('DOWNLOAD_TOO_LARGE', 'Release stream exceeds archive size limit');
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, length);
    if (sha256(bytes) !== tool.sha256) fail('HASH_MISMATCH', `${tool.name}: release SHA-256 does not match the pinned manifest`);
    return bytes;
  }
  fail('DOWNLOAD_FAILED', 'Excessive redirects');
}

function ownedSibling(root, candidate, prefix) {
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(root) || !path.basename(resolved).startsWith(prefix)) fail('UNSAFE_CLEANUP', 'Refusing to clean an unowned staging path');
  return resolved;
}
async function removeOwned(root, candidate, prefix) {
  const resolved = ownedSibling(root, candidate, prefix);
  await safeDirectories(root);
  const stat = await maybeStat(resolved);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_CLEANUP', 'Refusing cleanup of a linked staging directory');
  await safeDirectories(resolved);
  await fs.rm(resolved, { recursive: true, force: false });
}
async function commitStage(stage, tool, signal) {
  // Every contender builds its own complete staging directory. A single directory
  // rename publishes all files together; losers verify the winner, never replace it.
  // No shared lock exists, so a crashed installer cannot block future initialization.
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let attempt = 0; attempt <= 5; attempt++) {
    abort(signal);
    const existing = await inspectOne(tool);
    if (existing.status === 'ready') return 'reused';
    if (existing.status === 'corrupt') fail('CORRUPT_INSTALL', `${existing.issue}; refusing to overwrite immutable install ${tool.directory}. Restore this exact pin or, with DSH closed, remove only this verified tool-version directory and restart setup`);
    await safeDirectories(path.dirname(tool.directory));
    await safeDirectories(stage);
    try {
      await fs.rename(stage, tool.directory);
      return 'installed';
    } catch (error) {
      // Windows reports an existing destination as EPERM/EACCES on some runtimes;
      // POSIX normally reports EEXIST/ENOTEMPTY. In every case validate its contents.
      const winner = await inspectOne(tool);
      if (winner.status === 'ready') return 'reused';
      if (winner.status === 'corrupt') fail('CORRUPT_INSTALL', `${winner.issue}; refusing to overwrite immutable install ${tool.directory}. Restore this exact pin or, with DSH closed, remove only this verified tool-version directory and restart setup`);
      if (!transient.has(error.code) || attempt === 5) throw error;
      await delay(200, undefined, { signal });
    }
  }
}

async function ensure(options) {
  const { installRoot, selected } = selection(options);
  abort(options.signal);
  await safeDirectories(installRoot, true);
  for (const tool of selected) {
      const existing = await inspectOne(tool);
      if (existing.status === 'ready') { options.onProgress?.({ name: tool.name, status: 'reused' }); continue; }
      if (existing.status === 'corrupt') fail('CORRUPT_INSTALL', `${existing.issue}; refusing to overwrite immutable install ${tool.directory}. Restore this exact pin or, with DSH closed, remove only this verified tool-version directory and restart setup`);
      options.onProgress?.({ name: tool.name, status: 'downloading' });
      const archive = await download(tool, options);
      abort(options.signal);
      // Injected extraction operates on authenticated bytes and returns data, never filesystem paths.
      const entries = await (options.extractImpl ?? extractZip)(archive, DEFAULT_ARCHIVE_LIMITS);
      if (!Array.isArray(entries) || entries.length > DEFAULT_ARCHIVE_LIMITS.maxEntries) fail('INVALID_ARCHIVE', 'Extractor returned invalid entries');
      const files = new Map();
      let unpacked = 0;
      for (const entry of entries) {
        validateArchivePath(entry.path);
        if (!Buffer.isBuffer(entry.data) && !(entry.data instanceof Uint8Array)) fail('INVALID_ARCHIVE', 'Extractor returned invalid bytes');
        unpacked += entry.data.byteLength;
        if (unpacked > DEFAULT_ARCHIVE_LIMITS.maxUnpackedBytes || files.has(entry.path.toLowerCase())) fail('INVALID_ARCHIVE', 'Extractor size limit or duplicate path');
        files.set(entry.path.toLowerCase(), entry);
      }
      const stageName = `.stage-${tool.identity}-${randomUUID()}`;
      const stage = ownedSibling(installRoot, path.join(installRoot, stageName), `.stage-${tool.identity}-`);
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        await fs.mkdir(path.join(stage, 'bin'), { mode: 0o700 });
        const receipt = { schemaVersion: 1, identity: tool.identity, archiveSha256: tool.sha256, binaries: [] };
        for (const binary of tool.output) {
          abort(options.signal);
          const entry = files.get(binary.path.toLowerCase());
          if (!entry || entry.path !== binary.path || !entry.data.byteLength) fail('MISSING_BINARY', `${tool.name}: archive is missing ${binary.path}`);
          const digest = sha256(entry.data);
          if (binary.sha256 && binary.sha256 !== digest) fail('HASH_MISMATCH', `${binary.name}: binary SHA-256 mismatch`);
          await fs.writeFile(path.join(stage, ...binary.relative.split('/')), entry.data, { flag: 'wx', mode: 0o755 });
          receipt.binaries.push({ name: binary.name, path: binary.relative, sha256: digest });
        }
        await fs.writeFile(path.join(stage, MARKER), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await safeDirectories(path.dirname(tool.directory), true);
        await safeDirectories(stage);
        abort(options.signal);
        const status = await commitStage(stage, tool, options.signal);
        options.onProgress?.({ name: tool.name, status });
      } finally { await removeOwned(installRoot, stage, `.stage-${tool.identity}-`); }
  }
  const result = await inspectToolchain(options);
  if (result.status !== 'ready') fail('CORRUPT_INSTALL', result.issues.join('; '));
  return result;
}

/**
 * Install once under a caller-owned PROFILE root, never a project directory. No child
 * process, executable probe, shell extraction, global PATH mutation or credentials.
 * Downloads use bounded HTTPS/redirects and pinned SHA-256 before any extraction.
 * No-signal callers singleflight in-process. Other callers independently stage and
 * atomically race to publish; each loser verifies the winner and cleans only its stage.
 * Legacy lock directories and abandoned stages are ignored, never swept or stolen.
 */
export function ensureToolchain(options) {
  let selected;
  try { selected = selection(options); } catch (error) { return Promise.reject(error); }
  if (options.signal) return ensure(options);
  const key = `${selected.installRoot}\0${selected.selected.map(tool => tool.identity).join(',')}`;
  if (flights.has(key)) return flights.get(key);
  const promise = ensure(options).finally(() => { if (flights.get(key) === promise) flights.delete(key); });
  flights.set(key, promise);
  return promise;
}
