import { useStore } from './store';
import { LIMITS, fitLayout, type Panel, type PanelLayout } from './panelLayout';

/** What a handle knows when an event arrives: its panel, the shown layout and box, the drawn width and its reach. */
export interface Handle { panel: Panel; l: PanelLayout; width: number; vw: number; now: number; max: number }

/** The smallest width to store for `p` that fitLayout draws at `d` or wider (the limit when the box cannot hold `d`). */
export function widthFor(l: PanelLayout, p: Panel, d: number, width: number, vw: number): number {
  let [lo, hi] = LIMITS[p];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fitLayout({ ...l, w: { ...l.w, [p]: mid } }, width, vw)[p] >= d) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Draws the panel at `d`, within reach: stores the width that draws there, so a window too small for the user's
 * width never overwrites it. Nothing happens (or is saved) when that is the width drawn now.
 */
export function draw(h: Handle, d: number, save = true): void {
  const t = Math.max(LIMITS[h.panel][0], Math.min(h.max, Math.round(d)));
  if (t === h.now) return;
  const s = useStore.getState();
  s.setLayout({ ...s.layout, w: { ...s.layout.w, [h.panel]: widthFor(h.l, h.panel, t, h.width, h.vw) } }, save);
}

/** Arrow keys move the edge 16 px (Shift: 64); Home and End go to the minimum and to the widest the box allows. */
export function key(k: string, shift: boolean, h: Handle): void {
  // The inspector's handle is on its left edge: moving it left widens the panel.
  const step = (shift ? 64 : 16) * (h.panel === 'files' ? 1 : -1);
  draw(h, k === 'ArrowRight' ? h.now + step : k === 'ArrowLeft' ? h.now - step : k === 'Home' ? 0 : h.max);
}
