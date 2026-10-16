import { useLayoutEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore, type StoreState } from '../store';
import { PANELS, drawn, setCollapsed, shownLayout, toggleWide } from '../panels';
import type { Panel, PanelLayout } from '../panelLayout';
import { PanelIcon, SidebarIcon, WidenIcon } from './icons';

const collapsedOf = (p: Panel) => (s: StoreState) => shownLayout(s).collapsed[p];
const filesCollapsed = collapsedOf('files');
const inspectorCollapsed = collapsedOf('inspector');

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
  // peek) or Widen or Restore is pressed, `data-glide` goes on `.app` before the widths are written, in the same
  // step, so the columns transition (styles.css; off for reduced motion). React never renders the attribute. It
  // comes off when the grid's transition ends, or after the CSS duration. A window resize, a drag, a no-op collapse
  // or a handle that ends the widened state changes none of that, so never glides; a drag also stops a glide.
  useLayoutEffect(() => {
    const el = ref.current!;
    let last: unknown;
    let shape: string | undefined;
    let prev: PanelLayout | undefined;
    let timer = 0;
    const stop = () => {
      window.clearTimeout(timer);
      el.removeAttribute('data-glide');
    };
    const start = () => {
      window.clearTimeout(timer);
      el.setAttribute('data-glide', '');
      const v = getComputedStyle(el).getPropertyValue('--glide-dur').trim();
      timer = window.setTimeout(stop, (parseFloat(v) || 0) * (v.endsWith('ms') ? 1 : 1000) + 100);
    };
    const onEnd = (e: TransitionEvent) => { if (e.target === el && e.propertyName === 'grid-template-columns') stop(); };
    el.addEventListener('transitionend', onEnd);
    const paint = (s: StoreState) => {
      const { l, fit } = drawn(s);
      const next = `${l.collapsed.files} ${l.collapsed.inspector}`;
      // Widen, or Restore (which puts back the very widths Widen kept); not a handle ending the widened state.
      const toggled = !!prev && !!prev.wide !== !!s.layout.wide && (!!s.layout.wide || s.layout.w === prev.wide!.w);
      if (s.dock.dragging) stop();
      else if ((shape !== undefined && next !== shape) || toggled) start();
      shape = next;
      prev = s.layout;
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

/** How close to its reach the inspector may be for Widen to still do something. */
const WIDEN_SLACK = 24;

/**
 * Widens the docked inspector to its reach (the project panel gives way to its minimum), or puts back the layout it
 * replaced. Unavailable when there is no room to widen; hidden below 1080 px. A handle change that moves a panel ends
 * the widened state, without a restore.
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
