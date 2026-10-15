/**
 * Docked panel widths and collapsed state at 1080 px and wider (below that the panels are slide-overs; see panels.ts).
 */
export type Panel = 'files' | 'inspector';
export interface PanelLayout {
  /** The width the user last set per panel (what they saw); null follows the default for the viewport. */
  w: Record<Panel, number | null>;
  collapsed: Record<Panel, boolean>;
  /** The panel the user resized last: when the box is too narrow, the other one gives way first. */
  last?: Panel;
}

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

/**
 * The widths to draw in an `.app` box `width` px wide (`vw`, the viewport, picks the defaults): each set width, and
 * when the shown panels would squeeze the center below CENTER_MIN, the panel not resized last gives way first (down
 * to its minimum), then the other. Nothing shrunk here is stored.
 */
export function fitLayout(l: PanelLayout, width: number, vw: number): Record<Panel, number> {
  const out = { files: limit('files', l.w.files ?? defaultWidth('files', vw)), inspector: limit('inspector', l.w.inspector ?? defaultWidth('inspector', vw)) };
  const shown = (l.last === 'files' ? (['inspector', 'files'] as const) : (['files', 'inspector'] as const)).filter(p => !l.collapsed[p]);
  let excess = shown.reduce((n, p) => n + out[p] + GAP, 0) - width + CENTER_MIN;
  for (const p of shown) {
    const cut = Math.max(0, Math.min(excess, out[p] - LIMITS[p][0]));
    out[p] -= cut;
    excess -= cut;
  }
  return out;
}

/** The widest `p` can be drawn in this box: its limit, or what the center minimum and the other panel at its minimum leave. */
export function reach(l: PanelLayout, p: Panel, width: number): number {
  const o: Panel = p === 'files' ? 'inspector' : 'files';
  const other = l.collapsed[o] ? 0 : LIMITS[o][0] + GAP;
  return Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], width - CENTER_MIN - GAP - other));
}

/** A stored layout; anything unreadable falls back to the defaults, widths are clamped to their limits. */
export function parseLayout(raw: string | null): PanelLayout {
  const l = emptyLayout();
  let v: { w?: Record<string, unknown>; collapsed?: Record<string, unknown>; last?: unknown } | null = null;
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
  if (v.last === 'files' || v.last === 'inspector') l.last = v.last;
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
