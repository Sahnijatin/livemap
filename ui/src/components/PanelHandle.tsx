import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from '../store';
import { PANELS, drawn, setCollapsed } from '../panels';
import { LIMITS, saveLayout, type Panel, type PanelLayout } from '../panelLayout';

/**
 * The drag handle on a docked panel's inner edge (1080 px and wider): drag or arrow keys resize (Shift: 64 px), Home
 * and End go to the minimum and to the widest the box allows, Enter collapses, a double-click restores the default.
 * What the user sees is what is stored: the panel's drawn width, and it becomes the panel the other gives way to.
 * A drag saves once, when it ends; a lost pointer capture or a window blur ends it too.
 */
export function PanelHandle({ panel }: { panel: Panel }) {
  const { fit, reach } = useStore(drawn);
  const now = fit[panel];
  const [min] = LIMITS[panel];
  const max = reach[panel];
  // The inspector's handle is on its left edge: moving it left widens the panel.
  const dir = panel === 'files' ? 1 : -1;
  const g = useRef<{ x: number; d: number; from: PanelLayout } | null>(null);

  const set = (w: number | null, save = true) => {
    const s = useStore.getState();
    s.setLayout({ ...s.layout, w: { ...s.layout.w, [panel]: w }, last: panel }, save);
  };
  /** Draws the panel at `d`, within reach; nothing happens (or is saved) when that is the width drawn now. */
  const draw = (d: number, save = true) => {
    const t = Math.max(min, Math.min(max, Math.round(d)));
    if (t !== now) set(t, save);
  };
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
    const step = (e.shiftKey ? 64 : 16) * dir;
    if (e.key === 'ArrowRight') draw(now + step);
    else if (e.key === 'ArrowLeft') draw(now - step);
    else if (e.key === 'Home') draw(min);
    else if (e.key === 'End') draw(max);
    else if (e.key === 'Enter') setCollapsed(panel, true);
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    g.current = { x: e.clientX, d: now, from: useStore.getState().layout };
    useStore.getState().setDock({ dragging: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = g.current;
    if (d) draw(d.d + dir * (e.clientX - d.x), false);
  };

  return (
    <div
      className={`rz rz-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${PANELS[panel].name}`}
      aria-controls={PANELS[panel].id}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-handle={panel}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => set(null)}
    />
  );
}
