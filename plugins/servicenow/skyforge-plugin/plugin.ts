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

interface Call { name: string; args: unknown; start: number }
interface PluginState {
  poster: { send(e: unknown): void };
  calls: Map<string, Call>;
  done: Set<string>;
  contexts: Map<string, SessionContext>;
  roles: Map<string, string>;
  posted: Set<string>;
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
  g[STATE] ??= { poster: new HookPoster(), calls: new Map(), done: new Set(), contexts: new Map(), roles: new Map(), posted: new Set(), inits: 0 };
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
        if (!sessionId || (id && s.posted.has(id))) return;
        if (id) { s.posted.add(id); bounded(s.posted); s.roles.set(id, 'user'); bounded(s.roles); }
        const text = (output?.parts ?? []).map(rec).filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => str(p.text) ?? '').join('\n');
        const at = typeof rec(msg.time).created === 'number' ? (rec(msg.time).created as number) : Date.now();
        send(s, buildText('prompt', sessionId, at, text));
      } catch { /* never into SkyForge */ }
    },
    event: async (input: { event?: unknown }) => {
      try {
        const e = rec(input?.event);
        const props = rec(e.properties);
        if (e.type === 'message.updated') {
          const info = rec(props.info);
          if (str(info.id) && str(info.role)) { s.roles.set(info.id as string, info.role as string); bounded(s.roles); }
        } else if (e.type === 'message.part.updated') {
          const part = rec(props.part);
          const end = rec(part.time).end;
          const id = str(part.id);
          if (part.type !== 'text' || typeof end !== 'number' || !id || s.posted.has(id) || part.synthetic) return;
          if (s.roles.get(str(part.messageID) ?? '') !== 'assistant') return;
          s.posted.add(id);
          bounded(s.posted);
          send(s, buildText('message', str(part.sessionID) ?? str(props.sessionID) ?? '', end, str(part.text)));
        } else if (e.type === 'session.idle') {
          const sessionId = str(props.sessionID);
          if (sessionId) send(s, buildText('idle', sessionId, Date.now()));
        }
      } catch { /* never into SkyForge */ }
    },
  };
};
