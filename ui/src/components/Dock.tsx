import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { setCollapsed } from '../panels';
import { PANELS, fitLayout, shownLayout, type Panel } from '../panelLayout';
import { PanelIcon, SidebarIcon } from './icons';

/** The docked layout as drawn: the shown layout, the box it fits and each panel's drawn width. */
export function useDrawn() {
  const l = shownLayout(useStore(s => s.layout), useStore(s => s.peek));
  const { width, vw } = useStore(s => s.dock);
  return { l, width, vw, fit: fitLayout(l, width, vw) };
}

/**
 * The `.app` grid. It alone follows the docked layout (styles.css reads `--left-w` and `--right-w` at 1080 px and
 * wider), so a drag or a window resize re-renders it and the handles, not the panels and center it is given.
 */
export function Dock({ gated, children }: { gated: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { l, fit } = useDrawn();
  const dragging = useStore(s => s.dock.dragging);
  // The columns animate only while a panel collapses or expands, never during a drag or a window resize. Set during
  // render, so the class lands in the same commit as the collapsed class and the transition starts.
  const shape = `${l.collapsed.files} ${l.collapsed.inspector}`;
  const [seen, setSeen] = useState(shape);
  const [glide, setGlide] = useState(false);
  if (seen !== shape) {
    setSeen(shape);
    setGlide(!dragging);
  } else if (glide && dragging) setGlide(false);
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(() => setGlide(false), 500);
    return () => window.clearTimeout(t);
  }, [glide, shape]);

  // Fit the real box (safe-area insets and gutters included); jsdom has no layout, so it falls back to the 12 px gutters.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => useStore.getState().setDock({ width: el.clientWidth || window.innerWidth - 24, vw: window.innerWidth });
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={clsx('app', l.collapsed.files && 'left-collapsed', l.collapsed.inspector && 'right-collapsed', glide && 'glide', dragging && 'resizing')}
      style={{ '--left-w': `${fit.files}px`, '--right-w': `${fit.inspector}px` } as CSSProperties}
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
