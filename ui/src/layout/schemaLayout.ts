import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Table } from '@shared/domain.js';
import { tableKey } from '../store';
import { withTimeout, LAYOUT_TIMEOUT, type ElkRun, type Pos } from './elk';

export { withTimeout, workerRun, LAYOUT_TIMEOUT, type ElkRun, type Pos } from './elk';

/** Card geometry. TableNode's CSS uses the same numbers so handles and layout agree. */
export const NODE_W = 248;
export const HEADER_H = 44;
export const ROW_H = 26;
/** Field rows shown before the "+N more" row. */
export const MAX_ROWS = 12;
/** Free space a new table keeps around existing ones, and its downward step when its spot is taken. */
export const STEP = 24;

export { tableKey };

/** Field rows a card shows: all of them, or 12 plus the "+N more" row. */
export const shownRows = (fields: number, expanded = false): number =>
  expanded || fields <= MAX_ROWS ? fields : MAX_ROWS + 1;

/** Rule rows a card shows (ServiceNow business rules, ACLs, ...) before a "+N more rules" row. */
export const MAX_RULES = 6;

/** Rule rows: a "Rules" heading, up to MAX_RULES rules, and a "+N more rules" row; none without rules. */
export const shownRuleRows = (rules: number): number =>
  rules ? 1 + Math.min(rules, MAX_RULES) + (rules > MAX_RULES ? 1 : 0) : 0;

export const nodeHeight = (t: Pick<Table, 'fields' | 'rules'>, expanded = false): number =>
  HEADER_H + ROW_H * (shownRows(t.fields.length, expanded) + shownRuleRows(t.rules?.length ?? 0));

/** Which way parent tables lead to their children: across a wide pane, down a tall or narrow one. */
export type Direction = 'RIGHT' | 'DOWN';
/** Below this pane width the layout always runs down (phones, a squeezed center pane). */
export const NARROW_PANE = 640;
/** How far past square a pane must go before the layout turns, so a pane near square does not flip back and forth. */
const HYSTERESIS = 1.15;

/**
 * The layout direction for a pane of this size. A pane taller than it is wide, or narrower than
 * `NARROW_PANE`, reads top to bottom; a wide one left to right. An unmeasured pane (0 x 0) keeps
 * `current` (RIGHT at first). With `current`, the aspect must pass square by 15% to turn.
 */
export function layoutDirection(width: number, height: number, current: Direction = 'RIGHT'): Direction {
  if (!(width > 0 && height > 0)) return current;
  if (width < NARROW_PANE) return 'DOWN';
  if (current === 'DOWN') return width > height * HYSTERESIS ? 'RIGHT' : 'DOWN';
  return height > width * HYSTERESIS ? 'DOWN' : 'RIGHT';
}

/** Fit padding, per side: the bottom keeps clear of the caption and zoom buttons over the canvas. */
export const FIT_PADDING = { top: '24px', right: '24px', bottom: '72px', left: '24px' } as const;
/** Most tables for which a fresh layout is tried both ways (each try is one ELK run). */
export const BOTH_WAYS_MAX = 80;

/** The zoom at which `pos` fits a `width` x `height` pane inside `FIT_PADDING`, capped at 1. */
export function fitZoom(tables: Table[], pos: Map<string, Pos>, width: number, height: number): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tables) {
    const p = pos.get(tableKey(t));
    if (!p) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + NODE_W); y1 = Math.max(y1, p.y + nodeHeight(t));
  }
  if (!(x1 > x0) || !(y1 > y0)) return 1;
  const px = (v: string) => Number.parseFloat(v);
  const w = width - px(FIT_PADDING.left) - px(FIT_PADDING.right);
  const h = height - px(FIT_PADDING.top) - px(FIT_PADDING.bottom);
  if (w <= 0 || h <= 0) return 1;
  return Math.min(1, w / (x1 - x0), h / (y1 - y0));
}

/**
 * Of a layout in the pane's direction and one in the other direction, the one that fits larger.
 * The pane's direction keeps ties: the other must fit at least 15% larger to win.
 */
export function pickLayout<T>(preferred: { dir: Direction; zoom: number; value: T }, other: { dir: Direction; zoom: number; value: T }): { dir: Direction; value: T } {
  return other.zoom > preferred.zoom * HYSTERESIS ? other : preferred;
}

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.nodeNodeBetweenLayers': '104',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '72',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};

export interface Link { id: string; from: string; to: string; field: string; many: boolean }

/**
 * One link per relationship between drawn tables. A foreign key column is the link; an ORM relation
 * field is dropped when a foreign key already joins the two tables (Prisma `author` beside `authorId`,
 * or the `profile` side of a one-to-one), and a list back-reference (`User.posts`) is dropped when
 * the other side links back.
 */
export function relationLinks(tables: Table[]): Link[] {
  const keys = new Set(tables.map(tableKey));
  const single = new Set<string>();
  const fk = new Set<string>();
  for (const t of tables) {
    for (const r of t.relations) {
      const pair = `${tableKey(t)}\u0000${r.to.toLowerCase()}`;
      if (!r.many) single.add(pair);
      if (r.via === 'fk') fk.add(pair);
    }
  }
  const out: Link[] = [];
  const ids = new Set<string>();
  for (const t of tables) {
    const from = tableKey(t);
    for (const r of t.relations) {
      const to = r.to.toLowerCase();
      if (!keys.has(to)) continue;
      // An ORM relation field is only a link when no foreign key joins the two tables (either side).
      if (r.via === 'relation' && !r.many && (fk.has(`${from}\u0000${to}`) || fk.has(`${to}\u0000${from}`))) continue;
      if (r.many && from !== to && single.has(`${to}\u0000${from}`)) continue;
      const id = `${from}\u0000${r.field.toLowerCase()}\u0000${to}`;
      if (ids.has(id)) continue;
      ids.add(id);
      out.push({ id, from, to, field: r.field, many: r.many });
    }
  }
  return out;
}

