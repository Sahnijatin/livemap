import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AgentSession } from '@shared/types.js';
import { useStore } from '../store';
import { activeSession, agentName, clock, currentStep, sessionCounters, type Counters, type Step } from '../agents';
import { buildFeed, groupFeed, lastItems, stabilizeKeys, type FeedGroup } from '../feed';
import { prefersReducedMotion } from '../scroll';
import { ActivityItem } from './ActivityItem';
import { Avatar } from './Avatar';
import { ArrowDownIcon, PencilIcon, PulseIcon } from './icons';

/** Feed rendering cap; "Show earlier" reveals more in steps of the same size. */
export const FEED_PAGE = 500;
/** Within this many pixels of the bottom, new items keep the feed pinned to the bottom. */
const STICK_PX = 96;

export interface LiveState { session: AgentSession | undefined; step: Step; counts: Counters; working: boolean; paused: boolean }

/** Whether the active session is working, and whether it is paused (pause only reaches agents wired with hooks). */
export const liveFlags = (session: AgentSession | undefined, pausedAll: boolean): Pick<LiveState, 'working' | 'paused'> =>
  ({ working: session?.status === 'working', paused: pausedAll && (!session || !!session.hooks) });

/** The active session, what it is doing now, and its counters. */
export function useLiveState(): LiveState {
  const sessions = useStore(s => s.sessions);
  const events = useStore(s => s.events);
  const changes = useStore(s => s.changes);
  const pausedAll = useStore(s => s.control.paused);
  const session = useMemo(() => activeSession(sessions), [sessions]);
  const step = useMemo(() => currentStep(session, events, changes), [session, events, changes]);
  const counts = useMemo(() => sessionCounters(session, changes), [session, changes]);
  return { session, step, counts, ...liveFlags(session, pausedAll) };
}

/** A number that counts up to its new value (instantly with reduced motion or on first render). */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || prefersReducedMotion() || typeof window.requestAnimationFrame !== 'function') {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let h = 0;
    const run = (now: number) => {
      const p = Math.min(1, (now - t0) / 700);
      setShown(Math.round(start + (value - start) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) h = window.requestAnimationFrame(run);
    };
    h = window.requestAnimationFrame(run);
    return () => window.cancelAnimationFrame(h);
  }, [value]);
  return <>{shown.toLocaleString()}</>;
}

export const COUNTER_LABELS: [keyof Counters, string][] = [['files', 'new files'], ['functions', 'functions'], ['routes', 'routes'], ['tables', 'tables']];

function Hero() {
  const { session, step, counts, working, paused } = useLiveState();
  const label = paused ? 'Paused' : session ? `${agentName(session.agent)} · ${working ? 'now' : 'idle'}` : 'LiveMap · ready';
  return (
    <section className={clsx('hero act-hero', working && !paused && 'working', paused && 'paused')} aria-label="Now">
      <span className="lbl">
        {session ? <Avatar agent={session.agent} className={clsx(working && !paused && 'ring')} /> : <i className="mark" aria-hidden="true" />}
        {label}
        {session && session.title !== agentName(session.agent) && <span className="htitle">{session.title}</span>}
      </span>
      <h3 className={clsx(working && !paused && 'shimmer')}>{step.line}</h3>
      {!session && <p>Start Claude Code, Codex or Cursor in this project and watch every prompt, step and file change here as it happens.</p>}
      {paused && <p>The agent stops at its next action and waits for you. Resume when you are ready.</p>}
      <div className={clsx('prog', working && !paused ? 'indet' : 'rest')}><i /></div>
      <div className="stats">
        {COUNTER_LABELS.map(([k, l]) => <div className="stat" key={k}><b><CountUp value={counts[k]} /></b><span>{l}</span></div>)}
      </div>
    </section>
  );
}

