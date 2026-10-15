import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { withTimeout, LAYOUT_TIMEOUT, type ElkRun, type Pos } from '../layout/elk';
import type { Level, MapFile, MapGraph } from './mapModel';
import { filePins, type Pins } from './pins';

/** File card width and height at the files level. */
export const FILE_W = 220;
export const FILE_H = 64;
/** Each symbol row adds this much to a file card at the functions level. */
export const FN_ROW_H = 24;
export const FOLDER_PAD = 20;
export const FOLDER_HEAD = 44;
/** Space between file cards inside a folder. */
export const GAP = 16;
/** Widest folder grid. A folder's own column count is fixed when it first appears (`folderCols`). */
export const COLS_PER_FOLDER = 3;
/** Folder cards at the folders level. */
export const FOLDER_CARD_W = 250;
export const FOLDER_CARD_H = 120;
/** Space between folders (ELK node spacing, and below a column's last folder). */
export const FOLDER_GAP = 32;
/** Space between linked folders in ELK's left-to-right flow (room for the links to curve). */
export const LAYER_GAP = 56;
/** Space between packed groups of connected folders. */
export const PACK_GAP = 40;
/** The folders level puts its cards on a grid this many px apart (a card plus the gaps ELK leaves). */
export const FOLDER_GRID_X = FOLDER_CARD_W + LAYER_GAP;
export const FOLDER_GRID_Y = FOLDER_CARD_H + FOLDER_GAP;
/** Folder region width for a grid `cols` cards wide. */
export const regionW = (cols: number): number => FOLDER_PAD * 2 + cols * FILE_W + (cols - 1) * GAP;
/** Widest folder region (three columns). */
export const REGION_W = regionW(COLS_PER_FOLDER);
/** Column count for a folder that first appears with `files` files: 1 up to 3 files, 2 up to 8, else 3. */
export const folderCols = (files: number): number => (files <= 3 ? 1 : files <= 8 ? 2 : COLS_PER_FOLDER);
/** The folder graph is packed toward this width-to-height ratio (a wide viewport). */
export const PACK_ASPECT = 1.6;

export type { Pos };
export type Rect = { x: number; y: number; w: number; h: number };
/**
 * One level's layout. `files` are absolute flow positions; `slots` is each file's grid slot in its folder
 * (row-major, `cols` of that folder wide); `cols` is each folder's column count, fixed when the folder
 * first appears so a folder only ever grows downward; `rows` is each folder's row heights, a floor for the
 * next layout so a row never shrinks (the rows below a card that loses symbols do not move up). Slots,
 * cols and rows are what keep files still between layouts, so pass the previous result for the same
 * level back in as `prev`.
 */
export interface Positions {
  folders: Map<string, Rect>; files: Map<string, Pos>; slots: Map<string, number>; cols: Map<string, number>; rows: Map<string, number[]>;
}

export const emptyPositions = (): Positions => ({ folders: new Map(), files: new Map(), slots: new Map(), cols: new Map(), rows: new Map() });

export const fileHeight = (f: Pick<MapFile, 'rows'>, level: Level): number =>
  level === 'functions' ? FILE_H + FN_ROW_H * f.rows.length : FILE_H;

/** [column, row] of a slot index. */
export const slotOf = (s: number, cols = COLS_PER_FOLDER): [number, number] => [s % cols, Math.floor(s / cols)];

const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': String(FOLDER_GAP),
  'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': String(PACK_GAP),
  'elk.aspectRatio': '1.6',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
};
/** Imports per folder that ELK sees (the strongest ones). */
const MAX_FOLDER_EDGES = 3;
/** Columns of the grid used when ELK fails or times out. */
const FALLBACK_COLS = 4;
/** Space between the columns of that fallback grid. */
const FALLBACK_COL_GAP = 96;

type Size = { w: number; h: number };
type Grid = { size: Size; rowTop: number[]; rowH: number[] };

