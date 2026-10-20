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

export type Bounds = { x0: number; y0: number; x1: number; y1: number };

/** The box around the cards of `keys` that have a position; `height` gives a card's height. */
export function bounds(keys: Iterable<string>, pos: Map<string, Pos>, height: (key: string) => number): Bounds {
  const b: Bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const k of keys) {
    const p = pos.get(k);
    if (!p) continue;
    b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y);
    b.x1 = Math.max(b.x1, p.x + NODE_W); b.y1 = Math.max(b.y1, p.y + height(k));
  }
  return b;
}

/** The zoom at which `pos` fits a `width` x `height` pane inside `FIT_PADDING`, capped at 1. */
export function fitZoom(tables: Table[], pos: Map<string, Pos>, width: number, height: number): number {
  const byKey = new Map(tables.map(t => [tableKey(t), t]));
  const { x0, y0, x1, y1 } = bounds(byKey.keys(), pos, k => nodeHeight(byKey.get(k)!));
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

/** Over this many tables a schema is large: grouped layout, lines between groups only on focus, the table list open. */
export const LARGE = 20;
/** A table linked to this many others is a hub (users, organizations): its links do not join groups. */
export const HUB_DEGREE = 8;
/** Space between groups; wider than ELK's 44 px between cards, so groups read apart. */
const GROUP_GAP = 96;
const CARD_GAP = 44;

/** A large schema's groups, as table keys in table order. */
export interface Groups {
  /** Tables joined by links that do not touch a hub; ELK lays each out. */
  comps: string[][];
  /** Each hub first, then the tables whose only links go to it (or to it and smaller hubs). */
  hubs: string[][];
  /** Tables with no links at all. */
  loose: string[];
}

export function schemaGroups(tables: Table[], links: Link[] = relationLinks(tables)): Groups {
  const index = new Map(tables.map((t, i) => [tableKey(t), i]));
  const nb = new Map<string, Set<string>>(tables.map(t => [tableKey(t), new Set()]));
  for (const l of links) {
    if (l.from === l.to) continue;
    nb.get(l.from)!.add(l.to);
    nb.get(l.to)!.add(l.from);
  }
  const hubs = new Map<string, string[]>();
  for (const [k, s] of nb) if (s.size >= HUB_DEGREE) hubs.set(k, [k]);
  const comps: string[][] = [];
  const loose: string[] = [];
  const seen = new Set<string>();
  for (const k of nb.keys()) {
    if (hubs.has(k) || seen.has(k)) continue;
    const comp: string[] = [];
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const x = stack.pop()!;
      comp.push(x);
      for (const y of nb.get(x)!) if (!hubs.has(y) && !seen.has(y)) { seen.add(y); stack.push(y); }
    }
    if (comp.length > 1) { comps.push(comp.sort((a, b) => index.get(a)! - index.get(b)!)); continue; }
    let hub: string | null = null;
    for (const y of nb.get(k)!) if (hubs.has(y) && (!hub || nb.get(y)!.size > nb.get(hub)!.size)) hub = y;
    if (hub) hubs.get(hub)!.push(k);
    else loose.push(k);
  }
  return { comps, hubs: [...hubs.values()], loose };
}

/** Each grouped table's block: a component's index, or a hub block's (after the components). Loose tables have none. */
function blockOf(g: Groups): Map<string, number> {
  const out = new Map<string, number>();
  [...g.comps, ...g.hubs].forEach((b, i) => { for (const k of b) out.set(k, i); });
  return out;
}

/**
 * The links to draw. A large schema draws the links inside a group (a component, or a hub and its tables) plus
 * every link of the `active` (focused or hovered) table; links leaving a group would cross the whole canvas.
 * `groups` defaults to `schemaGroups(tables, links)`.
 */
export function shownLinks(tables: Table[], links: Link[], active: string | null, groups?: Groups): Link[] {
  if (tables.length <= LARGE) return links;
  const block = blockOf(groups ?? schemaGroups(tables, links));
  return links.filter(l => l.from === active || l.to === active || (block.has(l.from) && block.get(l.from) === block.get(l.to)));
}

/** The group a first view shows: the biggest component or hub block, or the loose tables when nothing is linked. */
export function mainGroup(g: Groups): string[] {
  const linked = [...g.comps, ...g.hubs];
  return linked.length ? linked.reduce((a, b) => (b.length > a.length ? b : a)) : g.loose;
}

type Block = { w: number; h: number; pos: Map<string, Pos> };

/** Cards in `cols` columns, each card going to the shortest column. */
function masonry(tables: Table[]): Block {
  const cols = Math.ceil(Math.sqrt(tables.length));
  const y = new Array<number>(cols).fill(0);
  const pos = new Map<string, Pos>();
  for (const t of tables) {
    const c = y.indexOf(Math.min(...y));
    pos.set(tableKey(t), { x: c * (NODE_W + CARD_GAP), y: y[c] });
    y[c] += nodeHeight(t) + CARD_GAP;
  }
  return { w: Math.min(cols, tables.length) * (NODE_W + CARD_GAP) - CARD_GAP, h: Math.max(...y) - CARD_GAP, pos };
}

/**
 * Positions for a large schema: one ELK run over the linked components, hub groups and loose tables in compact
 * grids, then every group packed in rows, tallest first, to the direction's aspect (wide for RIGHT, tall for DOWN).
 */