function TurnHeader({ group, session }: { group: FeedGroup; session: AgentSession | undefined }) {
  const at = group.items[0].at;
  if (!group.sid) {
    return (
      <div className="turn-h">
        <span className="av av-none" aria-hidden="true"><PencilIcon /></span>
        <b>Outside an agent</b>
        <span className="tm">{clock(at)}</span>
      </div>
    );
  }
  const name = agentName(group.agent ?? session?.agent);
  const title = group.agent === 'git' ? 'Commits' : session?.title || name;
  return (
    <div className="turn-h">
      <Avatar agent={group.agent ?? session?.agent} />
      <b title={title}>{title}</b>
      <span className="who">{group.agent === 'git' ? group.sid : name}</span>
      <span className="tm">{clock(at)}</span>
    </div>
  );
}

function EmptyFeed() {
  return (
    <div className="feed-empty fi">
      <span className="fe-ic"><PulseIcon /></span>
      <b>Nothing has happened yet</b>
      <p>Prompts, agent steps, file changes and commits show up here as they happen. Run <code>livemap init</code> to connect an agent to this project.</p>
    </div>
  );
}

/** The Activity tab: the "Now" hero, then one feed of agent events and file changes in time order. */
export function Activity({ active = true }: { active?: boolean }) {
  const events = useStore(s => s.events);
  const changes = useStore(s => s.changes);
  const sessions = useStore(s => s.sessions);
  const liveAfterId = useStore(s => s.liveAfterId);

  const items = useMemo(() => buildFeed(events, changes), [events, changes]);
  const [limit, setLimit] = useState(FEED_PAGE);
  const hidden = Math.max(0, items.length - limit);
  // Group the whole feed so group keys stay anchored to each run's own first item, then trim.
  const keyMemo = useRef(new Map<string, string>());
  // Item keys are event ids, which restart at 1 with every LiveMap run: a hello starts the memo over.
  const hellos = useStore(s => s.hellos);
  const memoHellos = useRef(hellos);
  if (memoHellos.current !== hellos) {
    memoHellos.current = hellos;
    keyMemo.current.clear();
  }
  const allGroups = useMemo(() => stabilizeKeys(groupFeed(items), keyMemo.current), [items]);
  const groups = useMemo(() => (hidden ? lastItems(allGroups, limit) : allGroups), [allGroups, hidden, limit]);

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  // The reader's offset, kept while the tab is hidden (a display:none box loses its scrollTop).
  const lastTop = useRef(0);
  const shown = useRef(active);
  shown.current = active;

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !shown.current) return;
    lastTop.current = el.scrollTop;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = near;
    setAway(!near);
  }, []);

  // Coming back to the tab: pinned readers see the latest, others return to where they were.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!active || !el) return;
    if (stick.current) toBottom();
    else el.scrollTop = lastTop.current;
  }, [active, toBottom]);

  // New items keep the feed pinned while the reader is at the bottom.
  const lastKey = items.length ? items[items.length - 1].key : '';
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [lastKey, items.length, toBottom]);

  // Typing and expanding grow the content; follow it while pinned.
  useEffect(() => {
    const el = scroller.current;
    const inner = el?.firstElementChild;
    if (!el || !inner || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [toBottom]);

  const jump = () => {
    stick.current = true;
    setAway(false);
    setLimit(FEED_PAGE);
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <>
      <div className="actv" ref={scroller} onScroll={onScroll}>
        <div className="actwrap">
          <Hero />
          {hidden > 0 && (
            <button type="button" className="more-rows earlier" onClick={() => { stick.current = false; setLimit(l => l + FEED_PAGE); }}>
              Show earlier · {hidden.toLocaleString()} more
            </button>
          )}
          {groups.map(g => {
            const session = g.sid ? sessions[g.sid] : undefined;
            const working = session?.status === 'working';
            return (
              <section className="turn" key={g.key}>
                <TurnHeader group={g} session={session} />
                {g.items.map(it => (
                  <ActivityItem key={it.key} item={it} working={working} live={it.t === 'event' && it.ev.id > liveAfterId} />
                ))}
              </section>
            );
          })}
          {items.length === 0 && <EmptyFeed />}
        </div>
      </div>
      <button type="button" className={clsx('jump', away && 'show')} onClick={jump} tabIndex={away ? 0 : -1} aria-hidden={!away}>
        <ArrowDownIcon />Jump to latest
      </button>
    </>
  );
}
