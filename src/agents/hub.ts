import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentKind, AgentSession, RawAgentEvent } from '../shared/types.js';
import { ClaudeTailer } from './claude.js';
import { lastCodexAssistantText } from './codex.js';
import { normalizeHook } from './normalize.js';
import { Control } from './control.js';
import { findClaudeSessions } from './discovery.js';
import { outputMentionsSecret, touchesSecret } from './labels.js';

const MAX_INPUT_STRING = 4000;
const MAX_TITLE = 80;
const TAIL_BYTES = 65_536;
const SWEEP_MS = 5000;
const MAX_STARTS = 2000;
const DISCOVERY_MS = 3000;
const MAX_TEXT = 65_536;
/** A session's lastAt is re-broadcast at most this often. */
const LAST_AT_MS = 5000;
const TAILER_IDLE_MS = 30 * 60_000;
const MAX_OFFSETS = 1000;
/** Output of the failed tool_end the hub adds after a tool start it blocked. */
export const BLOCKED_OUTPUT = 'Blocked by LiveMap';
/** A started tool with no end and no other session activity for this long no longer keeps the session working. */
export const STALE_TOOL_MS = 10 * 60_000;

const DISPLAY: Record<AgentKind, string> = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', git: 'Git', other: 'Agent' };

export interface AgentHubOptions {
  idleMs?: number;
  ring?: number;
  tailerFactory?: (file: string, opts?: { startOffset?: number }) => ClaudeTailer;
  readTail?: (file: string) => Promise<string>;
  discoveryMs?: number;
  /** A tailer whose file has not grown for this long is stopped; a later watch resumes at its offset. */
  tailerIdleMs?: number;
}
export interface HookOptions { /** False when the hook can no longer receive an answer: nothing is blocked or delivered. */ canBlock?: boolean }
export interface IngestHints { agent: AgentKind; cwd: string; transcriptPath?: string; hooks: boolean }

interface SessionState {
  session: AgentSession; titled: boolean; lastMessage?: string; firedLastAt: number; dirty: boolean; open: Set<string>;
  /** When the session last went idle (event time): older transcript lines arriving late do not revive it. */
  idleAt?: number;
}
interface StartInfo { name: string; label: string; paths: string[]; secret: boolean }

/**
 * One key per transcript file. A hook may name it before Claude creates it (SessionStart), so a
 * missing file is keyed by its directory's real path, matching the key once it exists.
 */
export function transcriptKey(file: string): string {
  try { return fs.realpathSync(file); } catch { /* not created yet */ }
  try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { return path.resolve(file); }
}

