/** Docked panel widths and collapsed state at 1080 px and wider (below that the panels are slide-overs; see panels.ts). */
export type Panel = 'files' | 'inspector';
export interface PanelLayout {
  /** The width the user chose per panel; null follows the default for the viewport. Only the drawn width is clamped. */
  w: Record<Panel, number | null>;
  collapsed: Record<Panel, boolean>;
}

/** Each panel's name in labels, its shortcut key and its element id. */
export const PANELS: Record<Panel, { name: string; key: string; id: string }> = {
  files: { name: 'project panel', key: '[', id: 'sidebar' },
  inspector: { name: 'inspector', key: ']', id: 'inspector' },
};
export const LAYOUT_KEY = 'livemap:layout';
export const LIMITS: Record<Panel, [number, number]> = { files: [200, 520], inspector: [300, 720] };
/** The center column never gets narrower than this because of a panel. */
export const CENTER_MIN = 420;
/** The gap beside a shown panel (styles.css). */
export const GAP = 12;

export const emptyLayout = (): PanelLayout => ({ w: { files: null, inspector: null }, collapsed: { files: false, inspector: false } });

/** Today's fixed columns: 272/384 from a 1280 px viewport, 248/340 below. */
export const defaultWidth = (p: Panel, vw: number): number => (p === 'files' ? (vw < 1280 ? 248 : 272) : vw < 1280 ? 340 : 384);

const limit = (p: Panel, w: number): number => Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], Math.round(w)));

/** The layout as drawn: while `peek` (a file was selected) a collapsed inspector shows; the stored layout is untouched. */
export const shownLayout = (l: PanelLayout, peek: boolean): PanelLayout =>
  peek && l.collapsed.inspector ? { ...l, collapsed: { ...l.collapsed, inspector: false } } : l;

/**
 * The widths to draw in an `.app` box `width` px wide (`vw`, the viewport, picks the defaults): each chosen width,
 * shrunk in proportion to its room above the minimum when the shown panels would squeeze the center below CENTER_MIN.
 * The drawn width only grows with a panel's chosen width, which `widthFor` relies on.
 */
export function fitLayout(l: PanelLayout, width: number, vw: number): Record<Panel, number> {
  const out = { files: limit('files', l.w.files ?? defaultWidth('files', vw)), inspector: limit('inspector', l.w.inspector ?? defaultWidth('inspector', vw)) };
  const shown = (['files', 'inspector'] as const).filter(p => !l.collapsed[p]);
  const excess = shown.reduce((n, p) => n + out[p] + GAP, 0) - width + CENTER_MIN;
  const room = shown.reduce((n, p) => n + out[p] - LIMITS[p][0], 0);
  if (excess > 0 && room > 0) for (const p of shown) out[p] = Math.max(LIMITS[p][0], out[p] - Math.ceil((excess * (out[p] - LIMITS[p][0])) / room));
  return out;
}

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
