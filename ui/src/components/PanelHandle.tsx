import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useViewportWidth } from '../media';
import { setCollapsed } from '../panels';
import { LIMITS, clampWidth, fitLayout, type Panel } from '../panelLayout';
import { SidebarIcon, PanelIcon } from './icons';

const NAMES: Record<Panel, [string, string, string]> = { files: ['project panel', '[', 'sidebar'], inspector: ['inspector', ']', 'inspector'] };
/** The gap beside a shown panel (styles.css). */
const GAP = 12;

/** The `.app` classes and the docked column widths (styles.css reads `--left-w` and `--right-w` at 1080 px and wider). */
export function useDockLayout(): { className: string; style: CSSProperties } {
  const layout = useStore(s => s.layout);
  const fit = fitLayout(layout, useViewportWidth());
  // The columns animate only while a panel collapses or expands, never on a window resize or a drag. Set during
  // render, so the class lands in the same commit as the collapsed class and the transition starts.
  const shape = `${layout.collapsed.files} ${layout.collapsed.inspector}`;
  const [seen, setSeen] = useState(shape);
  const [glide, setGlide] = useState(false);
  if (seen !== shape) {
    setSeen(shape);
    setGlide(true);
  }
  useEffect(() => {
    if (!glide) return;
    const t = window.setTimeout(() => setGlide(false), 500);
    return () => window.clearTimeout(t);
  }, [glide, shape]);
  return {
    className: clsx('app', layout.collapsed.files && 'left-collapsed', layout.collapsed.inspector && 'right-collapsed', glide && 'glide'),
    style: { '--left-w': `${fit.files}px`, '--right-w': `${fit.inspector}px` } as CSSProperties,
  };
}

/**
 * The drag handle on a docked panel's inner edge (1080 px and wider): drag or arrow keys resize (Shift: 64 px),
 * Home and End go to the limits, Enter collapses, a double-click restores the default width.
 */
export function PanelHandle({ panel }: { panel: Panel }) {
  const layout = useStore(s => s.layout);
  const vw = useViewportWidth();
  const fit = fitLayout(layout, vw);
  const other: Panel = panel === 'files' ? 'inspector' : 'files';
  const taken = layout.collapsed[other] ? 0 : fit[other] + GAP;
  const now = fit[panel];
  const max = clampWidth(panel, LIMITS[panel][1], vw, taken);
  // The inspector's handle is on its left edge: moving it left widens the panel.
  const dir = panel === 'files' ? 1 : -1;
  const drag = useRef<{ x: number; w: number } | null>(null);

  const resize = (w: number | null, save = true) => {
    const s = useStore.getState();
    s.setLayout({ ...s.layout, w: { ...s.layout.w, [panel]: w === null ? null : clampWidth(panel, w, vw, taken) } }, save);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowRight') resize(now + dir * step);
    else if (e.key === 'ArrowLeft') resize(now - dir * step);
    else if (e.key === 'Home') resize(LIMITS[panel][0]);
    else if (e.key === 'End') resize(max);
    else if (e.key === 'Enter') setCollapsed(panel, true);
    else return;
    e.preventDefault();
  };
  const app = (e: PointerEvent<HTMLDivElement>) => e.currentTarget.closest('.app')?.classList;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, w: now };
    // No column transition while dragging: the grid follows the pointer.
    app(e)?.add('resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.w + dir * (e.clientX - drag.current.x), false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    app(e)?.remove('resizing');
    resize(useStore.getState().layout.w[panel]);
  };

  return (
    <div
      className={clsx('rz', `rz-${panel}`)}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${NAMES[panel][0]}`}
      aria-controls={NAMES[panel][2]}
      aria-valuenow={now}
      aria-valuemin={LIMITS[panel][0]}
      aria-valuemax={max}
      tabIndex={0}
      data-handle={panel}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => resize(null)}
    />
  );
}

/** The small button in a docked panel's header that collapses it (hidden below 1080 px). */
export function CollapseButton({ panel }: { panel: Panel }) {
  const [name, key] = NAMES[panel];
  return (
    <button type="button" className={clsx('iconbtn hidebtn', `hide-${panel}`)} aria-label={`Hide ${name}`} aria-keyshortcuts={key} title={`Hide ${name} (${key})`} onClick={() => setCollapsed(panel, true)}>
      {panel === 'files' ? <SidebarIcon /> : <PanelIcon />}
    </button>
  );
}
