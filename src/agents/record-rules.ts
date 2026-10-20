/**
 * Matching rules for record changes (a ServiceNow mirror file), after the record-key rule found no call that
 * named the record. Each rule works from hub events alone, so captures from the proxy, the plugin and a
 * backfill all count the same way. Strongest first:
 *
 * 2. Update set: the change's update set is the one a session made current, inside that session's span.
 * 3. Run window: the change landed while a background script of a session ran, by that session's user.
 * 4. Log: a caller-supplied matcher (tool log lines); see AttributorOptions.logMatch.
 * 5. Time only: write calls of one session around the change are `likely`; of several sessions, `ambiguous`.
 *
 * Rules 2 and 3 need the change's facts (`updatedOn`, `updatedBy`, `updateSet`) from the instance's change
 * rows; without them, rule 2 never matches and rule 3 can only say `ambiguous`.
 */
import type { AgentEvent, Attribution, AttributionCandidate } from '../shared/types.js';
import { STALE_TOOL_MS } from './hub.js';

/** What a record change says about itself. Times are epoch ms; `updateSet` is the update set's sys_id or name. */
export interface RecordFacts {
  instance?: string; table: string; sysId?: string; name?: string;
  /** `sys_updated_on` of the change; the change's detection time is used when it is missing. */
  updatedOn?: number;
  /** `sys_updated_by`: the instance user that wrote it. */
  updatedBy?: string;
  /** The `sys_update_xml.update_set` of the change: its sys_id (preferred) or its name. */
  updateSet?: string;
  updateSetName?: string;
}

export interface RuleWindows {
  /** Clock skew margin between this machine and the instance. */
  skewMs: number;
  /** Changes this long after a background script's end still count as its own. */
  runTailMs: number;
  /** A session's update set counts until this long after the session's last event. */
  spanTailMs: number;
  /** Time-only rule: how far before the change a call may have run. */
  likelyMs: number;
}

/** Tools that change records without naming them: everything the session's user changes while they run is theirs. */
export const RUN_WINDOW_TOOLS = new Set(['sn_execute_background_script', 'sn_schedule_script_job']);
/** Every instance has a "Default" update set; many sessions and people share it, so its name proves nothing. */
const DEFAULT_SET = /^default$/i;
const SYS_ID = /^[0-9a-f]{32}$/i;

/**
 * One tool call, its start and end paired from hub events. A call with no end yet runs until its end
 * arrives, for at most STALE_TOOL_MS (a call that never reports an end must not match every later change).
 */
export interface Call {
  sessionId: string; agent: AgentEvent['agent']; toolId: string; start: number; end: number;
  real: string; write: boolean; startEvent: AgentEvent; endEvent?: AgentEvent;
  /** True while no end has arrived. */
  open: boolean;
  instance?: string; user?: string;
}

const realName = (e: AgentEvent): string => e.tool?.inner ?? e.tool?.name ?? '';

/** Pairs tool_start and tool_end events by session and call id; a lone end counts as a call of no length. */
export function callsOf(events: AgentEvent[], isWrite: (e: AgentEvent) => boolean): Call[] {
  const byKey = new Map<string, Call>();
  const out: Call[] = [];
  for (const e of events) {
    if ((e.type !== 'tool_start' && e.type !== 'tool_end') || !e.tool || e.agent === 'git') continue;
    const id = e.tool.id ?? `@${e.id}`;
    const key = `${e.sessionId}\u0000${id}`;
    let c = byKey.get(key);
    if (!c) {
      const open = e.type === 'tool_start';
      c = { sessionId: e.sessionId, agent: e.agent, toolId: id, start: e.at, end: open ? e.at + STALE_TOOL_MS : e.at, open, real: realName(e), write: isWrite(e), startEvent: e };
      byKey.set(key, c);
      out.push(c);
    } else if (e.type === 'tool_end') {
      c.end = Math.max(e.at, c.start);
      c.open = false;
      c.endEvent = e;
      c.write ||= isWrite(e);
    }
    if (e.tool.sn?.instance) c.instance = e.tool.sn.instance;
    if (e.tool.sn?.user) c.user = e.tool.sn.user;
  }
  return out;
}

/** The ServiceNow user a session acts as: one learned from an exact match wins over what its calls said. */
export type UserOf = (sessionId: string) => string | undefined;

const sameInstance = (a?: string, b?: string) => !a || !b || a === b;
/** False only when both users are known and differ. */
const userFits = (sessionUser: string | undefined, f: RecordFacts) => !sessionUser || !f.updatedBy || sessionUser === f.updatedBy;

interface Hit { call: Call; reason: string; uncertain?: string }

/**
 * One attribution from the hits of a rule, grouped by session (the latest call of each). One session gives
 * `likely`; several sessions, or a hit that could not be checked (`uncertain`), give `ambiguous`.
 */
