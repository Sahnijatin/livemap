import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore, type StoreState } from '../store';
import { PANELS, drawn, setCollapsed, shownLayout } from '../panels';
import type { Panel } from '../panelLayout';
import { PanelIcon, SidebarIcon } from './icons';

const collapsedOf = (p: Panel) => (s: StoreState) => shownLayout(s).collapsed[p];
const filesCollapsed = collapsedOf('files');
const inspectorCollapsed = collapsedOf('inspector');

/**
 * The `.app` grid. It re-renders only when a panel collapses or expands or a drag starts or ends; the column widths
 * are written onto it directly from the store, so a drag or a window resize re-renders nothing here.
 */
export function Dock({ gated, children }: { gated: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const files = useStore(filesCollapsed);
  const inspector = useStore(inspectorCollapsed);
  const dragging = useStore(s => s.dock.dragging);
  // The columns animate only while a panel collapses or expands, never on first paint, during a drag or on a window
  // resize. Decided during render, so the class lands in the same commit as the collapsed class and the transition
  // starts; a timer re-render drops it.
  const shape = `${files} ${inspector}`;
  const prev = useRef(shape);
  const until = useRef(0);
  if (prev.current !== shape) {
    prev.current = shape;
    until.current = dragging ? 0 : Date.now() + 500;
  }
  const glide = !dragging && Date.now() < until.current;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(tick, until.current - Date.now());
    return () => window.clearTimeout(t);
  }, [glide, shape]);

  // Before first paint: measure the real box (safe-area insets and gutters included; the ResizeObserver also sees
  // every window resize, since .app is inset from the window) and write the drawn widths as --left-w and --right-w,
  // then keep both current. jsdom has no layout: the box falls back to the window less its 12 px gutters.
  useLayoutEffect(() => {
    const el = ref.current!;
    let last: unknown;
    const paint = (s: StoreState) => {
      const { fit } = drawn(s);
      if (fit === last) return;
      last = fit;
      el.style.setProperty('--left-w', `${fit.files}px`);
      el.style.setProperty('--right-w', `${fit.inspector}px`);
    };
    const measure = () => useStore.getState().setDock({ width: el.clientWidth || window.innerWidth - 24, vw: window.innerWidth });
    measure();
    paint(useStore.getState());
    const off = useStore.subscribe(paint);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      off();
      ro?.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={clsx('app', files && 'left-collapsed', inspector && 'right-collapsed', glide && 'glide', dragging && 'resizing')}
      {...(gated ? { inert: '', 'aria-hidden': true } : {})}
    >
      {children}
    </div>
  );
}

/** The small button in a docked panel's header that collapses it (hidden below 1080 px). */
export function CollapseButton({ panel }: { panel: Panel }) {
  const { name, key } = PANELS[panel];
  return (
    <button type="button" className={clsx('iconbtn hidebtn', `hide-${panel}`)} aria-label={`Hide ${name}`} aria-keyshortcuts={key} title={`Hide ${name} (${key})`} onClick={() => setCollapsed(panel, true)}>
      {panel === 'files' ? <SidebarIcon /> : <PanelIcon />}
    </button>
  );
}
