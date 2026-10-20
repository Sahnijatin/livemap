import type { Layer } from '../layers';
import type { Level, MapFolder } from './mapModel';
import type { Box } from './mapFlow';

/** Below this zoom (the map's "far" zoom) folders get overview labels; card text is too small to read there. */
export const OVERVIEW_ZOOM = 0.45;
/** An overview label's height and widest width on screen, in px. */
export const LABEL_H = 30;
export const LABEL_MAX_W = 240;
/** Clear space kept around a label on screen, in px. */
const LABEL_GAP = 6;

export interface OverviewLabel { id: string; text: string; layer: Layer; x: number; y: number }

/** A label's width on screen: about 8 px a character at 14 px semibold, plus dot and padding, capped (the label cuts the rest in the middle). */
export const labelWidth = (text: string): number => Math.min(LABEL_MAX_W, 40 + text.length * 8);

/** Zoom rounded to steps of 1.25, so labels re-render a few times while zooming out, not every frame. */
export const quantZoom = (z: number): number => 1.25 ** Math.round(Math.log(z) / Math.log(1.25));

/**
 * Overview labels for a zoomed-out map, in flow coordinates (each is drawn scaled by 1 / zoom, so it keeps its screen
 * size): centered on a folder card, or at the top left of a folder region. Folders with more files claim space first;
 * a label that would touch one already placed is left out (it shows once the user zooms in far enough).
 */
export function overviewLabels(folders: MapFolder[], boxes: Map<string, Box>, level: Level, zoom: number): OverviewLabel[] {
  if (zoom >= OVERVIEW_ZOOM) return [];
  const order = folders
    .filter(f => boxes.has(f.id))
    .sort((a, b) => b.counts.files - a.counts.files || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = LABEL_H / zoom, m = LABEL_GAP / zoom;
  const placed: Box[] = [];
  const out: OverviewLabel[] = [];
  for (const f of order) {
    const b = boxes.get(f.id)!;
    const text = f.path === '' ? f.label : `${f.label}/`;
    const w = labelWidth(text) / zoom;
    const r: Box = level === 'folders'
      ? { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }
      : { x: b.x + 10, y: b.y + 6, w, h };
    if (placed.some(p => r.x < p.x + p.w + m && p.x < r.x + r.w + m && r.y < p.y + p.h + m && p.y < r.y + r.h + m)) continue;
    placed.push(r);
    out.push({ id: f.id, text, layer: f.layer, x: r.x, y: r.y });
  }
  return out;
}
