import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore, type StoreState } from '../store';
import { PANELS, drawn, setCollapsed, shownLayout, toggleWide } from '../panels';
import type { Panel } from '../panelLayout';
import { PanelIcon, SidebarIcon, WidenIcon } from './icons';

const collapsedOf = (p: Panel) => (s: StoreState) => shownLayout(s).collapsed[p];
const filesCollapsed = collapsedOf('files');
const inspectorCollapsed = collapsedOf('inspector');

/**
 * The `.app` grid. It re-renders only when a panel collapses or expands, Widen or Restore is pressed, or a drag
 * starts or ends; the column widths
 * are written onto it directly from the store, so a drag or a window resize re-renders nothing here.
 */
export function Dock({ gated, children }: { gated: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const files = useStore(filesCollapsed);
  const inspector = useStore(inspectorCollapsed);
  const dragging = useStore(s => s.dock.dragging);
  // The columns animate only while the store says so (glideUntil: a collapse, an expand, Widen or Restore; see
  // panels.ts), never during a drag. styles.css turns it off for reduced motion. A timer re-render drops the class.
  const glideUntil = useStore(s => s.glideUntil);
  const glide = !dragging && Date.now() < glideUntil;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(tick, glideUntil - Date.now());
    return () => window.clearTimeout(t);
  }, [glide, glideUntil]);

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
    <button type="button" className={clsx('iconbtn barbtn hidebtn', `hide-${panel}`)} aria-label={`Hide ${name}`} aria-keyshortcuts={key} title={`Hide ${name} (${key})`} onClick={() => setCollapsed(panel, true)}>
      {panel === 'files' ? <SidebarIcon /> : <PanelIcon />}
    </button>
  );
}

/** How close to its reach the inspector may be for Widen to still do something. */
const WIDEN_SLACK = 24;

/**
 * Widens the docked inspector to its reach (the project panel gives way to its minimum), or puts back the layout it
 * replaced. Disabled when there is no room to widen; hidden below 1080 px. A drag or a key on either handle ends the
 * widened state without a restore.
 */
export function WidenButton() {
  const wide = useStore(s => !!s.layout.wide);
  const full = useStore(s => { const { fit, reach } = drawn(s); return fit.inspector >= reach.inspector - WIDEN_SLACK; });
  const off = !wide && full;
  const label = wide ? 'Restore inspector width' : off ? 'No room to widen' : 'Widen inspector';
  // aria-disabled, not disabled: a button that becomes disabled drops focus to the body.
  return (
    <button type="button" className="iconbtn barbtn widebtn" aria-label={off ? 'Widen inspector' : label} title={label} aria-disabled={off || undefined} onClick={() => { if (!off) toggleWide(); }}>
      <WidenIcon on={wide} />
    </button>
  );
}
