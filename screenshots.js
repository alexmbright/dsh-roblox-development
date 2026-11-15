/**
 * Shared screenshot references for a Roblox worker tree.
 *
 * Studio capture tools return images that DSH stores as durable attachments in the capturing
 * session's log. Nothing is written to the project. This module gives each stored capture a short,
 * stable id (`cap-<10 chars>`, derived from the content-addressed attachment id) and lets any
 * agent in the same tree (lead, implementer, reviewer, QA) list, view or selectively export them
 * by id. Ids travel in prompts, send_message, reports and VISUAL_GATE.md like any other text.
 * @module @alexturbo/dsh-roblox-development/screenshots
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const CAPTURE_TOOLS = ['screen_capture', 'capture_screenshot', 'capture_device_matrix'];
export const CAPTURE_REF = /\bcap-[0-9a-z]{6,}\b/g;
export const SCREENSHOT_TOOL = 'roblox_screenshots';
const MAX_VIEW = 6;

const baseName = name => (typeof name === 'string' && name.startsWith('mcp__') ? name.split('__').pop() : name);

/** Stable capture id for one stored attachment id. */
export const captureId = attachmentId => `cap-${String(attachmentId).replace(/[^A-Za-z0-9]/g, '').slice(-10).toLowerCase()}`;

/** Capture ids mentioned in a text. */
export const captureRefs = text => [...new Set(String(text ?? '').match(CAPTURE_REF) ?? [])];

const eventsOf = session => {
  const count = typeof session?.seq === 'number' ? session.seq : session?.events?.length ?? 0;
  const at = seq => (typeof session?.eventAt === 'function' ? session.eventAt(seq) : session?.events?.[seq]);
  const out = [];
  for (let seq = 0; seq < count; seq += 1) out.push(at(seq));
  return out;
};

/**
 * Captures recorded in one session log, oldest first.
 * @param session - live or inspected session.
 * @param agent - display name of the capturing agent.
 */
