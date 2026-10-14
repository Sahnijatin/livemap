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

export const nodeHeight = (t: Pick<Table, 'fields'>, expanded = false): number =>
  HEADER_H + ROW_H * shownRows(t.fields.length, expanded);

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '44',
  'elk.layered.spacing.nodeNodeBetweenLayers': '104',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '72',
  'elk.aspectRatio': '1.6',
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
 * (parent) table to the referencing one, so parents sit left of their children. Self links are left out.
 */
export function elkGraph(tables: Table[]): ElkNode {
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
    layoutOptions: OPTIONS,
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
 */
export async function layoutTables(tables: Table[], prev: Map<string, Pos>, run: ElkRun): Promise<Map<string, Pos>> {
  const kept = new Map<string, Pos>();
  const fresh: Table[] = [];
  for (const t of tables) {
    const p = prev.get(tableKey(t));
    if (p) kept.set(tableKey(t), p);
    else fresh.push(t);
  }
  const out = settle(tables, kept);
  if (!fresh.length) return out;

  const res = await withTimeout(run(elkGraph(tables)), LAYOUT_TIMEOUT);
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
