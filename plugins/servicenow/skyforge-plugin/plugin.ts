/**
 * LiveMap's plugin for SkyForge (an OpenCode fork). SkyForge loads every JS file in `~/.skyforge/plugin/` at
 * start-up; `npm run build` bundles this file into one self-contained ESM file with Node built-ins only
 * (`dist/livemap-skyforge.js`, committed as `livemap-skyforge.js` next to this file).
 *
 * It reports SkyForge's nexus tool calls, prompts and assistant text to a running `livemap sn`, with the same
 * classifier, redaction and update set tracking as `livemap mcp-proxy` (it is built from the same code). It
 * never changes a call, never waits on LiveMap, and never throws into SkyForge: every hook body is wrapped,
 * and events go through a bounded fire-and-forget queue.
 */
import fs from 'node:fs';
import path from 'node:path';
import { argNames, buildCapture, buildText, MAX_PARSED_RESULT, needsResult, SessionContext, type CaptureEvent, type TextEvent } from '../../../src/proxy/capture.js';
import { HookPoster } from '../../../src/proxy/poster.js';
import { baseToolName, toolServer } from '../../../src/shared/tools.js';
import { livemapHome } from '../../../src/agents/runtime.js';

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Shared by every init in the process: SkyForge runs plugin init several times, and each must not post again. */
const STATE = Symbol.for('livemap.skyforge-plugin.v1');
/** Bounded memory: past this many entries the oldest are forgotten. */
const MAX_KEEP = 2000;
/** Messages whose finished text waits for its role; a message never given a role is forgotten past this. */
const MAX_HELD = 200;
/** Idle events of one session closer together than this are one idle. */
const IDLE_WINDOW_MS = 2000;

interface Call { name: string; args: unknown; start: number }
interface PluginState {
  poster: { send(e: unknown): void };
  calls: Map<string, Call>;
  done: Set<string>;
  contexts: Map<string, SessionContext>;
  roles: Map<string, string>;
  posted: Set<string>;
  /** Finished text parts whose message role has not arrived yet, by message id. */
  held: Map<string, Obj[]>;
  /** When each session last went idle, to send one idle per burst. */
  idleAt: Map<string, number>;
  inits: number;
}

function bounded<K>(m: Map<K, unknown> | Set<K>): void {
  while (m.size > MAX_KEEP) {
    const first = m.keys().next().value as K;
    m.delete(first);
  }
}

function state(): PluginState {
  const g = globalThis as unknown as Record<symbol, PluginState | undefined>;
  g[STATE] ??= { poster: new HookPoster(), calls: new Map(), done: new Set(), contexts: new Map(), roles: new Map(), posted: new Set(), held: new Map(), idleAt: new Map(), inits: 0 };
  return g[STATE] as PluginState;
}

