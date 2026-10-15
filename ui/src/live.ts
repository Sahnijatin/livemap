import { useMemo } from 'react';
import type { AgentEvent, AgentSession, AgentTool, ChangeSummary } from '@shared/types.js';
import { classifyTool } from '@shared/tools.js';
import { useStore } from './store';
import { useNow } from './recent';

/** A tool that started this recently still counts as running (matches a stalled-session cutoff). */
export const TOOL_FRESH_MS = 60_000;
/** A change this recent from a working session still marks its file as the current target. */
export const CHANGE_FRESH_MS = 10_000;
const SCAN = 400;

/** A tool call that writes: a write-family built-in, or an MCP tool the shared classifier marks as a write. */
const isWriteTool = (tool: AgentTool): boolean => (tool.access ?? classifyTool(tool.inner ?? tool.name).access) === 'write';

export interface Target { path: string; since: number }

/** The newest unpaired write-family tool_start from a working session, within the freshness window. */
function runningWrite(events: AgentEvent[], sessions: Record<string, AgentSession>, now: number): Target | null {
  const ended = new Set<string>();
  const closed = new Set<string>(); // sessions whose newer events were a prompt: older tools are dead
  const sawNewer = new Set<string>();
  for (let i = events.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const e = events[i];
    // Subagent events carry the parent's sessionId, so their writes count as the session's target.
    if (e.type === 'status') continue;
    if (closed.has(e.sessionId)) continue;
    if (e.type === 'prompt') { if (!e.subagent) closed.add(e.sessionId); continue; }
    if (e.type === 'tool_end') { if (e.tool?.id) ended.add(`${e.sessionId}\0${e.tool.id}`); sawNewer.add(e.sessionId); continue; }
    if (e.type === 'tool_start' && e.tool) {
      const paired = e.tool.id ? ended.has(`${e.sessionId}\0${e.tool.id}`) : sawNewer.has(e.sessionId);
      sawNewer.add(e.sessionId);
      if (paired) continue;
      const s = sessions[e.sessionId];
      if (!s || s.status !== 'working' || now - s.lastAt > TOOL_FRESH_MS) continue;
      if (isWriteTool(e.tool) && e.tool.paths?.length) return { path: e.tool.paths[0], since: e.at };
      continue;
    }
    sawNewer.add(e.sessionId);
  }
  return null;
}

/**
 * The file the agent is working on right now: a running write-family tool's first path, else a
 * very recent change attributed to a working session, else null.
 */
export function currentTarget(
  events: AgentEvent[],
  changes: ChangeSummary[],
  sessions: Record<string, AgentSession>,
  now: number,
): Target | null {
  const running = runningWrite(events, sessions, now);
  if (running) return running;
  for (let i = changes.length - 1, n = 0; i >= 0 && n < SCAN; i--, n++) {
    const c = changes[i];
    if (now - c.at > CHANGE_FRESH_MS) continue;
    const s = c.attribution ? sessions[c.attribution.sessionId] : undefined;
    if (s?.status === 'working' && c.kind !== 'deleted') return { path: c.path, since: c.at };
  }
  return null;
}

/**
 * The live target, re-evaluated on store changes and every 2 s. The store is read through
 * primitive selectors, so a component re-renders only when the target path or its start changes.
 */
export function useCurrentTarget(): Target | null {
  const now = useNow(2000);
  const key = useStore(s => {
    const t = currentTarget(s.events, s.changes, s.sessions, Math.max(now, Date.now()));
    return t ? `${t.since}\0${t.path}` : '';
  });
  return useMemo(() => {
    if (!key) return null;
    const i = key.indexOf('\0');
    return { since: Number(key.slice(0, i)), path: key.slice(i + 1) };
  }, [key]);
}
