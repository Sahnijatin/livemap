import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { CENTER_TABS, useStore, type CenterTab } from '../store';
import { codeFileCount } from '../map/mapModel';
import { LEAVING, useLeaving } from '../motion';
import { NARROW_QUERY, useMedia } from '../media';
import { INERT } from '../panels';
import { Activity } from './Activity';
import { StackView } from './StackView';
import { RewoundBanner, Timeline } from './Timeline';
import { ApiIcon, MapIcon, PulseIcon, SchemaIcon, StackIcon } from './icons';

// Map and Schema (React Flow, ELK, framer-motion) and API load on first open, so Activity's first paint does not pay for them.
const MapView = lazy(() => import('../map/MapView'));
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
  map: { label: 'Map', icon: <MapIcon /> },
  schema: { label: 'Schema', icon: <SchemaIcon /> },
  api: { label: 'API', icon: <ApiIcon /> },
  stack: { label: 'Stack', icon: <StackIcon /> },
};

/** Tab switch: cross-fade plus an 8 px slide in the direction of travel. Matches `.c-view.in/.leave` in styles.css. */
const SWITCH_MS = 220;

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

const SWAPPED: CenterTab[] = ['map', 'schema', 'api', 'stack'];

function view(t: CenterTab, tools: HTMLDivElement | null): ReactNode {
  switch (t) {
    case 'map': return <Suspense fallback={<ViewSkeleton />}><MapView tools={tools} /></Suspense>;
    case 'schema': return <Suspense fallback={<ViewSkeleton />}><SchemaView /></Suspense>;
    case 'api': return <Suspense fallback={<ViewSkeleton />}><ApiView /></Suspense>;
    default: return <StackView />;
  }
}

/** Center pane: a segmented control (Activity, Map, Schema, API, Stack) over the active view; the Map adds its tools to the head. */
export function CenterTabs() {
  const tab = useStore(s => s.tab);
  const rewound = useStore(s => s.rewound !== null);
  // Below 1080 px an open slide-over sits over the center behind a scrim: the center is out of reach until it closes.
  const panel = useStore(s => s.panel);
  const narrow = useMedia(NARROW_QUERY);
  const setTab = useStore(s => s.setTab);
  const tables = useStore(s => s.domain.counts.tables);
  const routes = useStore(s => s.domain.counts.routes + s.domain.counts.pages + s.domain.counts.screens);
  const files = useStore(s => s.files);
  const codeFiles = useMemo(() => codeFileCount(files), [files]);
  const sessions = useStore(s => s.sessions);
  // The Map renders its head tools (detail level, options) into this slot.
  const [tools, setTools] = useState<HTMLDivElement | null>(null);
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

  const badge: Partial<Record<CenterTab, number>> = { map: codeFiles, schema: tables, api: routes };

  // The outgoing view stays (inert) while it fades out; the incoming one slides in from the side of travel.
  const { prev, from } = useLeaving(tab, SWITCH_MS);
  const dir = from !== null && CENTER_TABS.indexOf(tab) < CENTER_TABS.indexOf(from) ? -1 : 1;
  const slide = { '--dx': `${dir * 8}px` } as CSSProperties;
  const viewClass = (t: CenterTab) => clsx('c-view', t === prev ? 'leave' : t === tab && from !== null && 'in');

  return (
    <main className={clsx('center', rewound && 'rewound')} aria-label={META[tab].label} {...(narrow && panel ? INERT : {})}>
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
        {tab === 'map' && <div className="c-tools" ref={setTools} />}
      </div>
      <div className="c-body" role="tabpanel" id="center-panel" aria-labelledby={`tab-${tab}`}>
        <RewoundBanner />
        {/* Activity stays mounted so its scroll position and expanded rows survive a tab switch. */}
        <div className={viewClass('activity')} style={slide} hidden={tab !== 'activity' && prev !== 'activity'} {...(prev === 'activity' ? LEAVING : {})}>
          <Activity active={tab === 'activity'} />
        </div>
        {SWAPPED.filter(t => t === tab || t === prev).map(t => (
          <div className={viewClass(t)} style={slide} key={t} {...(t === prev ? LEAVING : {})}>{view(t, tools)}</div>
        ))}
      </div>
      <Timeline />
    </main>
  );
}