/**
 * Grid slots for every file. A file with a slot in `prev` keeps it. A new file (graph order, so first seen
 * first) takes the free slot nearest the slot of a same-folder file it has an edge with, or else the
 * lowest free slot.
 */
function assignSlots(graph: MapGraph, prev: Map<string, number>, colsOf: Map<string, number>): Map<string, number> {
  const folderOf = new Map<string, string>();
  const byFolder = new Map<string, MapFile[]>();
  for (const f of graph.files) {
    folderOf.set(f.id, f.folder);
    let list = byFolder.get(f.folder);
    if (!list) byFolder.set(f.folder, (list = []));
    list.push(f);
  }
  const partners = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    if (a === b || folderOf.get(a) === undefined || folderOf.get(a) !== folderOf.get(b)) return;
    let l = partners.get(a);
    if (!l) partners.set(a, (l = []));
    l.push(b);
  };
  for (const e of graph.edges) { link(e.source, e.target); link(e.target, e.source); }

  const out = new Map<string, number>();
  for (const [folder, files] of byFolder) {
    const cols = colsOf.get(folder) ?? COLS_PER_FOLDER;
    const used = new Set<number>();
    let max = -1;
    const take = (id: string, s: number) => { out.set(id, s); used.add(s); if (s > max) max = s; };
    for (const f of files) {
      const s = prev.get(f.id);
      if (s !== undefined && Number.isInteger(s) && s >= 0 && !used.has(s)) take(f.id, s);
    }
    for (const f of files) {
      if (out.has(f.id)) continue;
      const partner = partners.get(f.id)?.find(p => out.has(p));
      if (partner === undefined) {
        let s = 0;
        while (used.has(s)) s++;
        take(f.id, s);
        continue;
      }
      const [pc, pr] = slotOf(out.get(partner)!, cols);
      // Every row after the last used one is empty, so nothing past the next row can be nearer.
      const limit = Math.max(max, pr * cols) + 2 * cols;
      let best = -1, bestD = Infinity;
      for (let s = 0; s <= limit; s++) {
        if (used.has(s)) continue;
        const [c, r] = slotOf(s, cols);
        const d = (c - pc) ** 2 + (r - pr) ** 2;
        if (d < bestD) { best = s; bestD = d; }
      }
      take(f.id, best);
    }
  }
  return out;
}

/** Folder sizes and row offsets: rows are as tall as their tallest card, and never shorter than they were (`floors`). */
function grids(graph: MapGraph, slots: Map<string, number>, colsOf: Map<string, number>, floors: Map<string, number[]>): Map<string, Grid> {
  const out = new Map<string, Grid>();
  if (graph.level === 'folders') {
    for (const f of graph.folders) out.set(f.id, { size: { w: FOLDER_CARD_W, h: FOLDER_CARD_H }, rowTop: [], rowH: [] });
    return out;
  }
  const rowH = new Map<string, number[]>();
  for (const f of graph.files) {
    const s = slots.get(f.id);
    if (s === undefined) continue;
    const r = slotOf(s, colsOf.get(f.folder))[1];
    let rows = rowH.get(f.folder);
    if (!rows) rowH.set(f.folder, (rows = []));
    while (rows.length <= r) {
      const floor = floors.get(f.folder)?.[rows.length];
      rows.push(Number.isFinite(floor) && floor! > FILE_H ? floor! : FILE_H);
    }
    rows[r] = Math.max(rows[r], fileHeight(f, graph.level));
  }
  for (const f of graph.folders) {
    const rows = rowH.get(f.id) ?? [];
    const rowTop: number[] = [];
    let y = 0;
    for (const h of rows) { rowTop.push(y); y += h + GAP; }
    out.set(f.id, { size: { w: regionW(colsOf.get(f.id) ?? COLS_PER_FOLDER), h: FOLDER_HEAD + y + FOLDER_PAD * 2 }, rowTop, rowH: rows });
  }
  return out;
}