async function groupedLayout(tables: Table[], g: Groups, run: ElkRun, direction: Direction): Promise<Map<string, Pos>> {
  const byKey = new Map(tables.map(t => [tableKey(t), t]));
  const blocks: Block[] = [];
  if (g.comps.length) {
    const res = await run(elkGraph(g.comps.flat().map(k => byKey.get(k)!), direction));
    const elk = new Map((res.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
    for (const comp of g.comps) {
      for (const k of comp) if (!elk.has(k)) elk.set(k, { x: 0, y: 0 });
      const { x0, y0, x1, y1 } = bounds(comp, elk, k => nodeHeight(byKey.get(k)!));
      const pos = new Map(comp.map(k => [k, { x: elk.get(k)!.x - x0, y: elk.get(k)!.y - y0 }]));
      blocks.push({ w: x1 - x0, h: y1 - y0, pos });
    }
  }
  for (const keys of [...g.hubs, g.loose]) if (keys.length) blocks.push(masonry(keys.map(k => byKey.get(k)!)));
  const area = blocks.reduce((s, b) => s + (b.w + GROUP_GAP) * (b.h + GROUP_GAP), 0);
  const width = Math.max(...blocks.map(b => b.w), Math.sqrt(area * (direction === 'DOWN' ? 0.6 : 1.6)));
  blocks.sort((a, b) => b.h - a.h);
  const out = new Map<string, Pos>();
  let x = 0, y = 0, rowH = 0;
  for (const b of blocks) {
    if (x > 0 && x + b.w > width) { x = 0; y += rowH + GROUP_GAP; rowH = 0; }
    for (const [k, p] of b.pos) out.set(k, { x: x + p.x, y: y + p.y });
    x += b.w + GROUP_GAP;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/** Positions for every table from scratch: one ELK run for a small schema, the grouped layout (of `groups`) for a large one. */
async function placeAll(tables: Table[], groups: Groups | null, run: ElkRun, direction: Direction): Promise<Map<string, Pos>> {
  if (groups) return groupedLayout(tables, groups, run, direction);
  const res = await run(elkGraph(tables, direction));
  return new Map((res.children ?? []).map(c => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
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
 * (ELK's offset from that neighbor is kept), then shifted down in 24 px steps until it overlaps nothing. In a large
 * schema the anchor is a placed table of the new one's own group: a non-hub neighbor first, then its hub, then any.
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

  const groups = tables.length > LARGE ? schemaGroups(tables) : null;
  const placed = await withTimeout(placeAll(tables, groups, run, direction), LAYOUT_TIMEOUT);
  const elkPos = new Map<string, Pos>();
  for (const [k, p] of placed) elkPos.set(k, { x: Math.round(p.x), y: Math.round(p.y) });

  const byKey = new Map(tables.map(t => [tableKey(t), t]));
  const boxes: Box[] = [...out].map(([k, p]) => ({ ...p, w: NODE_W, h: nodeHeight(byKey.get(k)!) }));
  for (const t of fresh) {
    const k = tableKey(t);
    const e = elkPos.get(k) ?? { x: 0, y: 0 };
    let p = e;
    if (out.size) {
      // Anchor on a neighbor that already has a position, so the new card appears beside it.
      const anchor = anchors(t, tables, groups).find(n => out.has(n) && elkPos.has(n));
      if (anchor) {
        const a = out.get(anchor)!;
        const ea = elkPos.get(anchor)!;
        p = { x: a.x + e.x - ea.x, y: a.y + e.y - ea.y };
      }
    }
    let b: Box = { ...p, w: NODE_W, h: nodeHeight(t) };
    // A packed large schema takes the free spot nearest its anchor, so the card stays with its group.
    if (groups && out.size) b = nearestFree(b, boxes) ?? b;
    // Each step moves the box down, so this ends after at most (boxes x tallest box / STEP) steps.
    while (boxes.some(o => hits(b, o))) b.y += STEP;
    boxes.push(b);
    out.set(k, { x: b.x, y: b.y });
  }
  return out;
}

/** Offsets to try around a new card, nearest first: 24 px steps up or down, in its column or two either side. */
const OFFSETS: Pos[] = Array.from({ length: 5 * 161 }, (_, i) => ({ x: (Math.floor(i / 161) - 2) * (NODE_W + CARD_GAP), y: ((i % 161) - 80) * STEP }))
  .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));

/** The free spot nearest `b`, or null when every offset is taken. */
function nearestFree(b: Box, boxes: Box[]): Box | null {
  for (const o of OFFSETS) {
    const c: Box = { ...b, x: b.x + o.x, y: b.y + o.y };
    if (!boxes.some(x => hits(c, x))) return c;
  }
  return null;
}

/** Tables linked to `t` in either direction, outgoing links first. */
function neighbors(t: Table, tables: Table[]): string[] {
  const k = tableKey(t);
  const out = t.relations.map(r => r.to.toLowerCase());
  const inc = tables.filter(o => o.relations.some(r => r.to.toLowerCase() === k)).map(tableKey);
  return [...out, ...inc].filter(n => n !== k);
}

/**
 * Tables a new card may anchor on, best first: its neighbors, or with `groups` (a large schema) the tables of its own
 * group, non-hub neighbors first, then its hub, then the rest of the group.
 */
function anchors(t: Table, tables: Table[], groups: Groups | null): string[] {
  const near = neighbors(t, tables);
  if (!groups) return near;
  const k = tableKey(t);
  const block = [...groups.comps, ...groups.hubs, groups.loose].find(b => b.includes(k)) ?? [];
  const hubs = new Set(groups.hubs.map(b => b[0]));
  const mates = new Set(block);
  const own = near.filter(n => mates.has(n));
  return [...own.filter(n => !hubs.has(n)), ...own.filter(n => hubs.has(n)), ...block.filter(n => n !== k)];
}
