import type { Layer } from '../layers';
import { splitName } from '../treeModel';
import type { Level, MapFolder } from './mapModel';
import type { Box, MapFlowNode } from './mapFlow';

/**
 * Below this zoom the map is "far": cards drop shadows and text (they cannot be read there) and folders get overview
 * labels instead. The one threshold for both.
 */
export const FAR_ZOOM = 0.45;
/** An overview label's height and widest width on screen, in px. */
export const LABEL_H = 30;
export const LABEL_MAX_W = 240;
/** About 8 px a character at 14 px semibold; a label's dot and padding take 40 px. */
const LABEL_CHAR_W = 8;
const LABEL_PAD = 40;
/** A New tag and its gap, in px. */
export const NEW_TAG_W = 40;
/** A label cut narrower than this (8 characters) is left out: it would not say which folder it is. */
const LABEL_MIN_W = LABEL_PAD + 8 * LABEL_CHAR_W;
/** A large project's open/close toggle at the top right of a region, with its inset and a gap, in flow px. */
export const TOGGLE_W = 94;
/** Clear space kept around a label on screen, in px. */
const LABEL_GAP = 6;

/** `w` is the label's screen width and `chars` the characters its name gets. */
export interface OverviewLabel { id: string; text: string; layer: Layer; isNew: boolean; x: number; y: number; w: number; chars: number }

/** A folder's name as cards and labels show it: a slash after a folder, none after the project root. */
export const slash = (label: string, path: string): string => (path === '' ? label : `${label}/`);

export const labelWidth = (text: string, isNew = false): number =>
  Math.min(LABEL_MAX_W, LABEL_PAD + text.length * LABEL_CHAR_W) + (isNew ? NEW_TAG_W : 0);

/** Zoom rounded to steps of 1.25, so labels re-render a few times while zooming out, not every frame. */
export const quantZoom = (z: number): number => 1.25 ** Math.round(Math.log(z) / Math.log(1.25));

/**
 * How a folder name fits in `chars` characters: whole; cut in the middle (MidName, keeping as many whole trailing
 * folders as leave the start 3 characters and its "…"); else, when even the last folder leaves no room, "…" and the
 * end, cut at its own end if still too long. `tailMax` goes to MidName.
 */
export function nameFit(name: string, chars: number): { mode: 'whole' | 'middle' | 'end'; tailMax: number } {
  const tailMax = chars - 4 - (name.endsWith('/') ? 1 : 0);
  if (name.length <= chars) return { mode: 'whole', tailMax };
  const tail = splitName(name, 'path', tailMax)[1] || name;
  return { mode: tail.length <= chars - 4 ? 'middle' : 'end', tailMax };
}

/** The end of a name in "…" + end mode (see nameFit). */
export const nameEnd = (name: string, tailMax: number): string => splitName(name, 'path', tailMax)[1] || name;

/** Folders in label order: new ones first, then by file count (largest first), then by path. */
export const rankFolders = (folders: MapFolder[]): MapFolder[] => [...folders].sort((a, b) =>
  Number(b.isNew) - Number(a.isNew) || b.counts.files - a.counts.files || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** Folder boxes from the nodes React Flow draws. */
export function folderBoxes(nodes: MapFlowNode[]): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const n of nodes) if (n.type === 'folder') out.set(n.id, { x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 });
  return out;
}

/**
 * Overview labels for a zoomed-out map, in flow coordinates (each is drawn scaled by 1 / zoom, so it keeps its screen
 * size): centered on a folder card, or at the top left of a folder region. New folders, then folders with more files,
 * claim space first; a label that would touch one already placed is left out (it shows once the user zooms in), and
 * so is one not wholly inside `view` (the visible area), which would be clipped. In a large project a region's label
 * ends before its open/close toggle, and is left out when that leaves it under 8 characters. Overlaps are checked on
 * a grid of label-sized cells, so a large project stays fast.
 */
export function overviewLabels(
  folders: MapFolder[], boxes: Map<string, Box>, level: Level, zoom: number, view?: Box, large = false,
): OverviewLabel[] {
  if (zoom >= FAR_ZOOM) return [];
  const h = LABEL_H / zoom, m = LABEL_GAP / zoom;
  const cw = (LABEL_MAX_W + LABEL_GAP) / zoom, ch = (LABEL_H + LABEL_GAP) / zoom;
  const grid = new Map<string, Box[]>();
  const cells = (r: Box, add: Box | null): boolean => {
    for (let i = Math.floor((r.x - m) / cw); i <= Math.floor((r.x + r.w + m) / cw); i++) {
      for (let j = Math.floor((r.y - m) / ch); j <= Math.floor((r.y + r.h + m) / ch); j++) {
        const k = `${i},${j}`;
        if (add) { const c = grid.get(k); if (c) c.push(add); else grid.set(k, [add]); continue; }
        for (const p of grid.get(k) ?? []) if (r.x < p.x + p.w + m && p.x < r.x + r.w + m && r.y < p.y + p.h + m && p.y < r.y + r.h + m) return true;
      }
    }
    return false;
  };
  const out: OverviewLabel[] = [];
  for (const f of rankFolders(folders)) {
    const b = boxes.get(f.id);
    if (!b) continue;
    const text = slash(f.label, f.path);
    const full = labelWidth(text, f.isNew);
    const sw = level !== 'folders' && large ? Math.min(full, Math.floor((b.w - 10 - TOGGLE_W) * zoom)) : full;
    if (sw < Math.min(full, LABEL_MIN_W + (f.isNew ? NEW_TAG_W : 0))) continue;
    const w = sw / zoom;
    const r: Box = level === 'folders'
      ? { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }
      : { x: b.x + 10, y: b.y + 6, w, h };
    if (view && (r.x < view.x || r.y < view.y || r.x + r.w > view.x + view.w || r.y + r.h > view.y + view.h)) continue;
    if (cells(r, null)) continue;
    cells(r, r);
    const chars = Math.floor((sw - LABEL_PAD - (f.isNew ? NEW_TAG_W : 0)) / LABEL_CHAR_W);
    out.push({ id: f.id, text, layer: f.layer, isNew: f.isNew, x: r.x, y: r.y, w: sw, chars });
  }
  return out;
}

/**
 * Placed labels moved by how far their folder node is from where it was when they were placed: while nodes move (a
 * drag, a layout move) labels follow cheaply, and are placed again once the nodes settle. The same array when nothing moved.
 */
export function shiftLabels(labels: OverviewLabel[], rest: Map<string, Box>, live: Map<string, Box>): OverviewLabel[] {
  let moved = false;
  const out = labels.map(l => {
    const a = rest.get(l.id), b = live.get(l.id);
    if (!a || !b || (a.x === b.x && a.y === b.y)) return l;
    moved = true;
    return { ...l, x: l.x + b.x - a.x, y: l.y + b.y - a.y };
  });
  return moved ? out : labels;
}