export function capturesIn(session, agent = '') {
  const pending = new Map();
  const out = [];
  for (const event of eventsOf(session)) {
    const data = event?.data;
    if (event?.type === 'tool/call' && CAPTURE_TOOLS.includes(baseName(data?.name))) {
      pending.set(data.callId, baseName(data.name));
    } else if (event?.type === 'tool/result' && pending.has(data?.message?.toolCallId)) {
      const tool = pending.get(data.message.toolCallId);
      pending.delete(data.message.toolCallId);
      if (data.message.isError === true) continue;
      let label = '';
      for (const block of data.message.content ?? []) {
        if (block?.type === 'text') {
          label = /capture_device_matrix \d+\/\d+ ([^:]+):/.exec(block.text ?? '')?.[1]?.trim() ?? label;
        } else if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
          out.push({
            id: captureId(block.attachment.attachmentId),
            agent, tool, label,
            time: event.time ?? 0,
            attachment: block.attachment,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Every capture in the caller's worker tree (root lead plus all descendants), newest first.
 * Live sessions are read in place; settled ones through the durable session log.
 */
export async function collectTree(ctx, agent, signal) {
  const subagents = ctx.get('subagents');
  let root = agent;
  try {
    root = subagents?.rootOf?.(agent) ?? agent;
  } catch { /* the caller is its own root */ }
  const rootId = root?.session?.id ?? root?.id;
  let rootName = 'lead';
  try {
    rootName = subagents?.namesOf?.(root)?.self ?? 'lead';
  } catch { /* keep lead */ }
  const members = [{ id: rootId, name: rootName }];
  const unreadable = [];
  try {
    for (const entry of await subagents?.listDescendants?.(rootId, signal) ?? []) {
      if (entry?.kind === 'child') members.push({ id: entry.id, name: entry.name ?? entry.label ?? String(entry.id) });
      else if (entry?.kind === 'diagnostic') unreadable.push(`${entry.id}: ${entry.reason}`);
    }
  } catch (error) {
    unreadable.push(`worker catalog: ${error?.message ?? error}`);
  }
  const captures = [];
  for (const member of members) {
    const live = ctx.get('agents')?.get?.(member.id)?.session;
    try {
      if (live !== undefined) captures.push(...capturesIn(live, member.name));
      else captures.push(...await ctx.get('sessionQuery').inspectSession(member.id, session => capturesIn(session, member.name), signal));
    } catch (error) {
      unreadable.push(`${member.name}: ${error?.message ?? error}`);
    }
  }
  const unique = new Map();
  for (const capture of captures) if (!unique.has(capture.id)) unique.set(capture.id, capture);
  return { captures: [...unique.values()].sort((a, b) => b.time - a.time), unreadable };
}

const hostPath = (ctx, attachment) => {
  try {
    return ctx.get('attachments')?.imageHostPath?.(attachment) ?? '';
  } catch {
    return '';
  }
};

const describe = (ctx, capture) => ({
  id: capture.id,
  agent: capture.agent,
  tool: capture.tool,
  label: capture.label,
  capturedAt: new Date(capture.time).toISOString(),
  width: capture.attachment.width,
  height: capture.attachment.height,
  path: hostPath(ctx, capture.attachment),
});

async function canSeeImages(ctx, exec) {
  try {
    const config = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = config?.provider ?? exec?.agent?.options?.provider;
    const model = config?.model ?? exec?.agent?.options?.model;
    if (provider === undefined || model === undefined) return false;
    const info = await ctx.get('llm')?.resolveModelInfo?.(provider, model, exec.signal);
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
  } catch {
    return false;
  }
}

const extensionOf = mediaType => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mediaType] ?? 'png';

/**
 * Register `roblox_screenshots`.
 * @param ctx - registrant context (subagents, agents, sessionQuery, attachments, llm).
 * @param projectRoot - `(session) => project root`, for export.
 * @returns the disposer, or undefined when tools are unavailable.
 */
export function registerScreenshotTool(ctx, projectRoot) {
  if (typeof ctx.tools?.register !== 'function') return undefined;
  return ctx.tools.register({
    name: SCREENSHOT_TOOL,
    description: 'Share Studio screenshots across this worker tree without saving files. Every screen_capture, capture_screenshot '
      + 'or capture_device_matrix image taken by the lead or any worker gets a stable id like cap-1a2b3c4d5e. '
      + 'action "list": newest captures with id, agent, tool, label, time and a local preview path. '
      + 'action "view": see up to 6 captures by id (pass ids to reviewers and QA in prompts or messages so they can view them). '
      + 'action "export": copy chosen captures into the project (default screenshots/) only when a file is really needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'export'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Capture ids for view or export.' },
        agent: { type: 'string', description: 'List only captures taken by this agent name.' },
        limit: { type: 'integer', description: 'List size, default 12.' },
        dir: { type: 'string', description: 'Export directory inside the project, default screenshots.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: JSON.stringify({ ...value, images: undefined }) }];
        if (value?.viewable === true) {
          for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image });
        }
        return blocks;
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { captures, unreadable } = await collectTree(ctx, exec.agent, exec.signal);
      const notes = unreadable.length > 0 ? { unreadable } : {};
      if (args.action === 'list') {
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 12;
        const chosen = captures.filter(capture => args.agent === undefined || capture.agent === args.agent).slice(0, limit);
        return { captures: chosen.map(capture => describe(ctx, capture)), total: captures.length, ...notes };
      }
      const ids = [...new Set(args.ids ?? [])];
      if (ids.length === 0) throw new Error(`${args.action} needs capture ids; call action "list" first`);
      const byId = new Map(captures.map(capture => [capture.id, capture]));
      const missing = ids.filter(id => !byId.has(id));
      if (missing.length > 0) throw new Error(`unknown capture id(s) in this worker tree: ${missing.join(', ')}`);
      const chosen = ids.map(id => byId.get(id));
      if (args.action === 'view') {
        if (chosen.length > MAX_VIEW) throw new Error(`view at most ${MAX_VIEW} captures at a time`);
        const viewable = await canSeeImages(ctx, exec);
        return {
          captures: chosen.map(capture => describe(ctx, capture)),
          viewable,
          ...(viewable ? { images: chosen.map(capture => capture.attachment) } : { note: 'this model cannot read images; ask a visual worker to view them' }),
          ...notes,
        };
      }
      const root = projectRoot(exec.agent?.session);
      if (root === undefined) throw new Error('no project directory for export');
      const dir = path.resolve(root, typeof args.dir === 'string' && args.dir !== '' ? args.dir : 'screenshots');
      if (path.relative(root, dir).startsWith('..') || path.isAbsolute(path.relative(root, dir))) throw new Error('export directory must stay inside the project');
      mkdirSync(dir, { recursive: true });
      const files = [];
      for (const capture of chosen) {
        const source = hostPath(ctx, capture.attachment);
        if (source === '') throw new Error(`capture ${capture.id} has no local file to export`);
        const label = capture.label ? `-${capture.label.replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase()}` : '';
        const target = path.join(dir, `${capture.id}${label}.${extensionOf(capture.attachment.mediaType)}`);
        copyFileSync(source, target);
        files.push(path.relative(root, target));
      }
      return { exported: files, ...notes };
    },
  });
}
