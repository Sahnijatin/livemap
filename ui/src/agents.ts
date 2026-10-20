import type { AgentEvent, AgentKind, AgentSession, ChangeSummary } from '@shared/types.js';
import { baseName } from './recent';

export interface AgentMeta { letter: string; name: string }

/** Avatar letter and display name per agent; colors live in styles.css (`.av-<agent>`). */
export const AGENTS: Record<AgentKind, AgentMeta> = {
  'claude-code': { letter: 'C', name: 'Claude Code' },
  codex: { letter: 'X', name: 'Codex' },
  cursor: { letter: 'U', name: 'Cursor' },
  git: { letter: 'G', name: 'Git' },
  'mcp-client': { letter: 'M', name: 'MCP client' },
  skyforge: { letter: 'S', name: 'SkyForge' },
  other: { letter: 'A', name: 'Agent' },
};

export const agentName = (a: AgentKind | undefined): string => (a ? AGENTS[a]?.name ?? 'Agent' : 'Agent');

/** Sessions shown as agent chips: active in the last 30 minutes. */
export const CHIP_WINDOW_MS = 30 * 60_000;

/** Coding-agent sessions only: git authors are not agents you can watch or pause. */
const isAgent = (s: AgentSession) => s.agent !== 'git';

/** The most recent working session, else the most recent by last activity. */
export function activeSession(sessions: Record<string, AgentSession>): AgentSession | undefined {
  let working: AgentSession | undefined;
  let latest: AgentSession | undefined;
  for (const s of Object.values(sessions)) {
    if (!isAgent(s)) continue;
    if (s.status === 'working' && (!working || s.lastAt > working.lastAt)) working = s;
    if (!latest || s.lastAt > latest.lastAt) latest = s;
  }
  return working ?? latest;
}

/** Agent sessions active within the chip window, working first, then newest. */
export function chipSessions(sessions: Record<string, AgentSession>, now: number): AgentSession[] {
  return Object.values(sessions)
    .filter(s => isAgent(s) && now - s.lastAt <= CHIP_WINDOW_MS)
    .sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === 'working' ? -1 : 1));
}

/** A merge commit: as the git watcher flagged it, or (recorded before the flag) known by git's default message. */
export const isMerge = (e: AgentEvent): boolean =>
  e.merge ?? /^Merge (pull request|branch|remote-tracking branch|tag|commit) /.test(e.text ?? '');

/** A commit's first line. */
export const commitSubject = (e: AgentEvent): string => (e.text ?? '').split('\n')[0];

export type StepKind = 'tool' | 'write' | 'message' | 'prompt' | 'thinking' | 'idle' | 'none';
export interface Step { kind: StepKind; line: string }

/** First meaningful line of a message, without markdown markers, for one-line display. */
export function headline(text: string, max = 140): string {
  const line = text.split('\n').map(l => l.replace(/^[\s#>*-]+/, '').replace(/[*_`]+/g, '').trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

const SCAN = 400;

/** The latest message text of a session, if any (scans the newest events only). */
export function latestMessage(events: AgentEvent[], sessionId: string | undefined): AgentEvent | undefined {
  if (!sessionId) return undefined;
  for (let i = events.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const e = events[i];
    if (e.sessionId === sessionId && e.type === 'message' && e.text) return e;
  }
  return undefined;
}

/**
 * What the session is doing: the running tool's label, "Writing <file>" right after a change,
 * otherwise the latest message (or a short phrase for a prompt or thinking).
 */
export function currentStep(session: AgentSession | undefined, events: AgentEvent[], changes: ChangeSummary[]): Step {
  if (!session) return { kind: 'none', line: 'Waiting for an agent' };
  let latest: AgentEvent | undefined;
  for (let i = events.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const e = events[i];
    if (e.sessionId !== session.id || e.type === 'status' || e.subagent) continue;
    latest = e;
    break;
  }
  let change: ChangeSummary | undefined;
  for (let i = changes.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    if (changes[i].attribution?.sessionId === session.id) { change = changes[i]; break; }
  }
  const msg = latestMessage(events, session.id);
  const working = session.status === 'working';
  if (!working) return { kind: 'idle', line: msg?.text ? headline(msg.text) : 'Waiting for the next prompt' };
  const running = runningTool(events, session.id);
  if (running?.tool && (!change || change.at <= running.at)) {
    return { kind: 'tool', line: running.tool.label || running.tool.name };
  }
  if (change && (!latest || change.at >= latest.at)) {
    return { kind: 'write', line: `${change.kind === 'deleted' ? 'Deleting' : 'Writing'} ${baseName(change.path)}` };
  }
  if (latest?.type === 'prompt') return { kind: 'prompt', line: 'Reading your request' };
  if (latest?.type === 'thinking') return { kind: 'thinking', line: 'Thinking' };
  if (latest?.type === 'message' && latest.text) return { kind: 'message', line: headline(latest.text) };
  if (msg?.text) return { kind: 'message', line: headline(msg.text) };
  if (latest?.tool) return { kind: 'tool', line: latest.tool.label || latest.tool.name };
  return { kind: 'prompt', line: 'Getting started' };
}

/** The newest tool_start of this turn with no tool_end yet (a message may follow it while it runs). */
function runningTool(events: AgentEvent[], sessionId: string): AgentEvent | undefined {
  const ended = new Set<string>();
  let newest = true;
  for (let i = events.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const e = events[i];
    if (e.sessionId !== sessionId || e.subagent || e.type === 'status') continue;
    if (e.type === 'prompt') return undefined;
    if (e.type === 'tool_end') { if (e.tool?.id) ended.add(e.tool.id); }
    else if (e.type === 'tool_start') {
      // Without an id a start can only be paired by position: it runs while nothing followed it.
      if (e.tool?.id ? !ended.has(e.tool.id) : newest) return e;
    }
    newest = false;
  }
  return undefined;
}

export interface Counters { files: number; functions: number; routes: number; tables: number }

/** New files, functions, routes and tables from change facts since `since`. */
export function counters(changes: ChangeSummary[], since: number): Counters {
  const files = new Set<string>();
  let functions = 0;
  let routes = 0;
  let tables = 0;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.at < since) break;
    if (c.kind === 'created') files.add(c.path);
    for (const s of c.symbols.added) if (s.kind === 'function' || s.kind === 'method') functions++;
    routes += c.routes.added.length;
    tables += c.entities.added.length;
  }
  return { files: files.size, functions, routes, tables };
}

/** Counters for the active session's span, or for everything since load when there is none. */
export function sessionCounters(session: AgentSession | undefined, changes: ChangeSummary[]): Counters {
  return counters(changes, session ? session.startedAt : 0);
}

/** "just now", "12 s ago", "3 min ago", "2 h ago", "4 d ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