async function readLastBytes(file: string): Promise<string> {
  try {
    const fh = await fs.promises.open(file, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, size - len + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      return buf.subarray(0, got).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
}

function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_INPUT_STRING ? v.slice(0, MAX_INPUT_STRING) : v;
  if (depth > 32 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = capStrings(x, depth + 1);
  return out;
}

const tidyTitle = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();

/**
 * Collects agent activity from hooks and transcript tailers into sessions and a bounded event ring.
 * Emits 'event' (AgentEvent), 'session' (AgentSession) and, when a tailer fails and someone listens, 'error'.
 */
export class AgentHub extends EventEmitter {
  readonly control = new Control();
  private readonly idleMs: number;
  private readonly ringSize: number;
  private readonly tailerFactory: (file: string, opts?: { startOffset?: number }) => ClaudeTailer;
  private readonly readTail: (file: string) => Promise<string>;
  private readonly ring: AgentEvent[] = [];
  private readonly states = new Map<string, SessionState>();
  private readonly starts = new Map<string, StartInfo>();
  private readonly tailers = new Map<string, ClaudeTailer>();
  /** Read offsets of evicted tailers, by real path. */
  private readonly offsets = new Map<string, number>();
  /** Tool calls (session + id) whose PreToolUse was blocked. */
  private readonly blocked = new Set<string>();
  private readonly tailerIdleMs: number;
  private readonly chains = new Map<string, { tail: Promise<void>; count: number }>();
  private nextId = 1;
  private sweep?: NodeJS.Timeout;
  private discovery?: NodeJS.Timeout;
  private readonly discoveryMs: number;

  constructor(private readonly root: string, opts: AgentHubOptions = {}) {
    super();
    this.idleMs = opts.idleMs ?? 60_000;
    this.ringSize = opts.ring ?? 2000;
    this.tailerFactory = opts.tailerFactory ?? ((file, o) => new ClaudeTailer(file, root, o));
    this.tailerIdleMs = opts.tailerIdleMs ?? TAILER_IDLE_MS;
    this.readTail = opts.readTail ?? readLastBytes;
    this.discoveryMs = opts.discoveryMs ?? DISCOVERY_MS;
    this.sweep = setInterval(() => { this.sweepIdle(Date.now()); this.evictTailers(Date.now()); }, SWEEP_MS);
    this.sweep.unref?.();
  }

  /** Resolves once every hook-triggered emission that waited on an async tail read has been emitted. */
  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()].map((c) => c.tail));
  }

  /** Whether the PreToolUse of this tool call was blocked. */
  isBlocked(sessionId: string, toolId: string): boolean {
    return this.blocked.has(`${sessionId}\u0000${toolId}`);
  }

  /** `flags` lists the flags whose block this answer carries (so the caller can undeliver them). */
  ingestHook(
    agent: 'claude-code' | 'codex' | 'cursor', event: string, payload: unknown, now: number = Date.now(), opts: HookOptions = {},
  ): { block: string | null; flags?: number[] } {
    let n: ReturnType<typeof normalizeHook>;
    try {
      n = normalizeHook({ agent, event, payload, root: this.root, now });
    } catch {
      return { block: null };
    }
    const sid = n.sessionId || `${agent}:unknown`;
    let decision: { block: string; flags?: number[] } | null = null;
    try {
      decision = n.blockable && opts.canBlock !== false ? this.control.check(agent, sid, now) : null;
    } catch { /* the decision below must not depend on emission */ }
    const block = decision?.block ?? null;
    try {
      if (block !== null) this.blockTools(agent, sid, n, now);
      const st = this.upsert(sid, agent, { cwd: n.cwd, transcriptPath: n.transcriptPath, hooks: true }, now);
      this.touch(st, now);
      if (n.prompt) this.setTitle(st, n.prompt);
      if (agent === 'claude-code' && n.transcriptPath) this.watchClaudeTranscript(n.transcriptPath);
      const needTail = agent === 'codex' && event === 'PreToolUse' && !!n.transcriptPath;
      const emit = (message?: string) => {
        const safe = (e: RawAgentEvent) => { try { this.record(e); } catch { /* keep recording the rest */ } };
        if (message !== undefined) safe({ agent, sessionId: sid, at: now, type: 'message', text: message });
        for (const e of n.events) safe(e);
      };
      if (!needTail && !this.chains.get(sid)) emit();
      else {
        this.enqueue(sid, async () => {
          let message: string | undefined;
          if (needTail) {
            const text = lastCodexAssistantText(await this.readTail(n.transcriptPath as string));
            if (text && text !== this.states.get(sid)?.lastMessage) message = text;
          }
          emit(message);
        });
      }
    } catch { /* bookkeeping failure never changes the control decision */ }
    return decision?.flags ? { block, flags: decision.flags } : { block };
  }

  /**
   * Marks the hook's tool call blocked. Codex and Cursor never report a blocked call, so each tool_start
   * gets a failed tool_end right after it; Claude Code writes its own error result to the transcript.
   */
  private blockTools(agent: AgentKind, sid: string, n: ReturnType<typeof normalizeHook>, now: number): void {
    if (n.toolId) this.markBlocked(sid, n.toolId);
    if (agent === 'claude-code') return;
    const out: RawAgentEvent[] = [];
    n.events.forEach((e, i) => {
      out.push(e);
      if (e.type !== 'tool_start' || !e.tool) return;
      if (!e.tool.id) e.tool = { ...e.tool, id: `blocked:${sid}:${now}:${i}` };
      const { id, name, label, paths } = e.tool;
      this.markBlocked(sid, id as string);
      out.push({ agent: e.agent, sessionId: e.sessionId, at: now, type: 'tool_end', tool: { id, name, label, paths, ok: false, output: BLOCKED_OUTPUT } });
    });
    n.events = out;
  }

  private markBlocked(sid: string, id: string): void {
    this.blocked.add(`${sid}\u0000${id}`);
    if (this.blocked.size > MAX_STARTS) this.blocked.delete(this.blocked.values().next().value as string);
  }

  ingestRaw(events: RawAgentEvent[], hints: IngestHints): void {
    for (const e of events) this.record(e, hints);
  }

  watchClaudeTranscript(transcript: string): void {
    const file = transcriptKey(transcript);
    if (this.tailers.has(file)) return;
    const startOffset = this.offsets.get(file);
    this.offsets.delete(file);
    const tailer = startOffset === undefined ? this.tailerFactory(file) : this.tailerFactory(file, { startOffset });
    this.tailers.set(file, tailer);
    tailer.on('events', (evs: RawAgentEvent[]) => {
      try { this.ingestRaw(evs, { agent: 'claude-code', cwd: this.root, transcriptPath: file, hooks: false }); } catch { /* a bad batch must not kill the tailer */ }
    });
    tailer.on('error', (err: unknown) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    try { tailer.start(); } catch (err) { if (this.listenerCount('error') > 0) this.emit('error', err); }
  }

  /** Watches recent Claude Code transcripts for this project, found passively every few seconds. */
  startDiscovery(claudeDir?: string): void {
    if (this.discovery) return;
    const scan = () => {
      let files: string[] = [];
      try { files = findClaudeSessions(this.root, claudeDir); } catch { /* discovery is best effort */ }
      for (const f of files) {
        try { this.watchClaudeTranscript(f); } catch { /* one bad file must not block the rest */ }
      }
    };
    scan();
    this.discovery = setInterval(scan, this.discoveryMs);
    this.discovery.unref?.();
  }

  events(limit?: number): AgentEvent[] {
    return limit === undefined ? this.ring.slice() : this.ring.slice(Math.max(0, this.ring.length - Math.max(0, limit)));
  }

  sessions(): AgentSession[] {
    return [...this.states.values()].map((s) => ({ ...s.session })).sort((a, b) => b.lastAt - a.lastAt);
  }

  recent(sinceMs: number, now: number = Date.now()): AgentEvent[] {
    return this.ring.filter((e) => e.at >= now - sinceMs);
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    if (this.discovery) clearInterval(this.discovery);
    this.discovery = undefined;
    for (const t of this.tailers.values()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  }

  private fire(name: 'session' | 'event', arg: unknown): void {
    for (const l of this.listeners(name)) {
      try { (l as (a: unknown) => void).call(this, arg); } catch { /* a faulty listener must not break ingestion */ }
    }
  }

  private enqueue(sid: string, job: () => Promise<void>): void {
    const c = this.chains.get(sid) ?? { tail: Promise.resolve(), count: 0 };
    c.count++;
    c.tail = c.tail.then(job).catch(() => undefined).then(() => {
      if (--c.count === 0 && this.chains.get(sid) === c) this.chains.delete(sid);
    });
    this.chains.set(sid, c);
  }

  /** New sessions are broadcast at once; a changed transcriptPath or hooks flag marks the session dirty for touch(). */
  private upsert(sid: string, agent: AgentKind, h: { cwd: string; transcriptPath?: string; hooks: boolean }, at: number): SessionState {
    let st = this.states.get(sid);
    if (!st) {
      st = { titled: false, firedLastAt: at, dirty: false, open: new Set(), session: { id: sid, agent, title: DISPLAY[agent], cwd: h.cwd, startedAt: at, lastAt: at, status: 'working', hooks: false } };
      this.states.set(sid, st);
      if (h.transcriptPath) st.session.transcriptPath = h.transcriptPath;
      if (h.hooks) st.session.hooks = true;
      this.fireSession(st);
      return st;
    }
    if (h.transcriptPath && !st.session.transcriptPath) { st.session.transcriptPath = h.transcriptPath; st.dirty = true; }
    if (h.hooks && !st.session.hooks) { st.session.hooks = true; st.dirty = true; }
    return st;
  }

  private fireSession(st: SessionState): void {
    st.firedLastAt = st.session.lastAt;
    st.dirty = false;
    this.fire('session', { ...st.session });
  }

  /** Advances lastAt; broadcasts when the session is dirty or lastAt moved 5 s past the last broadcast. */
  private touch(st: SessionState, at: number): void {
    if (at > st.session.lastAt) st.session.lastAt = at;
    if (st.dirty || st.session.lastAt - st.firedLastAt >= LAST_AT_MS) this.fireSession(st);
  }

  private setTitle(st: SessionState, text: string): void {
    if (st.titled) return;
    const title = tidyTitle(text);
    if (!title) return;
    st.titled = true;
    st.session.title = title;
    this.fireSession(st);
  }

  private record(input: RawAgentEvent, hints?: IngestHints): void {
    const raw = input.text && input.text.length > MAX_TEXT ? { ...input, text: input.text.slice(0, MAX_TEXT) } : input;
    const agent = raw.agent;
    const sid = raw.sessionId || `${agent}:unknown`;
    const st = this.upsert(sid, agent, hints ?? { cwd: this.root, hooks: false }, raw.at);
    let tool = raw.tool;
    if (tool) {
      tool = { ...tool };
      if (tool.input !== undefined) tool.input = capStrings(tool.input);
      if (tool.id) {
        const key = `${sid}\u0000${tool.id}`;
        if (raw.type === 'tool_start') st.open.add(tool.id);
        else if (raw.type === 'tool_end') st.open.delete(tool.id);
        if (raw.type === 'tool_start') {
          this.starts.set(key, { name: tool.name, label: tool.label, paths: tool.paths, secret: touchesSecret(tool.name, tool.input, tool.paths) });
          if (this.starts.size > MAX_STARTS) this.starts.delete(this.starts.keys().next().value as string);
        } else if (raw.type === 'tool_end') {
          const s = this.starts.get(key);
          if (s) {
            tool.name = s.name || tool.name;
            tool.label = s.label || tool.label;
            if (!tool.paths.length) tool.paths = s.paths;
            if (s.secret) delete tool.output;
          } else if (agent === 'claude-code') delete tool.output;
        }
      } else if (raw.type === 'tool_end' && agent === 'claude-code') delete tool.output;
      // Last line of defense: no stored output may name a secret file (grep, cat, diff results).
      if (raw.type === 'tool_end' && tool.output !== undefined && (touchesSecret(tool.name, tool.input, tool.paths) || outputMentionsSecret(tool.output))) delete tool.output;
    }
    const event: AgentEvent = { ...raw, sessionId: sid, id: this.nextId++, ...(tool ? { tool } : {}) };
    this.ring.push(event);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);

    if (event.type === 'prompt' && event.text) this.setTitle(st, event.text);
    if (event.type === 'message' && event.text) st.lastMessage = event.text;
    let status: AgentSession['status'] = event.type === 'status' && event.status === 'idle' ? 'idle' : 'working';
    if (status === 'idle') {
      st.open.clear();
      st.idleAt = event.at;
    } else if (st.session.status === 'idle' && st.idleAt !== undefined && event.at <= st.idleAt) {
      status = 'idle'; // a transcript line from the turn that already ended, read after its Stop
    }
    if (st.session.status !== status) st.dirty = true;
    st.session.status = status;
    this.touch(st, event.at);
    this.fire('event', event);
  }

  /**
   * Marks quiet sessions idle, except while a tool they started is still running, up to
   * STALE_TOOL_MS: a tool that never reports an end (interrupted, crashed) stops counting then.
   */
  private sweepIdle(now: number): void {
    for (const st of this.states.values()) {
      const quiet = now - st.session.lastAt;
      if (st.session.status === 'working' && quiet >= this.idleMs && (!st.open.size || quiet >= STALE_TOOL_MS)) {
        st.open.clear();
        st.session.status = 'idle';
        this.fireSession(st);
      }
    }
  }

  /** Stops tailers whose file has not grown for tailerIdleMs, keeping their offsets for a later watch. */
  private evictTailers(now: number): void {
    for (const [file, t] of this.tailers) {
      const { lastActiveAt, position } = t as unknown as { lastActiveAt?: number; position?: number };
      if (typeof lastActiveAt !== 'number' || now - lastActiveAt < this.tailerIdleMs) continue;
      try { t.stop(); } catch { /* ignore */ }
      t.removeAllListeners();
      this.tailers.delete(file);
      if (typeof position === 'number') {
        this.offsets.set(file, position);
        if (this.offsets.size > MAX_OFFSETS) this.offsets.delete(this.offsets.keys().next().value as string);
      }
    }
  }
}
