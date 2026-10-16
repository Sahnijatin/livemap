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
  /** The inspector is widened (drawn at its reach): the panel resized last before Widen, which Restore puts back. */
  wide?: { last?: Panel };
  /** The `.app` box width when a handle last set a width: in a smaller box the inspector gives way first. */
  at?: number;
}

export const LAYOUT_KEY = 'livemap:layout';
/** The inspector has no fixed maximum: it reaches as far as the center minimum and the project panel's minimum allow. */
export const LIMITS: Record<Panel, [number, number]> = { files: [200, 520], inspector: [300, Infinity] };
/** The center column never gets narrower than this because of a panel. */
export const CENTER_MIN = 420;
/** The gap beside a shown panel (styles.css). */
export const GAP = 12;

export const emptyLayout = (): PanelLayout => ({ w: { files: null, inspector: null }, collapsed: { files: false, inspector: false } });

/** Today's fixed columns: 272/384 from a 1280 px viewport, 248/340 below. */
export const defaultWidth = (p: Panel, vw: number): number => (p === 'files' ? (vw < 1280 ? 248 : 272) : vw < 1280 ? 340 : 384);

const limit = (p: Panel, w: number): number => Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], Math.round(w)));

/**
 * The widths to draw in an `.app` box `width` px wide (`vw`, the viewport, picks the defaults). In the box a handle
 * last set a width in (`at`; a layout without one counts as set in this box), or a wider one: each set width, and
 * when the shown panels would squeeze the center below CENTER_MIN, the panel not resized last gives way first (down to
 * its minimum), then the other, so the handle in use wins. In a smaller box (a window resize, a reload on a smaller
 * screen): what was drawn in that box, with the inspector giving way first down to its default width, then the same
 * rules. A widened inspector asks for the whole box; collapsed, it keeps that width while it slides away. Nothing
 * shrunk here is stored.
 */
export function fitLayout(l: PanelLayout, width: number, vw: number): Record<Panel, number> {
  if (l.wide && l.collapsed.inspector) {
    const open = fitLayout({ ...l, collapsed: { ...l.collapsed, inspector: false } }, width, vw);
    return { files: fitLayout({ ...l, wide: undefined }, width, vw).files, inspector: open.inspector };
  }
  const want = { files: limit('files', l.w.files ?? defaultWidth('files', vw)), inspector: l.wide ? Math.max(LIMITS.inspector[0], width) : limit('inspector', l.w.inspector ?? defaultWidth('inspector', vw)) };
  const shown = (l.last === 'files' ? (['inspector', 'files'] as const) : (['files', 'inspector'] as const)).filter(p => !l.collapsed[p]);
  /** Fits `from` in `box`; with a `floor`, the inspector first gives way down to it. */
  const squeeze = (from: Record<Panel, number>, box: number, floor?: number) => {
    const out = { ...from };
    let excess = shown.reduce((n, p) => n + out[p] + GAP, 0) - box + CENTER_MIN;
    const steps: [Panel, number][] = shown.map(p => [p, LIMITS[p][0]]);
    if (floor !== undefined && !l.collapsed.inspector) steps.unshift(['inspector', floor]);
    for (const [p, min] of steps) {
      const cut = Math.max(0, Math.min(excess, out[p] - min));
      out[p] -= cut;
      excess -= cut;
    }
    return out;
  };
  const at = l.at ?? width;
  if (l.wide || width >= at) return squeeze(want, width);
  return squeeze(squeeze(want, at), width, Math.max(LIMITS.inspector[0], defaultWidth('inspector', vw)));
}

/** Widens the inspector: the handle in use wins, so the project panel gives way. Remembers what Restore puts back. */
export const widen = (l: PanelLayout): PanelLayout => ({ ...l, last: 'inspector', wide: { last: l.last } });

/** Puts back the layout Widen replaced (widths and box are never changed by it). */
export function restoreWide(l: PanelLayout): PanelLayout {
  if (!l.wide) return l;
  const { wide, last: _last, ...rest } = l;
  return wide.last ? { ...rest, last: wide.last } : rest;
}

/** The widest `p` can be drawn in this box: its limit, or what the center minimum and the other panel at its minimum leave. */
export function reach(l: PanelLayout, p: Panel, width: number): number {
  const o: Panel = p === 'files' ? 'inspector' : 'files';
  const other = l.collapsed[o] ? 0 : LIMITS[o][0] + GAP;
  return Math.max(LIMITS[p][0], Math.min(LIMITS[p][1], width - CENTER_MIN - GAP - other));
}

const readW = (p: Panel, w: unknown): number | null => (typeof w === 'number' && Number.isFinite(w) ? limit(p, w) : null);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const readLast = (v: unknown): Panel | undefined => (v === 'files' || v === 'inspector' ? v : undefined);

/** A stored layout; anything unreadable falls back to the defaults, widths are clamped to their limits. */
export function parseLayout(raw: string | null): PanelLayout {
  let v: unknown = null;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return emptyLayout();
  }
  if (!isRecord(v)) return emptyLayout();
  const w = isRecord(v.w) ? v.w : {};
  const collapsed = isRecord(v.collapsed) ? v.collapsed : {};
  const l: PanelLayout = { w: { files: readW('files', w.files), inspector: readW('inspector', w.inspector) }, collapsed: { files: collapsed.files === true, inspector: collapsed.inspector === true } };
  const last = readLast(v.last);
  if (last) l.last = last;
  if (typeof v.at === 'number' && Number.isFinite(v.at) && v.at > 0) l.at = Math.round(v.at);
  // An older saved shape also held widths and a box: only its `last` is read.
  if (isRecord(v.wide)) {
    const before = readLast(v.wide.last);
    l.wide = before ? { last: before } : {};
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
