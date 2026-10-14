import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { CENTER_TABS, useStore, type CenterTab } from '../store';
import { Activity } from './Activity';
import { StackView } from './StackView';
import { ApiIcon, PulseIcon, SchemaIcon, StackIcon } from './icons';

// Schema (React Flow and ELK) and API load on first open, so Activity's first paint does not pay for them.
const SchemaView = lazy(() => import('./SchemaView'));
const ApiView = lazy(() => import('./ApiView').then(m => ({ default: m.ApiView })));

/** Placeholder cards while a lazy view loads. */
function ViewSkeleton() {
  return (
    <div className="vskel" aria-busy="true" aria-label="Loading">
      <i /><i /><i />
    </div>
  );
}

const META: Record<CenterTab, { label: string; icon: ReactNode }> = {
  activity: { label: 'Activity', icon: <PulseIcon /> },
  schema: { label: 'Schema', icon: <SchemaIcon /> },
  api: { label: 'API', icon: <ApiIcon /> },
  stack: { label: 'Stack', icon: <StackIcon /> },
};

/** A count badge that bumps (scales up in green) for a moment whenever its value grows. */
function Count({ value }: { value: number }) {
  const prev = useRef(value);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    const grew = value > prev.current;
    prev.current = value;
    if (!grew) {
      setBump(false);
      return;
    }
    setBump(true);
    const t = window.setTimeout(() => setBump(false), 700);
    return () => window.clearTimeout(t);
  }, [value]);
  return <b className={clsx('cnt', bump && 'bump')}>{value.toLocaleString()}</b>;
}

/** Center pane: a segmented control (Activity, Schema, API, Stack) over the active view. */
export function CenterTabs() {
  const tab = useStore(s => s.tab);
  const setTab = useStore(s => s.setTab);
  const tables = useStore(s => s.domain.counts.tables);
  const routes = useStore(s => s.domain.counts.routes + s.domain.counts.pages + s.domain.counts.screens);
  const sessions = useStore(s => s.sessions);
  const anyWorking = useMemo(() => Object.values(sessions).some(s => s.agent !== 'git' && s.status === 'working'), [sessions]);

  const list = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLElement>(null);
  const [placed, setPlaced] = useState(false);

  // The knob slides under the selected tab; it follows tab width changes (badges, phone layout).
  useLayoutEffect(() => {
    const el = list.current;
    const k = knob.current;
    if (!el || !k) return;
    const place = () => {
      const b = el.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!b) return;
      k.style.left = `${b.offsetLeft}px`;
      k.style.width = `${b.offsetWidth}px`;
    };
    place();
    // Enable the slide only after the first placement so the knob does not fly in from the left.
    let raf = 0;
    if (!placed) raf = window.requestAnimationFrame(() => setPlaced(true));
    if (typeof ResizeObserver !== 'function') return () => window.cancelAnimationFrame(raf);
    const ro = new ResizeObserver(place);
    for (const b of el.querySelectorAll('[role=tab]')) ro.observe(b);
    return () => { window.cancelAnimationFrame(raf); ro.disconnect(); };
  }, [tab, placed]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = CENTER_TABS.indexOf(tab);
    const n = CENTER_TABS.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = CENTER_TABS[to];
    setTab(next);
    list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  const badge: Partial<Record<CenterTab, number>> = { schema: tables, api: routes };

  return (
    <main className="center" aria-label={META[tab].label}>
      <div className="c-head">
        <div className={clsx('tabs', placed && 'ready')} role="tablist" aria-label="Views" ref={list} onKeyDown={onKeyDown}>
          <i className="knob" ref={knob} aria-hidden="true" />
          {CENTER_TABS.map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              data-tab={t}
              aria-label={badge[t] !== undefined ? `${META[t].label}, ${badge[t]!.toLocaleString()}` : META[t].label}
              aria-selected={t === tab}
              aria-controls="center-panel"
              tabIndex={t === tab ? 0 : -1}
              onClick={() => setTab(t)}
            >
              {META[t].icon}
              <span className="tl">{META[t].label}</span>
              {t === 'activity' && anyWorking && <i className="dotlive" aria-hidden="true" />}
              {badge[t] !== undefined && <Count value={badge[t]!} />}
            </button>
          ))}
        </div>
      </div>
      <div className="c-body" role="tabpanel" id="center-panel" aria-labelledby={`tab-${tab}`}>
        {/* Activity stays mounted so its scroll position and expanded rows survive a tab switch. */}
        <div className="c-view" hidden={tab !== 'activity'}><Activity active={tab === 'activity'} /></div>
        {tab === 'schema' && <div className="c-view swap" key="schema"><Suspense fallback={<ViewSkeleton />}><SchemaView /></Suspense></div>}
        {tab === 'api' && <div className="c-view swap" key="api"><Suspense fallback={<ViewSkeleton />}><ApiView /></Suspense></div>}
        {tab === 'stack' && <div className="c-view swap" key="stack"><StackView /></div>}
      </div>
    </main>
  );
}
