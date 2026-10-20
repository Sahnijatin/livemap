import { useEffect, useRef, useState } from 'react';
import { dict } from './dict';

/** How long NEW / EDITED badges stay after a change. */
export const RECENT_MS = 60_000;

export type RecentEntry = { kind: 'created' | 'modified'; at: number };
export type LiveBadge = 'new' | 'edited';

/** Current time, refreshed on an interval so time-based badges expire on their own. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function isRecent(entry: { at: number } | undefined, now: number): boolean {
  return !!entry && now - entry.at < RECENT_MS;
}

/** Badges for the entries still inside the recent window. */
export function liveRecent(recent: Record<string, RecentEntry>, now: number): Record<string, LiveBadge> {
  const out = dict<LiveBadge>();
  for (const [path, r] of Object.entries(recent)) if (isRecent(r, now)) out[path] = r.kind === 'created' ? 'new' : 'edited';
  return out;
}

function sameBadges(a: Record<string, LiveBadge>, b: Record<string, LiveBadge>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => a[k] === b[k]);
}

/**
 * Live badges with a stable identity: the hook wakes only when the next badge expires, and
 * returns the previous object when nothing changed, so consumers do not re-render on a clock.
 */
export function useLiveRecent(recent: Record<string, RecentEntry>): Record<string, LiveBadge> {
  const [tick, setTick] = useState(0);
  const prev = useRef(dict<LiveBadge>());
  const now = Date.now();
  const next = liveRecent(recent, now);
  if (!sameBadges(prev.current, next)) prev.current = next;

  useEffect(() => {
    const t = Date.now();
    let soonest = Infinity;
    for (const r of Object.values(recent)) {
      const expires = r.at + RECENT_MS;
      if (expires > t && expires < soonest) soonest = expires;
    }
    if (soonest === Infinity) return;
    const id = window.setTimeout(() => setTick(n => n + 1), soonest - t + 1);
    return () => window.clearTimeout(id);
  }, [recent, tick]);

  return prev.current;
}

export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
