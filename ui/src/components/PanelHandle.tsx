import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from '../store';
import { PANELS, setCollapsed, shownLayout } from '../panels';
import { LIMITS, fitLayout, saveLayout, type Panel, type PanelLayout } from '../panelLayout';

let drag: typeof import('../panelDrag') | undefined;
/** The drag and key code (panelDrag.ts), loaded on a handle's first focus or pointerdown. */
export const loadDrag = () => import('../panelDrag').then(m => { drag = m; });
const KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

/**
 * The drag handle on a docked panel's inner edge (1080 px and wider): drag or arrow keys resize (Shift: 64 px), Home
 * and End go to the limits, Enter collapses, a double-click restores the default. A drag saves once, when it ends;
 * a lost pointer capture or a window blur ends it too.
 */
export function PanelHandle({ panel }: { panel: Panel }) {
  const l = shownLayout(useStore(s => s.layout), useStore(s => s.peek));
  const { width, vw } = useStore(s => s.dock);
  const now = fitLayout(l, width, vw)[panel];
  const max = fitLayout({ ...l, w: { ...l.w, [panel]: LIMITS[panel][1] } }, width, vw)[panel];
  const h = useRef({ panel, l, width, vw, now, max });
  h.current = { panel, l, width, vw, now, max };
  const g = useRef<{ x: number; d: number; from: PanelLayout } | null>(null);

  const end = () => {
    const d = g.current;
    if (!d) return;
    g.current = null;
    const s = useStore.getState();
    s.setDock({ dragging: false });
    if (s.layout !== d.from) saveLayout(s.layout);
  };
  useEffect(() => {
    window.addEventListener('blur', end);
    return () => window.removeEventListener('blur', end);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') setCollapsed(panel, true);
    else if (!KEYS.includes(e.key)) return;
    e.preventDefault();
    const { key, shiftKey } = e;
    const run = () => drag!.key(key, shiftKey, h.current);
    if (key !== 'Enter') void (drag ? run() : loadDrag().then(run));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    g.current = { x: e.clientX, d: now, from: useStore.getState().layout };
    useStore.getState().setDock({ dragging: true });
    if (!drag) void loadDrag();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = g.current;
    if (d && drag) drag.draw(h.current, d.d + (panel === 'files' ? 1 : -1) * (e.clientX - d.x), false);
  };
  const reset = () => {
    const s = useStore.getState();
    s.setLayout({ ...s.layout, w: { ...s.layout.w, [panel]: null } });
  };

  return (
    <div
      className={`rz rz-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${PANELS[panel].name}`}
      aria-controls={PANELS[panel].id}
      aria-valuenow={now}
      aria-valuemin={LIMITS[panel][0]}
      aria-valuemax={max}
      tabIndex={0}
      data-handle={panel}
      onFocus={() => void loadDrag()}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={reset}
    />
  );
}
