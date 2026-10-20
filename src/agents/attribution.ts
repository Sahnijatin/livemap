import { EventEmitter } from 'node:events';
import type { AgentEvent, Attribution, ChangeSummary, Confidence } from '../shared/types.js';
import type { AgentHub } from './hub.js';
import { classifyTool, sameRecord } from '../shared/tools.js';
import { byRunWindow, byTime, byUpdateSet, callsOf, type RecordFacts, type RuleWindows } from './record-rules.js';

const MAX_INTENT = 500;
const MAX_PENDING = 200;
/** A call event this far from a pending record change is not taken as new evidence for it. */
const LATE_RECORD_MS = 60 * 60_000;

/**
 * The record a changed path holds (a ServiceNow mirror file), for matching tool calls that name records.
 * The optional facts (`updatedOn`, `updatedBy`, `updateSet`) come from the instance's change rows; the rules
 * after the record-key rule need them.
 */
export type RecordKey = RecordFacts;

/** Strongest first. A later event only replaces an attribution with a stronger one. */
export const CONFIDENCE_ORDER: readonly Confidence[] = ['exact', 'log', 'likely', 'ambiguous'];
const rank = (a: Attribution | undefined): number => (a ? CONFIDENCE_ORDER.indexOf(a.confidence) : CONFIDENCE_ORDER.length);

/** Default clock skew margin between this machine and the instance. */
export const DEFAULT_SKEW_MS = 5000;
const MAX_SKEW_MS = 10 * 60_000;

