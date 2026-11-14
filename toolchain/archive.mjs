import { inflateRawSync } from 'node:zlib';

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxUnpackedBytes: 384 * 1024 * 1024,
  maxEntries: 4096,
});

function invalid(message) {
  const error = new Error(`Unsafe or unsupported ZIP archive: ${message}`);
  error.code = 'INVALID_ARCHIVE';
  throw error;
}

/** Portable, collision-resistant relative paths; deliberately rejects Windows aliases on every OS. */
export function validateArchivePath(value, directory = false) {
  if (typeof value !== 'string' || !value || /[^\x20-\x7e]/.test(value) || value.includes('\\') || value.includes(':') || value.startsWith('/')) {
    invalid('non-portable or absolute entry path');
  }
  const clean = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = clean.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    invalid(`invalid entry path: ${value}`);
  }
  return clean;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Parse ZIP in memory, without external programs or writing any archive-controlled paths.
 * Only stored/deflated regular files and directories are accepted. ZIP64, encryption,
 * multipart archives, links, non-ASCII names and ambiguous/colliding paths fail closed.
 * Authenticity is the caller's SHA-256 check; CRC and structural checks catch corruption.
 */
export function extractZip(input, options = {}) {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_ARCHIVE_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) invalid(`invalid ${key} limit`);
  }
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > limits.maxArchiveBytes || bytes.length < 22) invalid('archive size limit or truncated archive');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalid('missing end of central directory');
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalid('multipart/ZIP64 archive');
  if (!count || count > limits.maxEntries || centralOffset + centralSize !== end) invalid('invalid central directory bounds/count');
  let cursor = centralOffset;
  let unpacked = 0;
  const records = [];
  const paths = new Map();
  const spans = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('truncated central directory');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const extraSize = bytes.readUInt16LE(cursor + 30);
    const commentSize = bytes.readUInt16LE(cursor + 32);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize || bytes.readUInt16LE(cursor + 34) || [compressedSize, size, localOffset].includes(0xffffffff)) invalid('invalid record bounds/ZIP64');
    if ((flags & ~(0x800 | 8 | 6)) || (method !== 0 && method !== 8)) invalid('encrypted or unsupported compression');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    if (nameBytes.some(byte => byte > 0x7f)) invalid('non-ASCII entry name');
    const rawPath = nameBytes.toString('ascii');
    const unixType = (attributes >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) invalid('links or special entries');
    if (attributes & 0x400) invalid('reparse entry');
    const directory = rawPath.endsWith('/');
    if (unixType === 0x4000 && !directory || unixType === 0x8000 && directory || directory && size) invalid('inconsistent directory entry');
    const path = validateArchivePath(rawPath, directory);
    const key = path.toLowerCase();
    if (paths.has(key)) invalid('duplicate or case-colliding entry');
    paths.set(key, directory);
    unpacked += size;
    if (unpacked > limits.maxUnpackedBytes) invalid('unpacked size limit');
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) invalid('invalid local record');
    const localNameSize = bytes.readUInt16LE(localOffset + 26);
    const dataOffset = localOffset + 30 + localNameSize + bytes.readUInt16LE(localOffset + 28);
    if (dataOffset + compressedSize > centralOffset || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes)) invalid('inconsistent local record');
    if (!(flags & 8) && (bytes.readUInt32LE(localOffset + 14) !== checksum || bytes.readUInt32LE(localOffset + 18) !== compressedSize || bytes.readUInt32LE(localOffset + 22) !== size)) invalid('inconsistent local sizes/checksum');
    spans.push([localOffset, dataOffset + compressedSize]);
    records.push({ path, directory, size, compressedSize, method, checksum, dataOffset, mode: (attributes >>> 16) & 0o777 });
    cursor = next;
  }
  if (cursor !== end) invalid('central directory size mismatch');
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) invalid('overlapping entries');
  for (const record of records) {
    const segments = record.path.toLowerCase().split('/');
    for (let i = 1; i < segments.length; i++) if (paths.get(segments.slice(0, i).join('/')) === false) invalid('file used as a parent directory');
  }
  return records.filter(record => !record.directory).map(record => {
    const packed = bytes.subarray(record.dataOffset, record.dataOffset + record.compressedSize);
    let data;
    try {
      data = record.method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, record.size) });
    } catch { invalid('invalid or oversized deflate stream'); }
    if (data.length !== record.size || crc32(data) !== record.checksum) invalid('size or CRC mismatch');
    return { path: record.path, data, mode: record.mode };
  });
}