function decide(rule: string, hits: Hit[]): Attribution | undefined {
  if (!hits.length) return undefined;
  const bySession = new Map<string, Hit>();
  for (const h of hits) {
    const prev = bySession.get(h.call.sessionId);
    if (!prev || h.call.start >= prev.call.start) bySession.set(h.call.sessionId, { ...h, uncertain: h.uncertain ?? prev?.uncertain });
  }
  const all = [...bySession.values()].sort((a, b) => b.call.start - a.call.start);
  const pick = all[0];
  const ev = pick.call.endEvent ?? pick.call.startEvent;
  const base: Attribution = { agent: pick.call.agent, sessionId: pick.call.sessionId, eventId: ev.id, confidence: 'likely', rule, reason: pick.reason };
  const uncertain = all.find((h) => h.uncertain)?.uncertain;
  if (all.length === 1 && !uncertain) return base;
  const candidates: AttributionCandidate[] = all.map((h) => ({ agent: h.call.agent, sessionId: h.call.sessionId, eventId: (h.call.endEvent ?? h.call.startEvent).id }));
  const why = all.length > 1 ? `${all.length} sessions fit: ${pick.reason}` : pick.reason;
  return { ...base, confidence: 'ambiguous', candidates, reason: uncertain ? `${why}; ${uncertain}` : why };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);

type SetRef = { sysId?: string; name?: string; unknown?: true };

/** Same update set: by sys_id when both sides have one; else by name, never the shared "Default" set. */
function sameSet(u: SetRef, f: RecordFacts): boolean {
  if (u.unknown) return false;
  const fId = f.updateSet && SYS_ID.test(f.updateSet) ? f.updateSet : undefined;
  if (u.sysId && fId) return u.sysId === fId;
  const fName = f.updateSetName ?? (f.updateSet && !fId ? f.updateSet : undefined);
  return !!u.name && !!fName && !DEFAULT_SET.test(u.name) && u.name === fName;
}

/** Rule 2. Sessions whose current update set (as of the change) is the change's, with the change inside the session's span. */
export function byUpdateSet(events: AgentEvent[], f: RecordFacts, t: number, w: RuleWindows, userOf: UserOf): Attribution | undefined {
  if (!f.updateSet && !f.updateSetName) return undefined;
  interface S { current?: SetRef; since?: number; last: number; ev?: AgentEvent; agent: AgentEvent['agent']; instance?: string; user?: string }
  const sessions = new Map<string, S>();
  for (const e of events) {
    if (e.agent === 'git') continue;
    const s = sessions.get(e.sessionId) ?? { last: e.at, agent: e.agent };
    sessions.set(e.sessionId, s);
    // A session's span runs on to its latest event, whenever that was.
    s.last = Math.max(s.last, e.at);
    if (e.tool?.sn?.instance) s.instance = e.tool.sn.instance;
    if (e.tool?.sn?.user) s.user = e.tool.sn.user;
    if (e.at > t + w.skewMs) continue;
    const u = e.tool?.sn?.updateSet;
    if (u && (u.sysId || u.name || u.unknown)) {
      const same = s.current && s.current.sysId === u.sysId && s.current.name === u.name && !!s.current.unknown === !!u.unknown;
      if (!same) { s.current = u; s.since = e.at; }
      s.ev = e;
    }
  }
  const hits: Hit[] = [];
  for (const [sessionId, s] of sessions) {
    if (!s.current || !s.ev || s.since === undefined || !sameSet(s.current, f)) continue;
    if (!sameInstance(s.instance, f.instance) || !userFits(userOf(sessionId) ?? s.user, f)) continue;
    if (t < s.since - w.skewMs || t > s.last + w.spanTailMs) continue;
    const ev = s.ev;
    const call: Call = { sessionId, agent: s.agent, toolId: ev.tool?.id ?? `@${ev.id}`, start: s.since, end: s.last, open: false, real: realName(ev), write: true, startEvent: ev };
    hits.push({ call, reason: `Update set ${s.current.name ?? s.current.sysId} is current in this session since ${fmt(s.since)}` });
  }
  return decide('update_set', hits);
}

/**
 * Rule 3. Background scripts running when the change landed (plus the tail and skew), by the session's user.
 * When the session's user or the change's user is not known, a human could have made the change: the
 * match is `ambiguous`.
 */
export function byRunWindow(calls: Call[], f: RecordFacts, t: number, w: RuleWindows, userOf: UserOf): Attribution | undefined {
  const hits: Hit[] = [];
  for (const c of calls) {
    if (!RUN_WINDOW_TOOLS.has(c.real) || !sameInstance(c.instance, f.instance)) continue;
    if (t < c.start - w.skewMs || t > c.end + w.runTailMs + w.skewMs) continue;
    const user = userOf(c.sessionId) ?? c.user;
    if (!userFits(user, f)) continue;
    const end = c.open ? 'still running' : fmt(c.end);
    const reason = `Changed while ${c.real} ran (${fmt(c.start)} to ${end})${user && f.updatedBy ? `, by ${user}` : ''}`;
    const uncertain = !user ? 'session user unknown, human edit possible' : !f.updatedBy ? 'change user unknown, human edit possible' : undefined;
    hits.push({ call: c, reason, ...(uncertain ? { uncertain } : {}) });
  }
  return decide('run_window', hits);
}

/** Rule 5. Write calls that ran in the window before the change, grouped by session. Never `exact`. */
export function byTime(calls: Call[], f: RecordFacts, t: number, w: RuleWindows, userOf: UserOf): Attribution | undefined {
  const lo = t - w.likelyMs - w.skewMs;
  const hi = t + w.skewMs;
  const hits = calls.filter((c) => c.write && c.start <= hi && c.end >= lo && sameInstance(c.instance, f.instance) && userFits(userOf(c.sessionId) ?? c.user, f));
  return decide('time', hits.map((c) => ({ call: c, reason: `${c.real} ran ${fmt(c.start)}, near the change at ${fmt(t)}` })));
}
