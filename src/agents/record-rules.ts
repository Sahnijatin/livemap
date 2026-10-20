/**
 * Matching rules for record changes (a ServiceNow mirror file), after the record-key rule found no call that
 * named the record. Each rule works from hub events alone, so captures from the proxy, the plugin and a
 * backfill all count the same way. Strongest first:
 *
 * 2. Update set: the change's update set is the one a session made current, inside that session's span.
 * 3. Run window: the change landed while a background script of a session ran, by that session's user.
 * 4. Log: a caller-supplied matcher (tool log lines); see AttributorOptions.logMatch.
 * 5. Time only: one write-capable call around the change is `likely`, more are `ambiguous`.
 */
import type { AgentEvent, Attribution, AttributionCandidate } from '../shared/types.js';

/** What a record change says about itself. Times are epoch ms; `updateSet` is the update set's sys_id or name. */
export interface RecordFacts {
  instance?: string; table: string; sysId?: string; name?: string;
  /** `sys_updated_on` of the change; the change's detection time is used when it is missing. */
  updatedOn?: number;
  /** `sys_updated_by`: the instance user that wrote it. */
  updatedBy?: string;
  /** The `sys_update_xml.update_set` of the change: a sys_id, a name, or both. */
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

/** One tool call, its start and end paired from hub events. `end` is Infinity while it still runs. */
export interface Call {
  sessionId: string; agent: AgentEvent['agent']; toolId: string; start: number; end: number;
  real: string; write: boolean; startEvent: AgentEvent; endEvent?: AgentEvent;
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
      c = { sessionId: e.sessionId, agent: e.agent, toolId: id, start: e.at, end: e.type === 'tool_end' ? e.at : Infinity, real: realName(e), write: isWrite(e), startEvent: e };
      byKey.set(key, c);
      out.push(c);
    } else if (e.type === 'tool_end') {
      c.end = Math.max(e.at, c.start);
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
const userFits = (sessionUser: string | undefined, f: RecordFacts) => !sessionUser || !f.updatedBy || sessionUser === f.updatedBy;

function decide(rule: string, hits: { call: Call; reason: string }[]): Attribution | undefined {
  if (!hits.length) return undefined;
  const bySession = new Map<string, { call: Call; reason: string }>();
  for (const h of hits) {
    const prev = bySession.get(h.call.sessionId);
    if (!prev || h.call.start >= prev.call.start) bySession.set(h.call.sessionId, h);
  }
  const pick = [...bySession.values()].sort((a, b) => b.call.start - a.call.start)[0];
  const ev = pick.call.endEvent ?? pick.call.startEvent;
  const base: Attribution = { agent: pick.call.agent, sessionId: pick.call.sessionId, eventId: ev.id, confidence: 'likely', rule, reason: pick.reason };
  if (bySession.size === 1) return base;
  const candidates: AttributionCandidate[] = [...bySession.values()].map((h) => ({ agent: h.call.agent, sessionId: h.call.sessionId, eventId: (h.call.endEvent ?? h.call.startEvent).id }));
  return { ...base, confidence: 'ambiguous', candidates, reason: `${bySession.size} sessions fit: ${pick.reason}` };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** Rule 2. Sessions whose current update set (as of the change) is the change's, with the change inside the session's span. */
export function byUpdateSet(events: AgentEvent[], f: RecordFacts, t: number, w: RuleWindows): Attribution | undefined {
  if (!f.updateSet && !f.updateSetName) return undefined;
  const fits = (u: { sysId?: string; name?: string }) =>
    (!!u.sysId && (u.sysId === f.updateSet)) || (!!u.name && (u.name === f.updateSetName || u.name === f.updateSet));
  const sessions = new Map<string, { current?: { sysId?: string; name?: string }; since?: number; last: number; ev?: AgentEvent; agent: AgentEvent['agent'] }>();
  for (const e of events) {
    if (e.agent === 'git' || e.at > t + w.skewMs) continue;
    const s = sessions.get(e.sessionId) ?? { last: e.at, agent: e.agent };
    s.last = Math.max(s.last, e.at);
    const u = e.tool?.sn?.updateSet;
    if (u && (u.sysId || u.name)) {
      const same = s.current && s.current.sysId === u.sysId && s.current.name === u.name;
      if (!same) { s.current = u; s.since = e.at; }
      s.ev = e;
    }
    sessions.set(e.sessionId, s);
  }
  // A session's last event may come after the change: its span runs on to its latest event, whenever that was.
  for (const e of events) { const s = sessions.get(e.sessionId); if (s && e.at > s.last) s.last = e.at; }
  const hits: { call: Call; reason: string }[] = [];
  for (const [sessionId, s] of sessions) {
    if (!s.current || !s.ev || s.since === undefined || !fits(s.current)) continue;
    if (t < s.since - w.skewMs || t > s.last + w.spanTailMs) continue;
    const ev = s.ev;
    const call: Call = { sessionId, agent: s.agent, toolId: ev.tool?.id ?? `@${ev.id}`, start: s.since, end: s.last, real: realName(ev), write: true, startEvent: ev };
    hits.push({ call, reason: `Update set ${s.current.name ?? s.current.sysId} is current in this session since ${fmt(s.since)}` });
  }
  return decide('update_set', hits);
}

/** Rule 3. Background scripts running when the change landed (plus the tail and skew), by the session's user. */
export function byRunWindow(calls: Call[], f: RecordFacts, t: number, w: RuleWindows, userOf: UserOf): Attribution | undefined {
  const hits: { call: Call; reason: string }[] = [];
  for (const c of calls) {
    if (!RUN_WINDOW_TOOLS.has(c.real) || !sameInstance(c.instance, f.instance)) continue;
    if (t < c.start - w.skewMs || t > c.end + w.runTailMs + w.skewMs) continue;
    const user = userOf(c.sessionId) ?? c.user;
    if (!userFits(user, f)) continue;
    const who = user ? `by ${user}` : 'session user unknown';
    const end = Number.isFinite(c.end) ? fmt(c.end) : 'still running';
    hits.push({ call: c, reason: `Changed while ${c.real} ran (${fmt(c.start)} to ${end}), ${who}` });
  }
  return decide('run_window', hits);
}

/** Rule 5. Write-capable calls that ran in the window before the change. One is `likely`; more are `ambiguous`. Never `exact`. */
export function byTime(calls: Call[], f: RecordFacts, t: number, w: RuleWindows, userOf: UserOf): Attribution | undefined {
  const lo = t - w.likelyMs - w.skewMs;
  const hi = t + w.skewMs;
  const hits = calls.filter((c) => c.write && c.start <= hi && c.end >= lo && sameInstance(c.instance, f.instance) && userFits(userOf(c.sessionId) ?? c.user, f));
  if (!hits.length) return undefined;
  const reason = (c: Call) => `${c.real} ran ${fmt(c.start)}, near the change at ${fmt(t)}`;
  if (hits.length === 1) return decide('time', [{ call: hits[0], reason: reason(hits[0]) }]);
  const latest = hits.reduce((a, b) => (b.start >= a.start ? b : a));
  const sessions = new Map<string, Call>();
  for (const c of hits) if (!sessions.has(c.sessionId) || c.start >= (sessions.get(c.sessionId) as Call).start) sessions.set(c.sessionId, c);
  const candidates: AttributionCandidate[] = [...sessions.values()].map((c) => ({ agent: c.agent, sessionId: c.sessionId, eventId: (c.endEvent ?? c.startEvent).id }));
  const ev = latest.endEvent ?? latest.startEvent;
  return { agent: latest.agent, sessionId: latest.sessionId, eventId: ev.id, confidence: 'ambiguous', rule: 'time', candidates, reason: `${hits.length} write calls ran near the change at ${fmt(t)}` };
}
