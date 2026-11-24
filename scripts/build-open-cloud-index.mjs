#!/usr/bin/env node
/**
 * Build `open-cloud-index.json` from Roblox's official Open Cloud OpenAPI document.
 *
 * Usage: node scripts/build-open-cloud-index.mjs [path-to-openapi.json]
 * Without a path it downloads the document from Roblox/creator-docs (main).
 *
 * Only operations that accept an API key (`x-api-key`) are kept: cookie-only and
 * OAuth-only endpoints cannot be called with the key from the Roblox page. Each
 * operation is reduced to what an agent needs to call it: method, path template,
 * host (when not apis.roblox.com), summary, scopes, parameters and a compact
 * request-body sketch. The result is vendored so the tool works offline.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/cloud/openapi.json';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const DEFAULT_HOST = 'apis.roblox.com';
/** Facts the document leaves out but a caller needs. */
const NOTES = {
  'POST /universes/v1/{universeId}/places/{placeId}/versions':
    'Publish or save a place file. Send the file as the raw body (file: "<path>.rbxl" or ".rbxlx"); versionType=Saved|Published.',
  'POST /assets/v1/assets':
    'Multipart: form.request = JSON metadata {assetType, displayName, description, creationContext:{creator:{userId|groupId}}}; files.fileContent = local path. Returns an operation; pass wait to poll it.',
  'PATCH /assets/v1/assets/{assetId}':
    'Multipart: form.request = JSON {assetId, ...changed fields}; optional files.fileContent; query updateMask.',
  'POST /cloud/v2/universes/{universe_id}/places/{place_id}/luau-execution-session-tasks':
    'Body {script, timeout?}. Runs on a fresh server of the saved place; pass wait to poll and fetch logs.',
};
const out = fileURLToPath(new URL('../open-cloud-index.json', import.meta.url));

const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch(SOURCE)).text();
const spec = JSON.parse(raw);

const deref = node => {
  let current = node;
  for (let i = 0; i < 8 && current?.$ref; i++) {
    current = current.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], spec);
  }
  return current;
};

const clip = (text, max) => {
  const flat = String(text ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=\.)\s/)[0];
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
};

/** Render a schema as a compact TypeScript-like sketch. */
function sketch(node, depth = 0, seen = new Set()) {
  const ref = node?.$ref;
  const schema = deref(node);
  if (!schema || typeof schema !== 'object') return 'any';
  if (ref && seen.has(ref)) return ref.split('/').pop();
  const nextSeen = ref ? new Set([...seen, ref]) : seen;
  if (schema.allOf?.length === 1) return sketch(schema.allOf[0], depth, nextSeen);
  if (schema.allOf) return schema.allOf.map(part => sketch(part, depth, nextSeen)).join(' & ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(part => sketch(part, depth, nextSeen)).join(' | ');
  if (schema.enum) return schema.enum.slice(0, 12).map(v => JSON.stringify(v)).join('|') + (schema.enum.length > 12 ? '|…' : '');
  if (schema.type === 'array') return `${sketch(schema.items, depth, nextSeen)}[]`;
  if (schema.type === 'object' || schema.properties) {
    const props = Object.entries(schema.properties ?? {});
    if (props.length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        return `{[k]: ${sketch(schema.additionalProperties, depth + 1, nextSeen)}}`;
      }
      return 'object';
    }
    if (depth >= 3) return ref ? ref.split('/').pop() : 'object';
    const required = new Set(schema.required ?? []);
    const pad = '  '.repeat(depth + 1);
    // Request sketches: read-only (server-set) fields cannot be sent, so they are noise.
    const lines = props.filter(([, value]) => !deref(value)?.readOnly).map(([key, value]) => {
      const v = deref(value);
      const desc = depth === 0 && v?.description ? ` // ${clip(v.description, 90)}` : '';
      return `${pad}${key}${required.has(key) ? '' : '?'}: ${sketch(value, depth + 1, nextSeen)}${desc}`;
    });
    if (lines.length === 0) return 'object';
    return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
  }
  const fmt = schema.format && !['int32', 'double', 'float'].includes(schema.format) ? `<${schema.format}>` : '';
  return `${schema.type ?? 'any'}${fmt}`;
}

/** A readable summary; some legacy operations only carry "Invokes X operation" or their id. */
function summaryOf(op) {
  const generic = !op.summary || /^Invokes /.test(op.summary) || /^[A-Za-z]+_[A-Za-z0-9]+$/.test(op.summary);
  if (!generic) return op.summary;
  const id = String(op.operationId ?? '').replace(/^.*_/, '').replace(/ApiKey$/, '');
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return words || op.description || op.operationId || '';
}

const hosts = new Set();
const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const security = (op.security ?? spec.security ?? []).flatMap(entry => Object.keys(entry));
    if (!security.includes('roblox-api-key')) continue;
    const host = new URL((op.servers ?? item.servers ?? spec.servers)[0].url).host;
    hosts.add(host);
    // Some legacy paths carry a "#host" disambiguation suffix in the document.
    const cleanPath = path.replace(/#.*$/, '');
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref)
      .filter(p => p && ['path', 'query', 'header'].includes(p.in))
      .filter(p => !(p.in === 'header' && /^x-api-key$/i.test(p.name)))
      .map(p => [p.name, p.in, p.required ? 1 : 0, sketch(p.schema).replace(/\s+/g, ' '), clip(p.description, 100)]);
    const body = deref(op.requestBody);
    let b;
    if (body?.content) {
      const types = Object.keys(body.content);
      const ct = types.find(t => t === 'multipart/form-data') ?? types.find(t => t === 'application/json') ?? types[0];
      b = [ct, sketch(body.content[ct].schema)];
    }
    const scopes = [...new Set((op['x-roblox-scopes'] ?? []).map(s => s.name))];
    const rl = op['x-roblox-rate-limits']?.perApiKeyOwner;
    const entry = {
      m: method.toUpperCase(),
      p: cleanPath,
      s: clip(summaryOf(op), 110),
    };
    if (host !== DEFAULT_HOST) entry.h = host;
    if (op.tags?.length) entry.t = op.tags[0];
    if (scopes.length) entry.sc = scopes;
    if (op['x-roblox-stability'] && op['x-roblox-stability'] !== 'STABLE') entry.st = op['x-roblox-stability'];
    if (rl) entry.rl = `${rl.maxInPeriod}/${String(rl.period).toLowerCase()}`;
    if (params.length) entry.q = params;
    if (b) entry.b = b;
    const desc = clip(op.description, 300);
    if (desc && desc !== entry.s) entry.d = desc;
    const note = NOTES[`${entry.m} ${entry.p}`];
    if (note) entry.d = entry.d ? `${note} ${entry.d}` : note;
    if (op.externalDocs?.url) entry.u = op.externalDocs.url.replace('https://create.roblox.com/docs/cloud/reference/', '');
    ops.push(entry);
  }
}
ops.sort((a, b) => a.p.localeCompare(b.p) || a.m.localeCompare(b.m));

const index = {
  source: SOURCE,
  sha256: createHash('sha256').update(raw).digest('hex'),
  built: new Date().toISOString().slice(0, 10),
  hosts: [...hosts].sort(),
  ops,
};
writeFileSync(out, `${JSON.stringify(index)}\n`);
console.log(`wrote ${ops.length} operations (${hosts.size} hosts) to ${out}`);
