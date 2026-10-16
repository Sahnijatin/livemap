import { useLayoutEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore, type StoreState } from '../store';
import { PANELS, drawn, setCollapsed, shownLayout } from '../panels';
import { restoreWide, widen, type Panel } from '../panelLayout';
import { PanelIcon, SidebarIcon, WidenIcon } from './icons';

const collapsedOf = (p: Panel) => (s: StoreState) => shownLayout(s).collapsed[p];
const filesCollapsed = collapsedOf('files');
const inspectorCollapsed = collapsedOf('inspector');

/** When Widen or Restore asked for a glide: valid for the widths written within a frame or so. */
let glideAsked = -Infinity;
const ASK_MS = 50;
/** Widen and Restore: the widths written next (within about a frame) glide. */
export function requestGlide(): void {
  glideAsked = performance.now();
}

/**
 * The `.app` grid. It re-renders only when a panel collapses or expands or a drag starts or ends; the column widths
 * and the glide are written onto it directly from the store, so a drag or a window resize re-renders nothing here.
 */
export function Dock({ gated, children }: { gated: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const files = useStore(filesCollapsed);
  const inspector = useStore(inspectorCollapsed);
  const dragging = useStore(s => s.dock.dragging);

  // Before first paint: measure the real box (safe-area insets and gutters included; the ResizeObserver also sees
  // every window resize, since .app is inset from the window) and write the drawn widths as --left-w and --right-w,
  // then keep both current. jsdom has no layout: the box falls back to the window less its 12 px gutters.
  //
  // The glide is decided here too, the one place: when the shown collapsed state changes (a collapse, an expand, a
  // peek) or Widen or Restore asked for it (requestGlide), `data-glide` goes on `.app` before the widths are written,
  // in the same step, so the columns transition (styles.css; off for reduced motion). React never renders the
  // attribute. It comes off when the grid's transition ends, or after the CSS duration. A window resize, a drag, a
  // no-op collapse or a handle that ends the widened state does neither, so never glides; a drag also stops one.
  useLayoutEffect(() => {
    const el = ref.current!;
    let last: unknown;
    let shape: string | undefined;
    let timer = 0;
    const dur = getComputedStyle(el).getPropertyValue('--glide-dur').trim();
    const ms = (parseFloat(dur) || 0) * (dur.endsWith('ms') ? 1 : 1000) + 100;
    const stop = () => {
      window.clearTimeout(timer);
      el.removeAttribute('data-glide');
    };
    const start = () => {
      window.clearTimeout(timer);
      el.setAttribute('data-glide', '');
      timer = window.setTimeout(stop, ms);
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === el && e.propertyName === 'grid-template-columns') stop(); };
    el.addEventListener('transitionend', onEnd);
    let seen: unknown[] = [];
    const paint = (s: StoreState) => {
      // Only what the drawn layout depends on (see drawn); any other store change returns here.
      const deps = [s.layout, s.peek, s.selected, s.dock, s.selected !== null && !!s.files[s.selected]];
      if (deps.every((d, i) => d === seen[i])) return;
      seen = deps;
      const { l, fit } = drawn(s);
      const next = `${l.collapsed.files} ${l.collapsed.inspector}`;
      const asked = performance.now() - glideAsked < ASK_MS;
      if (s.dock.dragging) stop();
      else if ((shape !== undefined && next !== shape) || asked) start();
      shape = next;
      if (asked) glideAsked = -Infinity;
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
      stop();
      el.removeEventListener('transitionend', onEnd);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={clsx('app', files && 'left-collapsed', inspector && 'right-collapsed', dragging && 'resizing')}
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

/** The Widen inspector button: widens the docked inspector, or restores what Widen replaced. Both ask to glide. */
export function toggleWide(): void {
  const s = useStore.getState();
  requestGlide();
  // What is drawn decides: a peek of a hidden, widened inspector draws it as before Widen, so this widens it again
  // and shows it for good (its widened width would otherwise squeeze the tree only while peeking).
  const shown = drawn(s).l;
  s.setLayout(shown.wide ? restoreWide(s.layout) : widen({ ...restoreWide(s.layout), collapsed: shown.collapsed }));
}

/** How close to its reach the inspector may be for Widen to still do something. */
const WIDEN_SLACK = 24;

/**
 * Widens the docked inspector to its reach (the project panel gives way to its minimum), or puts back the layout it
 * replaced. Unavailable when there is no room to widen; hidden below 1080 px. A handle change that moves a panel ends
 * the widened state, without a restore.
 */
export function WidenButton() {
  const wide = useStore(s => !!drawn(s).l.wide);
  const full = useStore(s => { const { fit, reach } = drawn(s); return fit.inspector >= reach.inspector - WIDEN_SLACK; });
  const off = !wide && full;
  const label = wide ? 'Restore inspector width' : off ? 'No room to widen' : 'Widen inspector';
  // aria-disabled, not disabled: a button that becomes disabled drops focus to the body.
  return (
    <button type="button" className="iconbtn barbtn widebtn" aria-label={label} title={label} aria-disabled={off || undefined} onClick={() => { if (!off) toggleWide(); }}>
      <WidenIcon on={wide} />
    </button>
  );
}
