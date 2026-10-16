import { useEffect, useLayoutEffect, useReducer, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore, type StoreState } from '../store';
import { GLIDE_MS, PANELS, drawn, setCollapsed, shownLayout, toggleWide } from '../panels';
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
  const glideUntil = useStore(s => s.glideUntil);
  // The columns animate only while a panel collapses or expands, or after the Widen button (glideUntil; styles.css
  // turns this off for reduced motion): never on first paint, during a drag, on a window resize or when a handle ends
  // the widened state. A collapse is decided during render, so the class lands in the same commit as the collapsed
  // class and the transition starts; Widen's class is also set by the width writer below. A timer re-render drops it.
  const shape = `${files} ${inspector}`;
  const prev = useRef(shape);
  const until = useRef(0);
  if (prev.current !== shape) {
    prev.current = shape;
    until.current = dragging ? 0 : Date.now() + GLIDE_MS;
  }
  const end = Math.max(until.current, glideUntil);
  const glide = !dragging && Date.now() < end;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(tick, end - Date.now());
    return () => window.clearTimeout(t);
  }, [glide, end]);

  // Before first paint: measure the real box (safe-area insets and gutters included; the ResizeObserver also sees
  // every window resize, since .app is inset from the window) and write the drawn widths as --left-w and --right-w,
  // then keep both current. jsdom has no layout: the box falls back to the window less its 12 px gutters.
  // Widen and Restore write new widths before React renders: the class goes on first, so they glide.
  useLayoutEffect(() => {
    const el = ref.current!;
    let last: unknown;
    const paint = (s: StoreState) => {
      const { fit } = drawn(s);
      if (fit === last) return;
      last = fit;
      if (!s.dock.dragging && Date.now() < s.glideUntil) el.classList.add('glide');
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
  return (
    <button type="button" className="iconbtn barbtn widebtn" aria-label={off ? 'Widen inspector' : label} title={label} disabled={off} onClick={toggleWide}>
      <WidenIcon on={wide} />
    </button>
  );
}
