import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { PANELS, setCollapsed, shownLayout } from '../panels';
import type { Panel } from '../panelLayout';
import { PanelIcon, SidebarIcon } from './icons';

/**
 * The `.app` grid. React owns its classes (collapsed panels, the collapse glide, a drag); dockFit.ts, loaded after
 * first paint, owns the column widths, so a drag or a window resize re-renders nothing here.
 */
export function Dock({ gated, children }: { gated: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { collapsed } = shownLayout(useStore(s => s.layout), useStore(s => s.peek));
  const dragging = useStore(s => s.dock.dragging);
  // The columns animate only while a panel collapses or expands, never during a drag or a window resize. Set during
  // render, so the class lands in the same commit as the collapsed class and the transition starts.
  const shape = `${collapsed.files} ${collapsed.inspector}`;
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

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void import('../dockFit').then(m => { if (live) off = m.attach(ref.current!); });
    return () => { live = false; off?.(); };
  }, []);

  return (
    <div
      ref={ref}
      className={clsx('app', collapsed.files && 'left-collapsed', collapsed.inspector && 'right-collapsed', glide && 'glide', dragging && 'resizing')}
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
