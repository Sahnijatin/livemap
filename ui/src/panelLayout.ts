/** Docked panel widths and collapsed state at 1080 px and wider (below that the panels are slide-overs; see panels.ts). */
export type Panel = 'files' | 'inspector';
export interface PanelLayout {
  /** Chosen width per panel; null follows the default for the viewport. */
  w: Record<Panel, number | null>;
  collapsed: Record<Panel, boolean>;
}

export const LAYOUT_KEY = 'livemap:layout';
export const LIMITS: Record<Panel, [number, number]> = { files: [200, 520], inspector: [300, 720] };
/** The center column never gets narrower than this because of a panel. */
export const CENTER_MIN = 420;
/** The `.app` inset on each side and the gap beside a shown panel (styles.css). */
const GUTTER = 12;
const GAP = 12;

export const emptyLayout = (): PanelLayout => ({ w: { files: null, inspector: null }, collapsed: { files: false, inspector: false } });

/** Today's fixed columns: 272/384 from 1280 px, 248/340 below. */
export const defaultWidth = (p: Panel, vw: number): number => (p === 'files' ? (vw < 1280 ? 248 : 272) : vw < 1280 ? 340 : 384);

const limit = (p: Panel, w: number): number => Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], Math.round(w)));

/** A width for `p` within its limits that leaves the center CENTER_MIN; `other` is what the other panel takes (width and gap, 0 when collapsed). */
export function clampWidth(p: Panel, w: number, vw: number, other: number): number {
  if (!Number.isFinite(w)) return LIMITS[p][0];
  return Math.max(LIMITS[p][0], Math.min(limit(p, w), vw - GUTTER * 2 - CENTER_MIN - GAP - other));
}

/** The widths to draw at viewport `vw`: each chosen (or default) width, shrunk in proportion when the shown panels would squeeze the center. */
export function fitLayout(l: PanelLayout, vw: number): Record<Panel, number> {
  const out = { files: limit('files', l.w.files ?? defaultWidth('files', vw)), inspector: limit('inspector', l.w.inspector ?? defaultWidth('inspector', vw)) };
  const shown = (['files', 'inspector'] as const).filter(p => !l.collapsed[p]);
  const excess = shown.reduce((n, p) => n + out[p] + GAP, 0) - (vw - GUTTER * 2 - CENTER_MIN);
  const room = shown.reduce((n, p) => n + out[p] - LIMITS[p][0], 0);
  if (excess <= 0 || room <= 0) return out;
  for (const p of shown) out[p] = Math.max(LIMITS[p][0], out[p] - Math.ceil((excess * (out[p] - LIMITS[p][0])) / room));
  return out;
}

/** A stored layout; anything unreadable falls back to the defaults, widths are clamped to their limits. */
export function parseLayout(raw: string | null): PanelLayout {
  const l = emptyLayout();
  let v: { w?: Record<string, unknown>; collapsed?: Record<string, unknown> } | null = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return l;
  }
  if (!v || typeof v !== 'object') return l;
  for (const p of ['files', 'inspector'] as const) {
    const w = v.w?.[p];
    if (typeof w === 'number' && Number.isFinite(w)) l.w[p] = limit(p, w);
    l.collapsed[p] = v.collapsed?.[p] === true;
  }
  return l;
}

/** The remembered layout; the defaults when storage is empty, unavailable or throws. */
export function loadLayout(): PanelLayout {
  try {
    return parseLayout(globalThis.localStorage?.getItem(LAYOUT_KEY) ?? null);
  } catch {
    return emptyLayout();
  }
}

export function saveLayout(l: PanelLayout): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // Private mode or blocked storage: the layout lasts for this page only.
  }
}
