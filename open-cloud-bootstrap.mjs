/** Credential containment for the reviewed @chrrxs/robloxstudio-mcp@3.6.0 entry only. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const entryHash = 'e3d2ebe2bd023d200bb89eeaba0692ecf8abea81516b631f814f4ea2b9a96eb5';
const handoff = 'dsh:roblox-open-cloud-credentials';
let pending;

// The verified entry takes the values into its own module scope, once. Values are never
// embedded in transformed code, attached to globalThis, or put back into the environment.
export function takeOpenCloudCredentials() {
  if (!pending) throw new Error('Roblox Open Cloud credential handoff unavailable.');
  const values = pending;
  pending = undefined;
  return values;
}

function replace(source, before, after, count = 1) {
  const parts = source.split(before);
  if (parts.length !== count + 1) throw new Error('Unexpected Studio MCP source.');
  return parts.join(after);
}

function transform(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== entryHash) {
    throw new Error('Unexpected Studio MCP digest.');
  }
  let source = bytes.toString('utf8');
  const edits = [
    ['this.apiKey = config.apiKey || process.env.ROBLOX_OPEN_CLOUD_API_KEY || "";',
      'this.apiKey = config.apiKey || dshOpenCloud.apiKey || "";'],
    ['const envGroupId = process.env.ROBLOX_CREATOR_GROUP_ID;', 'const envGroupId = dshOpenCloud.creatorGroupId;'],
    ['const envUserId = process.env.ROBLOX_CREATOR_USER_ID;', 'const envUserId = dshOpenCloud.creatorUserId;'],
    [`  const openCloudKey = flagValue("--open-cloud-key");
  const creatorId = flagValue("--creator-id");
  const creatorGroupId = flagValue("--creator-group-id");
  if (openCloudKey) process.env.ROBLOX_OPEN_CLOUD_API_KEY = openCloudKey;
  if (creatorId) process.env.ROBLOX_CREATOR_USER_ID = creatorId;
  if (creatorGroupId) process.env.ROBLOX_CREATOR_GROUP_ID = creatorGroupId;
`, ''],
    // Do not propagate response error bodies, header-bearing transport errors or error causes.
    [`async function openCloudResponseError(response) {
  const errorBody = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(errorBody);
  } catch {
    parsed = void 0;
  }
  const text = (key) => {
    const value = readField(parsed, key);
    return typeof value === "string" && value ? value : void 0;
  };
  const errorMessage2 = text("detail") ?? text("message") ?? text("errorMessage") ?? errorBody;
  const errorCode3 = readField(parsed, "errorCode");
  const field = text("field");
  const hint = text("hint");
  const details = {
    ...typeof errorCode3 === "string" || typeof errorCode3 === "number" ? { errorCode: errorCode3 } : {},
    ...field ? { field } : {},
    ...hint ? { hint } : {}
  };
  const { status } = response;
  let message;
  if (status === 401) {
    message = "Invalid or expired API key";
  } else if (status === 403) {
    message = \`API key lacks required permissions: \${errorMessage2}\`;
  } else if (status === 429) {
    message = "Rate limit exceeded. Please try again later.";
  } else {
    message = \`Open Cloud API error (\${status}): \${errorMessage2}\`;
  }
  return new OpenCloudRequestError(message, status, details);
}`,
      `async function openCloudResponseError(response) {
  await response.body?.cancel().catch(() => {});
  const { status } = response;
  const message = {
    401: "Invalid or expired API key",
    403: "API key lacks required permissions",
    429: "Rate limit exceeded. Please try again later."
  }[status] ?? \`Open Cloud API error (\${status})\`;
  return new OpenCloudRequestError(message, status);
}`],
    [`      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new Error("Request timed out");
        }
        throw error;
      }
      throw new Error(\`Unknown error: \${String(error)}\`);`,
      `      if (error instanceof OpenCloudRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new Error("Request timed out");
      throw new Error("Open Cloud request failed.");`, 2],
    ['      const response = await fetch(url.toString(), {\n        method,\n        headers,',
      '      const response = await fetch(url.toString(), {\n        redirect: authRequired ? "error" : "follow",\n        method,\n        headers,'],
    ['        headers: { "x-api-key": this.apiKey },', '        redirect: "error",\n        headers: { "x-api-key": this.apiKey },'],
    [`      const deliveryResponse = await fetch(\`\${this.baseUrl}/asset-delivery-api/v1/assetId/\${assetId}\`, {
        headers: {
          "x-api-key": this.apiKey
        },
        signal: controller.signal
      });`,
      `      const deliveryResponse = await fetch(\`\${this.baseUrl}/asset-delivery-api/v1/assetId/\${assetId}\`, {
        redirect: "error",
        headers: { "x-api-key": this.apiKey },
        signal: controller.signal
      }).catch(() => { throw new Error("Roblox asset delivery request failed."); });`],
    [`      const delivery = await deliveryResponse.json();
      if (!delivery.location) {
        const detail = delivery.errors?.map((entry) => entry.message).filter((message) => !!message).join("; ");
        throw new Error(detail || "Roblox asset delivery returned no download location.");
      }
      const location = new URL(delivery.location);`,
      `      const delivery = await deliveryResponse.json().catch(() => null);
      if (typeof delivery?.location !== "string") {
        throw new Error("Roblox asset delivery returned no download location.");
      }
      const location = URL.parse(delivery.location);
      if (!location) throw new Error("Roblox asset delivery returned an invalid download location.");`],
    ['    const message = readField(error, "message");\n    throw new OpenCloudOperationError(typeof message === "string" && message ? message : "Open Cloud reported an unspecified operation error.", operationPath, typeof code === "number" ? code : void 0);',
      '    throw new OpenCloudOperationError("Open Cloud reported an asset upload error.", "(withheld)", typeof code === "number" ? code : void 0);'],
    ['throw new OpenCloudOperationError("Open Cloud operation completed without an asset ID.", operationPath, void 0, true);',
      'throw new OpenCloudOperationError("Open Cloud operation completed without an asset ID.", "(withheld)", void 0, true);'],
  ];
  for (const edit of edits) source = replace(source, ...edit);
  const preamble = `import { takeOpenCloudCredentials as dshTakeOpenCloud } from '${handoff}';\nconst dshOpenCloud = dshTakeOpenCloud();\n`;
  return replace(source, '#!/usr/bin/env node\n', '#!/usr/bin/env node\n' + preamble);
}

async function run() {
  pending = Object.freeze({
    apiKey: process.env.ROBLOX_OPEN_CLOUD_API_KEY,
    creatorUserId: process.env.ROBLOX_CREATOR_USER_ID,
    creatorGroupId: process.env.ROBLOX_CREATOR_GROUP_ID,
  });
  for (const name of Object.keys(process.env)) {
    if (/^ROBLOX_(?:OPEN_CLOUD_API_KEY|CREATOR_(?:USER|GROUP)_ID)$/i.test(name)) delete process.env[name];
  }

  const [, , entry, ...args] = process.argv;
  if (typeof nodeModule.registerHooks !== 'function' || !entry ||
      args.some(arg => /^--(?:open-cloud-key|creator-id|creator-group-id)(?:=|$)/.test(arg))) {
    throw new Error('Unsupported Studio MCP invocation.');
  }
  const path = realpathSync(entry);
  if (basename(path) !== 'index.js' || basename(dirname(path)) !== 'dist') {
    throw new Error('Unexpected Studio MCP entry path.');
  }
  const entryUrl = pathToFileURL(path).href;
  let loaded = false;
  // The exact buffer we verify is the buffer we transform and execute; never load a
  // fallback copy from disk, even if the entry changes during startup.
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === handoff && context.parentURL === entryUrl) {
        return { url: import.meta.url, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url !== entryUrl) return nextLoad(url, context);
      const source = transform(readFileSync(path));
      loaded = true;
      return { format: 'module', source, shortCircuit: true };
    },
  });
  try {
    // Upstream uses argv[1] to find its own bundled assets and argv[2...] for flags.
    process.argv.splice(1, 2, path);
    await import(entryUrl);
    if (!loaded || pending) throw new Error('Studio MCP containment did not initialize.');
  } finally {
    pending = undefined;
    hooks.deregister();
  }
}

// No top-level await: the verified entry imports the one-shot handoff from this module.
void run().catch(() => {
  pending = undefined;
  console.error('[roblox-open-cloud] Refusing to start the Studio MCP: the pinned dependency, runtime, or arguments are unsupported.');
  process.exitCode = 1;
});
