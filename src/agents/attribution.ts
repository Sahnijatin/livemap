import { EventEmitter } from 'node:events';
import type { AgentEvent, Attribution, ChangeSummary } from '../shared/types.js';
import type { AgentHub } from './hub.js';
import { classifyTool, sameRecord } from '../shared/tools.js';

const MAX_INTENT = 500;
const MAX_PENDING = 200;

/** The record a changed path holds (a ServiceNow mirror file), for matching tool calls that name records. */
export type RecordKey = { instance?: string; table: string; sysId?: string; name?: string };
export interface AttributorOptions {
  exactBeforeMs?: number; exactAfterMs?: number; likelyMs?: number;
  /** Maps a changed path to the record it mirrors; undefined for ordinary files. */
  recordOf?: (path: string) => RecordKey | undefined;
}
interface Pending { id: number; path: string; at: number }

const cap = (s: string) => (s.length > MAX_INTENT ? s.slice(0, MAX_INTENT) : s);

/** When the event happened for matching: a commit counts from when LiveMap saw it, not its commit time. */
const timeOf = (e: AgentEvent): number => (e.type === 'commit' ? e.seenAt ?? e.at : e.at);
const subject = (text: string | undefined): string | undefined => text?.split('\n')[0].trim() || undefined;

/**
 * A tool_start or tool_end of a tool that writes: a write-family built-in or an MCP tool the classifier
 * marks as a write. Reads, searches and fetches never qualify. Events stored before classification
 * existed fall back to the tool name.
 */
function isWriteTool(e: AgentEvent): boolean {
  if ((e.type !== 'tool_start' && e.type !== 'tool_end') || !e.tool) return false;
  return (e.tool.access ?? classifyTool(e.tool.inner ?? e.tool.name).access) === 'write';
}

/**
 * Links file changes to agent actions, and to git commits that list the file (pulls, cloud builders).
 * Tool calls whose PreToolUse LiveMap blocked never count.
 * Emits 'late' (changeId, Attribution) when a write-family tool event arriving after the change upgrades
 * a change that was unattributed or only likely.
 */
export class Attributor extends EventEmitter {
  private readonly before: number;
  private readonly after: number;
  private readonly likelyMs: number;
  private readonly recordOf?: (path: string) => RecordKey | undefined;
  private pending: Pending[] = [];
  private readonly onEvent = (e: AgentEvent) => this.handle(e);

  constructor(private readonly hub: AgentHub, opts: AttributorOptions = {}) {
    super();
    this.before = opts.exactBeforeMs ?? 10_000;
    this.after = opts.exactAfterMs ?? 5000;
    this.likelyMs = opts.likelyMs ?? 15_000;
    this.recordOf = opts.recordOf;
    hub.on('event', this.onEvent);
  }

  /** `now` is unused: times come from change.at and event.at. */
  attribute(change: ChangeSummary, _now: number = Date.now()): Attribution | undefined {
    const all = this.hub.events();
    const exact = this.findExact(all, change);
    let result: Attribution | undefined;
    if (exact) result = this.exactFor(all, exact, change.at);
    else {
      const likely = this.findLikely(all, change.at);
      if (likely) result = { agent: likely.agent, sessionId: likely.sessionId, confidence: 'likely', intent: this.intent(all, likely.sessionId, change.at) };
    }
    if (result && !result.intent) delete result.intent;
    this.pending = this.pending.filter((p) => p.id !== change.id);
    if (result?.confidence !== 'exact') {
      this.pending.push({ id: change.id, path: change.path, at: change.at });
      if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
    return result;
  }

  stop(): void {
    this.hub.off('event', this.onEvent);
    this.pending = [];
  }

  private exactFor(all: AgentEvent[], e: AgentEvent, at: number): Attribution {
    const intent = e.type === 'commit' ? subject(e.text) : this.intent(all, e.sessionId, at);
    return { agent: e.agent, sessionId: e.sessionId, eventId: e.id, confidence: 'exact', ...(intent ? { intent } : {}) };
  }

  private candidate(e: AgentEvent): boolean {
    if (e.type === 'commit') return !!e.paths?.length;
    return isWriteTool(e) && !(e.tool?.id && this.hub.isBlocked(e.sessionId, e.tool.id));
  }

  private matches(e: AgentEvent, path: string, at: number): boolean {
    if (!this.candidate(e)) return false;
    const t = timeOf(e);
    if (t < at - this.before || t > at + this.after) return false;
    const paths = e.type === 'commit' ? e.paths : e.tool?.paths;
    if (paths?.includes(path)) return true;
    const targets = e.tool?.targets;
    if (!targets?.length || !this.recordOf) return false;
    const key = this.recordOf(path);
    return !!key && targets.some((x) => sameRecord(x, key));
  }

  private findExact(all: AgentEvent[], change: ChangeSummary): AgentEvent | undefined {
    let best: AgentEvent | undefined;
    for (const e of all) {
      if (!this.matches(e, change.path, change.at)) continue;
      if (!best || timeOf(e) >= timeOf(best)) best = e;
    }
    return best;
  }

  private findLikely(all: AgentEvent[], at: number): AgentEvent | undefined {
    let best: AgentEvent | undefined;
    for (const e of all) {
      if (e.agent === 'git' || e.at > at || e.at < at - this.likelyMs) continue;
      if (!best || e.at >= best.at) best = e;
    }
    return best;
  }

  private intent(all: AgentEvent[], sessionId: string, at: number): string | undefined {
    const mine = all.filter((e) => e.sessionId === sessionId && e.at <= at && e.text);
    let prompt: AgentEvent | undefined;
    for (const e of mine) if (e.type === 'prompt' && (!prompt || e.at >= prompt.at)) prompt = e;
    let msg: AgentEvent | undefined;
    for (const e of mine) {
      if (e.type !== 'message' || (prompt && e.at < prompt.at)) continue;
      if (!msg || e.at >= msg.at) msg = e;
    }
    if (msg?.text) return cap(msg.text);
    if (prompt?.text) return cap(`Asked: ${prompt.text}`);
    return undefined;
  }

  private handle(e: AgentEvent): void {
    if (!this.pending.length || !this.candidate(e)) return;
    const hit = this.pending.filter((p) => this.matches(e, p.path, p.at));
    if (!hit.length) return;
    const all = this.hub.events();
    for (const p of hit) {
      this.pending = this.pending.filter((x) => x.id !== p.id);
      const a = this.exactFor(all, e, p.at);
      try { this.emit('late', p.id, a); } catch { /* a faulty listener must not break hub ingestion */ }
    }
  }
}
