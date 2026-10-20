import type { AgentEvent, AgentKind, ChangeSummary } from '@shared/types.js';
import { isMerge } from './agents';

/** One row of the Activity feed: an agent event (a tool start carries its end) or a file change. */
export type FeedItem =
  | { t: 'event'; key: string; at: number; sid: string | null; agent: AgentKind | null; ev: AgentEvent; end?: AgentEvent }
  | { t: 'change'; key: string; at: number; sid: string | null; agent: AgentKind | null; change: ChangeSummary };

/** Consecutive items from one session, shown under a single turn header. */
export interface FeedGroup { key: string; sid: string | null; agent: AgentKind | null; items: FeedItem[] }

/**
 * Merges events and changes by time. A tool_end joins its tool_start (same session and tool id);
 * an end without a start in the ring stands alone. Status events are not shown.
 */
export function buildFeed(events: AgentEvent[], changes: ChangeSummary[]): FeedItem[] {
  const items: FeedItem[] = [];
  const open = new Map<string, Extract<FeedItem, { t: 'event' }>>();
  for (const ev of events) {
    if (ev.type === 'status') continue;
    if (ev.type === 'tool_end' && ev.tool?.id) {
      const k = `${ev.sessionId}\0${ev.tool.id}`;
      const start = open.get(k);
      if (start) {
        start.end = ev;
        open.delete(k);
        continue;
      }
    }
    const item: Extract<FeedItem, { t: 'event' }> = { t: 'event', key: `e${ev.id}`, at: ev.at, sid: ev.sessionId, agent: ev.agent, ev };
    if (ev.type === 'tool_start' && ev.tool?.id) open.set(`${ev.sessionId}\0${ev.tool.id}`, item);
    items.push(item);
  }
  for (const c of changes) {
    items.push({ t: 'change', key: `c${c.id}`, at: c.at, sid: c.attribution?.sessionId ?? null, agent: c.attribution?.agent ?? null, change: c });
  }
  // Stable: equal times keep their arrival order.
  return items.sort((a, b) => a.at - b.at);
}

export function groupFeed(items: FeedItem[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  let cur: FeedGroup | null = null;
  for (const it of items) {
    // A merge closes the run of commits it brought in, whoever merged it.
    const merge = cur?.agent === 'git' && it.t === 'event' && it.agent === 'git' && isMerge(it.ev);
    if (!cur || (cur.sid !== it.sid && !merge)) {
      cur = { key: `${it.sid ?? '-'}:${it.key}`, sid: it.sid, agent: it.agent, items: [] };
      groups.push(cur);
    }
    if (!cur.agent && it.agent) cur.agent = it.agent;
    cur.items.push(it);
  }
  return groups;
}

/**
 * Gives each group the key it had in the previous build when any of its items was seen before,
 * so a group keeps its identity (and its rows their state) while the event ring evicts its
 * oldest items. `memo` maps item key to group key and is replaced with this build's mapping.
 */
export function stabilizeKeys(groups: FeedGroup[], memo: Map<string, string>): FeedGroup[] {
  const used = new Set<string>();
  const next = new Map<string, string>();
  for (const g of groups) {
    let key: string | undefined;
    for (const it of g.items) {
      key = memo.get(it.key);
      if (key) break;
    }
    if (!key || used.has(key)) {
      key = g.key;
      for (let n = 2; used.has(key); n++) key = `${g.key}#${n}`;
    }
    g.key = key;
    used.add(key);
    for (const it of g.items) next.set(it.key, key);
  }
  memo.clear();
  for (const [k, v] of next) memo.set(k, v);
  return groups;
}

/** The last `limit` items of the feed; the oldest kept group is cut short but keeps its key. */
export function lastItems(groups: FeedGroup[], limit: number): FeedGroup[] {
  const out: FeedGroup[] = [];
  let n = 0;
  for (let i = groups.length - 1; i >= 0 && n < limit; i--) {
    const g = groups[i];
    const room = limit - n;
    if (g.items.length <= room) { out.push(g); n += g.items.length; }
    else { out.push({ ...g, items: g.items.slice(g.items.length - room) }); n = limit; }
  }
  return out.reverse();
}