export interface AttributorOptions {
  exactBeforeMs?: number; exactAfterMs?: number; likelyMs?: number;
  /** Maps a changed path to the record it mirrors; undefined for ordinary files. */
  recordOf?: (path: string) => RecordKey | undefined;
  /** Clock skew margin for record changes (default 5 s); see setSkewMs. */
  skewMs?: number;
  /** Changes this long after a background script ends still belong to it (default 3 s). */
  runTailMs?: number;
  /** A session's update set counts until this long after its last event (default 60 s). */
  spanTailMs?: number;
  /**
   * Rule 4, for record changes no stronger rule matched: tool log lines (SkyForge's MCP log). Return an
   * attribution with confidence `log`, or undefined. Exceptions count as no match.
   */
  logMatch?: (change: ChangeSummary, record: RecordKey) => Attribution | undefined;
}
interface Pending { id: number; path: string; at: number; record?: RecordKey; best: number }

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
  private readonly logMatch?: AttributorOptions['logMatch'];
  private skewMs: number;
  private readonly runTailMs: number;
  private readonly spanTailMs: number;
  /** ServiceNow users learned from exact matches, by session. */
  private readonly users = new Map<string, string>();
  private pending: Pending[] = [];
  private readonly onEvent = (e: AgentEvent) => this.handle(e);

  constructor(private readonly hub: AgentHub, opts: AttributorOptions = {}) {
    super();
    this.before = opts.exactBeforeMs ?? 10_000;
    this.after = opts.exactAfterMs ?? 5000;
    this.likelyMs = opts.likelyMs ?? 15_000;
    this.recordOf = opts.recordOf;
    this.logMatch = opts.logMatch;
    this.skewMs = DEFAULT_SKEW_MS;
    this.setSkewMs(opts.skewMs ?? DEFAULT_SKEW_MS);
    this.runTailMs = opts.runTailMs ?? 3000;
    this.spanTailMs = opts.spanTailMs ?? 60_000;
    hub.on('event', this.onEvent);
  }

  /** The clock skew margin for record changes. The live poller sets it once it has measured the skew. */
  setSkewMs(ms: number): void {
    if (Number.isFinite(ms)) this.skewMs = Math.min(MAX_SKEW_MS, Math.max(0, Math.abs(ms)));
  }

  get skew(): number {
    return this.skewMs;
  }

  /** `now` is unused: times come from change.at and event.at. */
  attribute(change: ChangeSummary, _now: number = Date.now()): Attribution | undefined {
    const all = this.hub.events();
    const record = this.recordOf?.(change.path);
    if (record) return this.track(change, record, this.attributeRecord(all, change, record));
    const exact = this.findExact(all, change);
    let result: Attribution | undefined;
    if (exact) result = this.exactFor(all, exact, change.at);
    else {
      const likely = this.findLikely(all, change.at);
      if (likely) result = { agent: likely.agent, sessionId: likely.sessionId, confidence: 'likely', intent: this.intent(all, likely.sessionId, change.at) };
    }
    if (result && !result.intent) delete result.intent;
    return this.track(change, undefined, result);
  }

  /** Keeps a change that is not exact yet, so a later call event can upgrade it. */
  private track(change: ChangeSummary, record: RecordKey | undefined, result: Attribution | undefined): Attribution | undefined {
    this.pending = this.pending.filter((p) => p.id !== change.id);
    if (result?.confidence !== 'exact') {
      this.pending.push({ id: change.id, path: change.path, at: change.at, best: rank(result), ...(record ? { record } : {}) });
      if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
    return result;
  }

  private windows(): RuleWindows {
    return { skewMs: this.skewMs, runTailMs: this.runTailMs, spanTailMs: this.spanTailMs, likelyMs: this.likelyMs };
  }

  /**
   * A record change, through the rules in order (the first match wins): record key (exact), update set,
   * run window, log, time only. No match means a human or an unknown writer: no attribution.
   */
  private attributeRecord(all: AgentEvent[], change: ChangeSummary, record: RecordKey): Attribution | undefined {
    const t = record.updatedOn ?? change.at;
    const exact = this.findExact(all, change, t, this.skewMs);
    if (exact) {
      if (record.updatedBy) this.users.set(exact.sessionId, record.updatedBy);
      const a = this.exactFor(all, exact, t);
      return { ...a, rule: 'record', reason: `${exact.tool?.label ?? 'The call'} named ${record.table} ${record.sysId ?? record.name ?? ''}`.trim() };
    }
    const w = this.windows();
    const calls = callsOf(all.filter((e) => !(e.tool?.id && this.hub.isBlocked(e.sessionId, e.tool.id))), isWriteTool);
    const userOf = (sid: string) => this.users.get(sid);
    let result = byUpdateSet(all, record, t, w) ?? byRunWindow(calls, record, t, w, userOf);
    if (!result && this.logMatch) {
      try { result = this.logMatch(change, record); } catch { result = undefined; }
    }
    result ??= byTime(calls, record, t, w, userOf);
    if (!result) return undefined;
    const intent = this.intent(all, result.sessionId, t);
    return intent ? { ...result, intent } : result;
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
    // A merge's files come from the commits it brought in, which take the credit.
    if (e.type === 'commit') return !e.merge && !!e.paths?.length;
    return isWriteTool(e) && !(e.tool?.id && this.hub.isBlocked(e.sessionId, e.tool.id));
  }

  /** `slack` widens the window on both sides (clock skew between this machine and an instance). */
  private matches(e: AgentEvent, path: string, at: number, slack = 0): boolean {
    if (!this.candidate(e)) return false;
    const t = timeOf(e);
    if (t < at - this.before - slack || t > at + this.after + slack) return false;
    const paths = e.type === 'commit' ? e.paths : e.tool?.paths;
    if (paths?.includes(path)) return true;
    const targets = e.tool?.targets;
    if (!targets?.length || !this.recordOf) return false;
    const key = this.recordOf(path);
    return !!key && targets.some((x) => sameRecord(x, key));
  }

  private findExact(all: AgentEvent[], change: ChangeSummary, at: number = change.at, slack = 0): AgentEvent | undefined {
    let best: AgentEvent | undefined;
    for (const e of all) {
      if (!this.matches(e, change.path, at, slack)) continue;
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
    const all = this.hub.events();
    // Record changes: any write call may now fit a rule; re-run the ones near it and report only an upgrade.
    const t = timeOf(e);
    for (const p of this.pending.filter((x) => x.record && Math.abs(t - (x.record.updatedOn ?? x.at)) <= LATE_RECORD_MS)) {
      const change = { id: p.id, path: p.path, at: p.at } as ChangeSummary;
      const a = this.attributeRecord(all, change, p.record as RecordKey);
      if (!a || rank(a) >= p.best) continue;
      p.best = rank(a);
      if (a.confidence === 'exact') this.pending = this.pending.filter((x) => x.id !== p.id);
      try { this.emit('late', p.id, a); } catch { /* a faulty listener must not break hub ingestion */ }
    }
    const hit = this.pending.filter((p) => !p.record && this.matches(e, p.path, p.at));
    if (!hit.length) return;
    for (const p of hit) {
      this.pending = this.pending.filter((x) => x.id !== p.id);
      const a = this.exactFor(all, e, p.at);
      try { this.emit('late', p.id, a); } catch { /* a faulty listener must not break hub ingestion */ }
    }
  }
}