/**
 * The ELK graph for these tables, with one edge per `relationLinks` link. Edges run from the referenced
 * (parent) table to the referencing one, so parents sit left of (RIGHT) or above (DOWN) their children.
 * Unlinked groups pack to the pane's shape: wide for RIGHT, tall for DOWN. Self links are left out.
 */
export function elkGraph(tables: Table[], direction: Direction = 'RIGHT'): ElkNode {
  const edges: ElkExtendedEdge[] = [];
  const seen = new Set<string>();
  for (const l of relationLinks(tables)) {
    if (l.from === l.to) continue;
    const [a, b] = l.many ? [l.from, l.to] : [l.to, l.from];
    const id = `${a}\u0000${b}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id: `e${edges.length}`, sources: [a], targets: [b] });
  }
  return {
    id: 'root',
    layoutOptions: { ...OPTIONS, 'elk.direction': direction, 'elk.aspectRatio': direction === 'DOWN' ? '0.6' : '1.6' },
    children: tables.map(t => ({ id: tableKey(t), width: NODE_W, height: nodeHeight(t) })),
    edges,
  };
}

type Box = { x: number; y: number; w: number; h: number };
/** Within the 24 px gap of each other. */
const hits = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w + STEP && b.x < a.x + a.w + STEP && a.y < b.y + b.h + STEP && b.y < a.y + a.h + STEP;
/** Actually overlapping. */
const covers = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Placed cards after some grew taller (new fields). Going top to bottom, a card that now overlaps a card
 * above it moves down in 24 px steps until it is clear of it by the gap; every other card stays exactly
 * where it is. Moves cascade, so a pushed card can push the one under it.
 */
export function settle(tables: Table[], placed: Map<string, Pos>): Map<string, Pos> {
  const byKey = new Map(tables.map(t => [tableKey(t), t]));
  const order = [...placed].filter(([k]) => byKey.has(k)).sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  const done: Box[] = [];
  const out = new Map<string, Pos>();
  for (const [k, p] of order) {
    const b: Box = { ...p, w: NODE_W, h: nodeHeight(byKey.get(k)!) };
    if (done.some(o => covers(b, o))) while (done.some(o => hits(b, o))) b.y += STEP;
    done.push(b);
    out.set(k, b.x === p.x && b.y === p.y ? p : { x: b.x, y: b.y });
  }
  return out;
}

/**
 * Positions for every table, by `tableKey`.
 * Stability rule: a table in `prev` keeps its position exactly, unless a card above it grew into it
 * (`settle`). A new table takes ELK's position, moved next to an already placed neighbor when it has one
 * (ELK's offset from that neighbor is kept), then shifted down in 24 px steps until it overlaps nothing.
 * ELK runs only when there is a new table, and a run that has not settled in 10 s rejects.
 * `direction` only shapes new placements; a full re-layout in another direction passes an empty `prev`.
 */
export async function layoutTables(tables: Table[], prev: Map<string, Pos>, run: ElkRun, direction: Direction = 'RIGHT'): Promise<Map<string, Pos>> {
  const kept = new Map<string, Pos>();
  const fresh: Table[] = [];
  for (const t of tables) {
    const p = prev.get(tableKey(t));
    if (p) kept.set(tableKey(t), p);
    else fresh.push(t);
  }
  const out = settle(tables, kept);
  if (!fresh.length) return out;

  const res = await withTimeout(run(elkGraph(tables, direction)), LAYOUT_TIMEOUT);
  const elkPos = new Map<string, Pos>();
  for (const c of res.children ?? []) elkPos.set(c.id, { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) });

  const byKey = new Map(tables.map(t => [tableKey(t), t]));
  const boxes: Box[] = [...out].map(([k, p]) => ({ ...p, w: NODE_W, h: nodeHeight(byKey.get(k)!) }));
  for (const t of fresh) {
    const k = tableKey(t);
    const e = elkPos.get(k) ?? { x: 0, y: 0 };
    let p = e;
    if (out.size) {
      // Anchor on a neighbor that already has a position, so the new card appears beside it.
      const anchor = neighbors(t, tables).find(n => out.has(n) && elkPos.has(n));
      if (anchor) {
        const a = out.get(anchor)!;
        const ea = elkPos.get(anchor)!;
        p = { x: a.x + e.x - ea.x, y: a.y + e.y - ea.y };
      }
    }
    const b: Box = { ...p, w: NODE_W, h: nodeHeight(t) };
    // Each step moves the box down, so this ends after at most (boxes x tallest box / STEP) steps.
    while (boxes.some(o => hits(b, o))) b.y += STEP;
    boxes.push(b);
    out.set(k, { x: b.x, y: b.y });
  }
  return out;
}

/** Tables linked to `t` in either direction, outgoing links first. */
function neighbors(t: Table, tables: Table[]): string[] {
  const k = tableKey(t);
  const out = t.relations.map(r => r.to.toLowerCase());
  const inc = tables.filter(o => o.relations.some(r => r.to.toLowerCase() === k)).map(tableKey);
  return [...out, ...inc].filter(n => n !== k);
}