/** Debug lines (tool names and arg names, never values) go to a file, never to SkyForge's screen. */
function debug(line: string): void {
  if (!process.env.LIVEMAP_PLUGIN_DEBUG) return;
  try {
    const dir = path.join(livemapHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFile(path.join(dir, 'skyforge-plugin.log'), `${new Date().toISOString()} ${line}\n`, () => {});
  } catch { /* debug only */ }
}

/** SkyForge's nexus tools arrive as `nexus_ses_<id>_<tool>`; other tools (bash, edit, read) are not ServiceNow work. */
const isNexusTool = (name: string): boolean => toolServer(name) === 'nexus' || /^(sn_|tool_execute$)/.test(baseToolName(name));

const send = (s: PluginState, e: CaptureEvent | TextEvent | undefined) => { if (e) s.poster.send(e); };
/** Sends a finished assistant text part once (its part id is the text id). */
function sendPart(s: PluginState, part: Obj, sessionId?: string): void {
  const id = str(part.id);
  const end = rec(part.time).end;
  if (!id || typeof end !== 'number' || s.posted.has(id)) return;
  s.posted.add(id);
  bounded(s.posted);
  send(s, buildText('message', str(part.sessionID) ?? sessionId ?? '', end, str(part.text), id));
}

const contextOf = (s: PluginState, sessionId: string) => {
  let c = s.contexts.get(sessionId);
  if (!c) { c = new SessionContext(); s.contexts.set(sessionId, c); bounded(s.contexts); }
  return c;
};

/** The only export: OpenCode runs every exported function as a plugin. */
export const LivemapSkyforge = async () => {
  const s = state();
  s.inits++;
  return {
    'tool.execute.before': async (input: { tool?: string; sessionID?: string; callID?: string }, output: { args?: unknown }) => {
      try {
        const name = str(input?.tool);
        if (!name || !isNexusTool(name) || !input.sessionID || !input.callID) return;
        const key = `${input.sessionID}\u0000${input.callID}`;
        if (s.calls.has(key) || s.done.has(key)) return;
        s.calls.set(key, { name, args: output?.args ?? {}, start: Date.now() });
        bounded(s.calls);
        debug(`call ${baseToolName(name)} args: ${argNames(output?.args).join(', ')}`);
      } catch { /* never into SkyForge */ }
    },
    'tool.execute.after': async (input: { tool?: string; sessionID?: string; callID?: string; args?: unknown }, output: { title?: string; output?: unknown; metadata?: unknown }) => {
      try {
        const name = str(input?.tool);
        if (!name || !isNexusTool(name) || !input.sessionID || !input.callID) return;
        const key = `${input.sessionID}\u0000${input.callID}`;
        if (s.done.has(key)) return;
        s.done.add(key);
        bounded(s.done);
        const call = s.calls.get(key);
        s.calls.delete(key);
        const end = Date.now();
        const args = call?.args ?? input.args ?? {};
        const text = typeof output?.output === 'string' ? output.output : JSON.stringify(output?.output ?? '');
        const skipResult = text.length > MAX_PARSED_RESULT || !needsResult(name, args);
        const ev = buildCapture({
          source: 'skyforge-plugin', client: { name: 'skyforge' }, sessionId: input.sessionID, callId: input.callID,
          name, args, result: { content: [{ type: 'text', text }] }, skipResult, start: call?.start ?? end, end,
        }, contextOf(s, input.sessionID));
        debug(`done ${ev.innerTool ?? ev.tool} ok=${ev.ok}`);
        send(s, ev);
      } catch { /* never into SkyForge */ }
    },
    'chat.message': async (input: { sessionID?: string }, output: { message?: unknown; parts?: unknown[] }) => {
      try {
        const msg = rec(output?.message);
        const id = str(msg.id);
        const sessionId = str(input?.sessionID) ?? str(msg.sessionID);
        if (!sessionId) return;
        const created = typeof rec(msg.time).created === 'number' ? (rec(msg.time).created as number) : undefined;
        // The message id, or else the session and creation time: either way one prompt is sent once.
        const textId = id ?? (created !== undefined ? `${sessionId}:${created}` : undefined);
        if (textId && s.posted.has(textId)) return;
        if (textId) { s.posted.add(textId); bounded(s.posted); }
        if (id) { s.roles.set(id, 'user'); bounded(s.roles); s.held.delete(id); }
        const text = (output?.parts ?? []).map(rec).filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => str(p.text) ?? '').join('\n');
        send(s, buildText('prompt', sessionId, created ?? Date.now(), text, textId));
      } catch { /* never into SkyForge */ }
    },
    event: async (input: { event?: unknown }) => {
      try {
        const e = rec(input?.event);
        const props = rec(e.properties);
        if (e.type === 'message.updated') {
          const info = rec(props.info);
          const id = str(info.id);
          const role = str(info.role);
          if (!id || !role) return;
          s.roles.set(id, role);
          bounded(s.roles);
          // Text that finished before its message said whose it was: send it now, or drop a user's.
          const waiting = s.held.get(id);
          s.held.delete(id);
          if (waiting && role === 'assistant') for (const part of waiting) sendPart(s, part, str(props.sessionID));
        } else if (e.type === 'message.part.updated') {
          const part = rec(props.part);
          const id = str(part.id);
          const messageId = str(part.messageID);
          if (part.type !== 'text' || typeof rec(part.time).end !== 'number' || !id || !messageId || s.posted.has(id) || part.synthetic) return;
          const role = s.roles.get(messageId);
          if (role === 'assistant') sendPart(s, part, str(props.sessionID));
          else if (role === undefined) {
            const list = s.held.get(messageId) ?? [];
            if (!list.some((p) => p.id === id)) list.push({ ...part, ...(str(props.sessionID) && !str(part.sessionID) ? { sessionID: props.sessionID } : {}) });
            s.held.set(messageId, list);
            while (s.held.size > MAX_HELD) s.held.delete(s.held.keys().next().value as string);
          }
        } else if (e.type === 'session.idle') {
          const sessionId = str(props.sessionID);
          if (!sessionId) return;
          const now = Date.now();
          const last = s.idleAt.get(sessionId);
          if (last !== undefined && now - last < IDLE_WINDOW_MS) return;
          s.idleAt.set(sessionId, now);
          bounded(s.idleAt);
          send(s, buildText('idle', sessionId, now));
        }
      } catch { /* never into SkyForge */ }
    },
  };
};