/**
 * ELK's layered layout of the folder graph (edges are imports between folders, weighted by how many file
 * imports they stand for). Only each folder's `MAX_FOLDER_EDGES` strongest imports go to ELK: they set the
 * left-to-right flow, and a dense folder graph otherwise costs seconds in crossing minimization.
 */
function elkGraph(graph: MapGraph, grid: Map<string, Grid>): ElkNode {
  const ids = new Set(graph.folders.map(f => f.id));
  const folderOf = new Map(graph.files.map(f => [f.id, f.folder]));
  const end = (id: string) => (ids.has(id) ? id : folderOf.get(id));
  const out = new Map<string, Map<string, number>>();
  for (const e of graph.edges) {
    const a = end(e.source), b = end(e.target);
    if (!a || !b || a === b) continue;
    let m = out.get(a);
    if (!m) out.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + e.weight);
  }
  const edges: ElkExtendedEdge[] = [];
  for (const f of graph.folders) {
    const m = out.get(f.id);
    if (!m) continue;
    const strongest = [...m].sort(([x, wx], [y, wy]) => wy - wx || (x < y ? -1 : x > y ? 1 : 0)).slice(0, MAX_FOLDER_EDGES);
    for (const [b] of strongest) edges.push({ id: `e${edges.length}`, sources: [f.id], targets: [b] });
  }
  return {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: graph.folders.map(f => ({ id: f.id, width: grid.get(f.id)!.size.w, height: grid.get(f.id)!.size.h })),
    edges,
  };
}

/** Folders in a plain grid, for when ELK fails or times out. */
function gridPositions(graph: MapGraph, grid: Map<string, Grid>): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const bottoms = new Array<number>(FALLBACK_COLS).fill(0);
  let colW = 0;
  for (const f of graph.folders) colW = Math.max(colW, grid.get(f.id)!.size.w);
  graph.folders.forEach((f, i) => {
    const { h } = grid.get(f.id)!.size;
    const col = i % FALLBACK_COLS;
    out.set(f.id, { x: col * (colW + FALLBACK_COL_GAP), y: bottoms[col] });
    bottoms[col] += h + FOLDER_GAP;
  });
  return out;
}

/**
 * Shelf-packs groups of connected folders (each group moved as one block, keeping ELK's flow inside it)
 * into rows about `PACK_ASPECT` times as wide as the result is tall, largest groups first, so a project
 * of many unrelated folders reads as a grid rather than a column. Deterministic.
 */
export function packGroups(pos: Map<string, Pos>, sizes: Map<string, Size>, links: [string, string][], order: string[]): Map<string, Pos> {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const id of order) if (pos.has(id)) parent.set(id, id);
  for (const [a, b] of links) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  const groups = new Map<string, { ids: string[]; first: number; x1: number; y1: number; x2: number; y2: number }>();
  order.forEach((id, i) => {
    const p = pos.get(id);
    if (!p || !parent.has(id)) return;
    const r = find(id);
    const { w, h } = sizes.get(id)!;
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { ids: [], first: i, x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }));
    g.ids.push(id);
    g.x1 = Math.min(g.x1, p.x); g.y1 = Math.min(g.y1, p.y);
    g.x2 = Math.max(g.x2, p.x + w); g.y2 = Math.max(g.y2, p.y + h);
  });
  const list = [...groups.values()].sort((a, b) =>
    (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1) || a.first - b.first);
  let area = 0, widest = 0;
  for (const g of list) {
    area += (g.x2 - g.x1 + PACK_GAP) * (g.y2 - g.y1 + PACK_GAP);
    widest = Math.max(widest, g.x2 - g.x1);
  }
  const rowW = Math.max(widest, Math.sqrt(area * PACK_ASPECT));
  const out = new Map<string, Pos>();
  let x = 0, y = 0, rowH = 0;
  for (const g of list) {
    const w = g.x2 - g.x1, h = g.y2 - g.y1;
    if (x > 0 && x + w > rowW) { x = 0; y += rowH + PACK_GAP; rowH = 0; }
    for (const id of g.ids) {
      const p = pos.get(id)!;
      out.set(id, { x: Math.round(p.x - g.x1 + x), y: Math.round(p.y - g.y1 + y) });
    }
    x += w + PACK_GAP;
    rowH = Math.max(rowH, h);
  }
  return out;
}

