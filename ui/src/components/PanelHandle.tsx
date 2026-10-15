import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from '../store';
import { PANELS, setCollapsed, shownLayout } from '../panels';
import { LIMITS, fitLayout, widthFor, type Panel } from '../panelLayout';

/** The docked layout as drawn: the shown layout, the box it fits and each panel's drawn width. */
function useDrawn() {
  const l = shownLayout(useStore(s => s.layout), useStore(s => s.peek));
  const { width, vw } = useStore(s => s.dock);
  return { l, width, vw, fit: fitLayout(l, width, vw) };
}

/**
 * The drag handle on a docked panel's inner edge (1080 px and wider; App loads it after first paint): drag or arrow
 * keys resize (Shift: 64 px), Home and End go to the limits, Enter collapses, a double-click restores the default.
 * The pointer and keys move the drawn width; what is stored is the width that draws there (see widthFor), so a
 * window too small for it does not overwrite the user's choice, and nothing is saved unless the drawn width changes.
 */
export function PanelHandle({ panel }: { panel: Panel }) {
  const { l, width, vw, fit } = useDrawn();
  const now = fit[panel];
  const [min] = LIMITS[panel];
  const max = fitLayout({ ...l, w: { ...l.w, [panel]: LIMITS[panel][1] } }, width, vw)[panel];
  // The inspector's handle is on its left edge: moving it left widens the panel.
  const dir = panel === 'files' ? 1 : -1;
  const drag = useRef<{ x: number; d: number } | null>(null);

  // dockFit.ts saves the layout when it changes outside a drag, so a drag saves once, when it ends.
  const store = (w: number | null) => {
    const s = useStore.getState();
    s.setLayout({ ...s.layout, w: { ...s.layout.w, [panel]: w } });
  };
  /** Draws the panel at `d`, within reach; nothing happens when that is the width drawn now. */
  const draw = (d: number) => {
    const t = Math.max(min, Math.min(max, Math.round(d)));
    if (t !== now) store(widthFor(l, panel, t, width, vw));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowRight') draw(now + dir * step);
    else if (e.key === 'ArrowLeft') draw(now - dir * step);
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
    drag.current = { x: e.clientX, d: now };
    useStore.getState().setDock({ dragging: true });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (g) draw(g.d + dir * (e.clientX - g.x));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    useStore.getState().setDock({ dragging: false });
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
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => store(null)}
    />
  );
}
