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
import { copyFileSync, mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { readStoredSession } from './session-read.js';

export const CAPTURE_TOOLS = ['screen_capture', 'capture_screenshot', 'capture_device_matrix'];
export const CAPTURE_REF = /\bcap-[0-9a-z]{6,}\b/g;
export const SCREENSHOT_TOOL = 'roblox_screenshots';
const MAX_VIEW = 6;
export { MAX_VIEW };

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
 * Marker line for a capture stored on behalf of a model without image input. The image is kept
 * out of that model's context; the line carries the stored reference into the session log so the
 * capture is still shared with the tree.
 */
export const STORED_MARKER = '[roblox-capture-stored]';
const storedLine = (label, attachment) => `${STORED_MARKER} ${JSON.stringify({ id: captureId(attachment.attachmentId), label, attachment })}`;

/** A capture that is probably not the real viewport: tiny, or a reported fallback path. */
export const isSuspicious = (attachment, fallback = false) => fallback
  || !Number.isFinite(attachment?.width) || !Number.isFinite(attachment?.height)
  || attachment.width <= 0 || attachment.height <= 0
  || (attachment.width <= 256 && attachment.height <= 256);

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
      pending.set(data.callId, { time: event.time ?? 0, tool: baseName(data.name), server: /^mcp__(.+)__[^_]/.exec(data.name ?? '')?.[1] ?? '' });
    } else if (event?.type === 'tool/result' && pending.has(data?.message?.toolCallId)) {
      const { tool, server, time } = pending.get(data.message.toolCallId);
      pending.delete(data.message.toolCallId);
      if (data.message.isError === true) continue;
      let label = '';
      // Fallback metadata applies to the whole result, including images/markers that precede it.
      const fallback = (data.message.content ?? []).some(block => block?.type === 'text'
        && /"studioFastPathUnavailable"\s*:\s*true/.test(block.text ?? ''));
      const push = (attachment, stored = false) => out.push({
        id: captureId(attachment.attachmentId),
        agent, tool, server, label,
        time,
        attachment,
        stored,
        suspicious: isSuspicious(attachment, fallback),
      });
      for (const block of data.message.content ?? []) {
        if (block?.type === 'text') {
          const text = block.text ?? '';
          label = /capture_device_matrix \d+\/\d+ ([^:]+):/.exec(text)?.[1]?.trim() ?? label;
          for (const line of text.split('\n')) {
            if (!line.startsWith(STORED_MARKER)) continue;
            try {
              const stored = JSON.parse(line.slice(STORED_MARKER.length));
              if (stored?.attachment?.attachmentId !== undefined) {
                if (typeof stored.label === 'string' && stored.label !== '') label = stored.label;
                push(stored.attachment, true);
              }
            } catch { /* malformed marker: not a capture */ }
          }
        } else if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
          push(block.attachment);
        }
      }
    }
  }
  return out;
}

/**
 * Store captures for a model that cannot take images, so they are still shared.
 *
 * DSH's MCP client only stores an image when the calling model declares image input; otherwise
 * the model sees an "[image unavailable…]" note and the image is lost. This post-execute hook
 * saves the raw images itself and replaces the content with text plus marker lines, so the
 * capture appears in roblox_screenshots and the sidebar while the model reads only text.
 * @returns a `tools/post-execute` listener.
 */
export function storeTextOnlyCaptures(ctx) {
  return async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || 'content' in decision || 'value' in decision || result.isError !== false) return decision;
    if (!CAPTURE_TOOLS.includes(baseName(exec.name)) || !String(exec.name).startsWith('mcp__')) return decision;
    if ((result.content ?? []).some(block => block?.type === 'image')) return decision;
    const raw = (result.value?.content ?? []).filter(block => block?.type === 'image' && typeof block.data === 'string');
    if (raw.length === 0) return decision;
    const attachments = ctx.get('attachments');
    if (typeof attachments?.saveImages !== 'function') return decision;
    let refs;
    try {
      refs = await attachments.saveImages(raw.map(block => ({ data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType })));
    } catch {
      return decision;
    }
    const texts = (result.value.content ?? []).filter(block => block?.type === 'text').map(block => block.text);
    const labels = texts.map(text => /capture_device_matrix \d+\/\d+ ([^:]+):/.exec(text)?.[1]?.trim()).filter(Boolean);
    const lines = refs.map((ref, index) => storedLine(labels[index] ?? '', ref));
    const ids = refs.map(ref => captureId(ref.attachmentId));
    return {
      ...decision,
      content: [{
        type: 'text',
        text: [...texts,
          `Captured ${ids.join(', ')}. This model cannot view images; the capture is stored and shared with the worker tree. `
            + 'Pass these ids to a visual worker or the lead (roblox_screenshots).',
          ...lines].join('\n'),
      }],
    };
  };
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
  let rootName = 'lead';
  try {
    rootName = subagents?.namesOf?.(root)?.self ?? 'lead';
  } catch { /* keep lead */ }
  return collectTreeById(ctx, root?.session?.id ?? root?.id, rootName, signal);
}

/**
 * Every capture under one root session id, newest first. The sidebar uses this with the
 * Session it shows; a worker Session resolves to its root through its header parent chain.
 */
export async function collectTreeById(ctx, rootId, rootName = 'lead', signal) {
  const subagents = ctx.get('subagents');
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
      else captures.push(...await readStoredSession(ctx.get('sessionQuery'), member.id, session => capturesIn(session, member.name), signal));
    } catch (error) {
      unreadable.push(`${member.name}: ${error?.message ?? error}`);
    }
  }
  const unique = new Map();
  for (const capture of captures) {
    const previous = unique.get(capture.id);
    if (!previous || capture.time > previous.time) unique.set(capture.id, capture);
    else if (capture.time === previous.time && capture.suspicious) previous.suspicious = true;
  }
  return { captures: [...unique.values()].sort((a, b) => b.time - a.time), unreadable };
}

const hostPath = (ctx, attachment) => {
  try {
    return ctx.get('attachments')?.imageHostPath?.(attachment) ?? '';
  } catch {
    return '';
  }
};

export const describe = (ctx, capture) => ({
  id: capture.id,
  attachmentId: capture.attachment.attachmentId,
  agent: capture.agent,
  tool: capture.tool,
  server: capture.server ?? '',
  label: capture.label,
  capturedAt: new Date(capture.time).toISOString(),
  width: capture.attachment.width,
  height: capture.attachment.height,
  suspicious: capture.suspicious === true,
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
      + 'action "list": newest captures with id, agent, tool, server, label, time and a local preview path; "suspicious" marks '
      + '256x256-or-smaller or fallback captures, which are probably not the real viewport and do not count for the visual gate. '
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
        // Exporting an old image must not turn it into a newly captured screenshot.
        if (Number.isFinite(capture.time) && capture.time > 0) utimesSync(target, capture.time / 1000, capture.time / 1000);
        files.push(path.relative(root, target));
      }
      return { exported: files, ...notes };
    },
  });
}