async function suggested(graph: MapGraph, grid: Map<string, Grid>, run: ElkRun, pack: boolean): Promise<Map<string, Pos>> {
  const sizes = new Map<string, Size>();
  for (const f of graph.folders) sizes.set(f.id, grid.get(f.id)!.size);
  const order = graph.folders.map(f => f.id);
  try {
    const g = elkGraph(graph, grid);
    const res = await withTimeout(Promise.resolve().then(() => run(g)), LAYOUT_TIMEOUT);
    const out = new Map<string, Pos>();
    for (const c of res.children ?? []) out.set(c.id, { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) });
    if (!pack) return out;
    const links = (g.edges ?? []).map(e => [e.sources[0], e.targets[0]] as [string, string]);
    return packGroups(out, sizes, links, order);
  } catch {
    const out = gridPositions(graph, grid);
    return pack ? packGroups(out, sizes, [], order) : out;
  }
}

const xOverlap = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w;
/** Overlapping, or closer than half the folder gap. */
const near = (a: Rect, b: Rect): boolean => {
  const m = FOLDER_GAP / 2;
  return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
};
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Below everything that shares columns with `r` (at its x), with the folder gap. */
function columnEnd(r: Rect, placed: Iterable<Rect>): Rect {
  let bottom = -Infinity;
  for (const o of placed) if (xOverlap(o, r)) bottom = Math.max(bottom, o.y + o.h);
  return { ...r, y: bottom === -Infinity ? 0 : bottom + FOLDER_GAP };
}

/** Folder-to-folder link weights (both directions), and which way each runs (`from` imports `to`). */
function folderLinks(graph: MapGraph): { weight: Map<string, Map<string, number>>; imports: Set<string> } {
  const ids = new Set(graph.folders.map(f => f.id));
  const folderOf = new Map(graph.files.map(f => [f.id, f.folder]));
  const end = (id: string) => (ids.has(id) ? id : folderOf.get(id));
  const weight = new Map<string, Map<string, number>>();
  const imports = new Set<string>();
  const add = (a: string, b: string, w: number) => {
    let m = weight.get(a);
    if (!m) weight.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const e of graph.edges) {
    const a = end(e.source), b = end(e.target);
    if (!a || !b || a === b) continue;
    add(a, b, e.weight);
    add(b, a, e.weight);
    imports.add(`${a}\u0000${b}`);
  }
  return { weight, imports };
}

/** Each value's rank among the distinct values (0, 1, 2, ... with no gaps). */
function denseRank(values: number[]): Map<number, number> {
  return new Map([...new Set(values)].sort((a, b) => a - b).map((v, i) => [v, i]));
}

/**
 * Folder cards (all one size) on a regular grid: each goes to the cell nearest its suggested spot, in
 * reading order of those spots; a taken cell (or one next to a pinned card) passes it to the next free
 * cell to the right in that row. Keeps ELK's left-to-right flow, drops its ragged offsets. The k-th
 * distinct rounded row (and column) becomes row k: packed shelves step a little more than a grid row,
 * so rounding alone would skip a row now and then. Deterministic.
 */
function snapFolders(ids: string[], suggestedPos: Map<string, Pos>, size: Size, placed: Map<string, Rect>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const taken = new Set<string>();
  const others = [...placed.values()];
  const order = ids
    .map(id => ({ id, p: suggestedPos.get(id) ?? { x: 0, y: 0 } }))
    .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x || byId(a.id, b.id));
  const rows = denseRank(order.map(o => Math.round(o.p.y / FOLDER_GRID_Y)));
  const cols = denseRank(order.map(o => Math.round(o.p.x / FOLDER_GRID_X)));
  for (const { id, p } of order) {
    const row = rows.get(Math.round(p.y / FOLDER_GRID_Y))!;
    let col = cols.get(Math.round(p.x / FOLDER_GRID_X))!;
    const at = (c: number): Rect => ({ x: c * FOLDER_GRID_X, y: row * FOLDER_GRID_Y, ...size });
    while (taken.has(`${col},${row}`) || others.some(o => near(at(col), o))) col++;
    taken.add(`${col},${row}`);
    out.set(id, at(col));
  }
  return out;
}

/**
 * A folder that appears after the first layout, placed in the packed grid (ELK's coordinates for a later
 * run are not in the packed frame): the free cell next to the placed folder it is most linked with (on the
 * side the flow runs to, else below, else the other side), else the end of that folder's column; with no
 * links, the end of the shortest column (leftmost on a tie).
 */
function placeLate(id: string, size: Size, placed: Map<string, Rect>, links: ReturnType<typeof folderLinks>): Rect {
  const others = [...placed.values()];
  const free = (r: Rect) => !others.some(o => near(r, o));
  const linked = [...(links.weight.get(id) ?? [])].filter(([o]) => placed.has(o)).sort(([x, wx], [y, wy]) => wy - wx || byId(x, y));
  if (linked.length) {
    const [pid] = linked[0];
    const p = placed.get(pid)!;
    const right: Rect = { x: p.x + p.w + LAYER_GAP, y: p.y, ...size };
    const left: Rect = { x: p.x - LAYER_GAP - size.w, y: p.y, ...size };
    const below: Rect = { x: p.x, y: p.y + p.h + FOLDER_GAP, ...size };
    // Imports run left to right: a folder that imports its partner sits to its left.
    const order = links.imports.has(`${id}\u0000${pid}`) && !links.imports.has(`${pid}\u0000${id}`) ? [left, below, right] : [right, below, left];
    return order.find(free) ?? columnEnd(below, others);
  }
  const cols = [...new Set(others.map(o => o.x))].sort((a, b) => a - b);
  let best: Rect | null = null;
  for (const x of cols) {
    const r = columnEnd({ x, y: 0, ...size }, others);
    if (!best || r.y < best.y) best = r;
  }
  return best ?? { x: 0, y: 0, ...size };
}

/**
 * Positions for one level of the map.
 *
 * Folders: a folder in `prev` keeps its place, except that it moves straight down by the growth of a
 * folder above it in its column (the gap between them is kept; shrinking pulls nothing up). ELK runs only
 * for a first layout (packed toward a wide viewport); a folder added later goes next to a folder it is
 * linked with, or to the end of the shortest column (`placeLate`). When ELK fails or times out, a plain
 * grid stands in for its positions.
 *
 * Files: a grid of slots inside their folder (`assignSlots`), as many columns as the folder got when it
 * first appeared (`folderCols`), so a folder grows only downward; a slot never changes.
 * Pins (this level's file pins, and folders at the folders level) override. A pinned file keeps its slot, so its folder
 * still has room for it. Items not in `graph` are dropped. Same inputs give the same output.
 */
export async function placeMap(graph: MapGraph, prev: Positions, pins: Pins, run: ElkRun): Promise<Positions> {
  const level = graph.level;
  // A folder keeps the column count it got when it first appeared.
  const cols = new Map<string, number>();
  if (level !== 'folders') {
    for (const f of graph.folders) {
      const c = prev.cols.get(f.id);
      cols.set(f.id, c !== undefined && Number.isInteger(c) && c >= 1 && c <= COLS_PER_FOLDER ? c : folderCols(f.counts.files));
    }
  }
  const slots = level === 'folders' ? new Map<string, number>() : assignSlots(graph, prev.slots, cols);
  const grid = grids(graph, slots, cols, prev.rows ?? new Map());
  const placed = new Map<string, Rect>();

  // Pinned folder cards (folders level only).
  if (level === 'folders') {
    for (const f of graph.folders) {
      const p = pins.folders[f.id];
      if (p) placed.set(f.id, { x: p.x, y: p.y, ...grid.get(f.id)!.size });
    }
  }

  // Existing folders, top to bottom, pushed down by growth above them.
  const existing = graph.folders
    .filter(f => !placed.has(f.id) && prev.folders.has(f.id))
    .map(f => ({ id: f.id, was: prev.folders.get(f.id)! }))
    .sort((a, b) => a.was.y - b.was.y || a.was.x - b.was.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const settled: { was: Rect; now: Rect }[] = [];
  for (const { id, was } of existing) {
    let y = was.y;
    for (const s of settled) {
      const gap = was.y - (s.was.y + s.was.h);
      if (gap < 0 || !xOverlap(s.was, was)) continue;
      y = Math.max(y, s.now.y + s.now.h + Math.min(gap, FOLDER_GAP));
    }
    const now = { x: was.x, y, ...grid.get(id)!.size };
    settled.push({ was, now });
    placed.set(id, now);
  }

  // New folders.
  const fresh = graph.folders.filter(f => !placed.has(f.id));
  if (fresh.length && existing.length) {
    // After the first layout: next to a linked folder in the packed grid, or at the end of the shortest column.
    const links = folderLinks(graph);
    for (const f of fresh) placed.set(f.id, placeLate(f.id, grid.get(f.id)!.size, placed, links));
  } else if (fresh.length) {
    // A first layout is ELK's, packed toward a wide viewport (pinned folder cards stay where they are).
    const elk = await suggested(graph, grid, run, placed.size === 0);
    if (level === 'folders') {
      for (const [id, r] of snapFolders(fresh.map(f => f.id), elk, { w: FOLDER_CARD_W, h: FOLDER_CARD_H }, placed)) placed.set(id, r);
    }
    for (const f of fresh) {
      if (placed.has(f.id)) continue;
      const size = grid.get(f.id)!.size;
      const e = elk.get(f.id) ?? { x: 0, y: 0 };
      let r: Rect = { x: e.x, y: e.y, ...size };
      const others = [...placed.values()];
      if (others.some(o => near(r, o))) {
        let col = others[0].x;
        for (const o of others) {
          const d = Math.abs(o.x - e.x), best = Math.abs(col - e.x);
          if (d < best || (d === best && o.x < col)) col = o.x;
        }
        r = { x: col, y: 0, ...size };
        let bottom = -Infinity;
        for (const o of others) if (xOverlap(o, r)) bottom = Math.max(bottom, o.y + o.h);
        r.y = bottom + FOLDER_GAP;
      }
      placed.set(f.id, r);
    }
  }

  const folders = new Map<string, Rect>();
  for (const f of graph.folders) folders.set(f.id, placed.get(f.id)!);

  const files = new Map<string, Pos>();
  const outSlots = new Map<string, number>();
  const pinned = filePins(pins, level);
  for (const f of graph.files) {
    const s = slots.get(f.id);
    const r = folders.get(f.folder);
    if (s === undefined || !r) continue;
    outSlots.set(f.id, s);
    const pin = pinned[f.id];
    if (pin) { files.set(f.id, { x: pin.x, y: pin.y }); continue; }
    const [c, row] = slotOf(s, cols.get(f.folder));
    files.set(f.id, {
      x: r.x + FOLDER_PAD + c * (FILE_W + GAP),
      y: r.y + FOLDER_HEAD + FOLDER_PAD + grid.get(f.folder)!.rowTop[row],
    });
  }
  const rows = new Map<string, number[]>();
  if (level !== 'folders') for (const f of graph.folders) rows.set(f.id, grid.get(f.id)!.rowH);
  return { folders, files, slots: outSlots, cols, rows };
}
