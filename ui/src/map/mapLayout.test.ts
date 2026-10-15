import { describe, it, expect, vi, afterEach } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { MapEdge, MapFile, MapFolder, MapGraph, Level } from './mapModel';
import {
  placeMap, emptyPositions, fileHeight, slotOf, folderCols, regionW, packGroups,
  FILE_W, FILE_H, FOLDER_PAD, FOLDER_HEAD, FOLDER_GAP, GAP, COLS_PER_FOLDER, FOLDER_CARD_W, FOLDER_CARD_H, LAYER_GAP, FOLDER_GRID_X, FOLDER_GRID_Y,
  type Positions, type Rect,
} from './mapLayout';
import { LAYOUT_TIMEOUT, type ElkRun } from '../layout/elk';
import { filePins, type Pins } from './pins';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const elk = new ELK();
const run: ElkRun = g => elk.layout(g);
const noPins = (): Pins => ({ files: {}, functions: {}, folders: {} });

const dirId = (d: string) => `dir:${d}`;

/** A map graph from `{ folder: [file names] }` and file-level import pairs `[from, to]`. */
function graph(level: Level, spec: Record<string, string[]>, imports: [string, string][] = [], rows: Record<string, number> = {}): MapGraph {
  const folders: MapFolder[] = Object.keys(spec).sort().map(d => ({
    id: dirId(d), path: d, label: d, layer: 'core', files: spec[d].map(n => `${d}/${n}`),
    counts: { files: spec[d].length, symbols: 0, routes: 0, tables: 0 }, isNew: false,
  }));
  const folderOf = new Map<string, string>();
  for (const f of folders) for (const p of f.files) folderOf.set(p, f.id);
  if (level === 'folders') {
    const agg = new Map<string, MapEdge>();
    for (const [a, b] of imports) {
      const s = folderOf.get(a)!, t = folderOf.get(b)!;
      if (s === t) continue;
      const id = `${s}->${t}`;
      if (!agg.has(id)) agg.set(id, { id, source: s, target: t, weight: 1, isNew: false });
    }
    return { level, folders, files: [], edges: [...agg.values()].sort((x, y) => (x.id < y.id ? -1 : 1)), large: false };
  }
  const files: MapFile[] = [];
  for (const f of folders) for (const p of [...f.files].sort()) {
    files.push({
      id: p, folder: f.id, label: p, layer: 'core', symbols: 0,
      rows: Array.from({ length: rows[p] ?? 0 }, (_, i) => ({ name: `s${i}`, kind: 'function' as const })),
      isNew: false, isLive: false, isFlagged: false,
    });
  }
  files.sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges: MapEdge[] = imports.map(([a, b]) => ({ id: `${a}->${b}`, source: a, target: b, weight: 1, isNew: false }));
  edges.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { level, folders, files, edges, large: false };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fileRect = (g: MapGraph, pos: Positions, id: string): Rect => {
  const f = g.files.find(x => x.id === id)!;
  const p = pos.files.get(id)!;
  return { x: p.x, y: p.y, w: FILE_W, h: fileHeight(f, g.level) };
};

function expectSound(g: MapGraph, pos: Positions, pins: Pins = noPins()) {
  const folders = [...pos.folders.entries()];
  expect(folders.map(([k]) => k).sort()).toEqual(g.folders.map(f => f.id).sort());
  for (let i = 0; i < folders.length; i++)
    for (let j = i + 1; j < folders.length; j++)
      expect(overlaps(folders[i][1], folders[j][1]), `${folders[i][0]} overlaps ${folders[j][0]}`).toBe(false);
  if (g.level === 'folders') { expect(pos.files.size).toBe(0); return; }
  expect([...pos.files.keys()].sort()).toEqual(g.files.map(f => f.id).sort());
  const unpinned = g.files.filter(f => !filePins(pins, g.level)[f.id]);
  for (const f of unpinned) {
    const r = fileRect(g, pos, f.id);
    const fr = pos.folders.get(f.folder)!;
    expect(r.x >= fr.x && r.y >= fr.y && r.x + r.w <= fr.x + fr.w && r.y + r.h <= fr.y + fr.h, `${f.id} outside its folder`).toBe(true);
  }
  for (let i = 0; i < unpinned.length; i++)
    for (let j = i + 1; j < unpinned.length; j++)
      expect(overlaps(fileRect(g, pos, unpinned[i].id), fileRect(g, pos, unpinned[j].id)), `${unpinned[i].id} overlaps ${unpinned[j].id}`).toBe(false);
}

/** api imports lib and ui, so layered RIGHT stacks lib and ui in the second column. */
const base = () => graph('files', { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts'], ui: ['e.ts', 'f.ts'] },
  [['api/a.ts', 'lib/c.ts'], ['api/b.ts', 'ui/e.ts'], ['ui/f.ts', 'ui/e.ts']]);

describe('geometry', () => {
  it('uses the brief constants', () => {
    expect([FILE_W, FILE_H, FOLDER_PAD, FOLDER_HEAD, GAP, COLS_PER_FOLDER, FOLDER_CARD_W, FOLDER_CARD_H])
      .toEqual([220, 64, 20, 44, 16, 3, 250, 120]);
  });
  it('file cards are 64 px at the files level and 64 + 24 per row at the functions level', () => {
    const g = graph('functions', { a: ['x.ts'] }, [], { 'a/x.ts': 5 });
    expect(fileHeight(g.files[0], 'files')).toBe(64);
    expect(fileHeight(g.files[0], 'functions')).toBe(64 + 24 * 5);
  });
});

describe('placeMap: first layout', () => {
  it('places 3 folders and 6 files with no overlaps and every file inside its folder', async () => {
    const g = base();
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    // Two files: a one-column folder, as wide as one card plus padding, two rows tall.
    const w = FOLDER_PAD * 2 + FILE_W;
    for (const r of pos.folders.values()) {
      expect(r.w).toBe(w);
      expect(r.h).toBe(FOLDER_HEAD + 2 * (FILE_H + GAP) + FOLDER_PAD * 2);
    }
    for (const id of pos.folders.keys()) expect(pos.cols.get(id)).toBe(1);
    // Files fill the grid in first-seen order: slots 0 and 1, one below the other.
    const api = pos.folders.get('dir:api')!;
    expect(pos.files.get('api/a.ts')).toEqual({ x: api.x + FOLDER_PAD, y: api.y + FOLDER_HEAD + FOLDER_PAD });
    expect(pos.files.get('api/b.ts')).toEqual({ x: api.x + FOLDER_PAD, y: api.y + FOLDER_HEAD + FOLDER_PAD + FILE_H + GAP });
  });

  it('is deterministic and idempotent: same inputs give the same output, and a relayout moves nothing', async () => {
    const g = base();
    const a = await placeMap(g, emptyPositions(), noPins(), run);
    const b = await placeMap(g, emptyPositions(), noPins(), run);
    expect(b).toEqual(a);
    const c = await placeMap(g, a, noPins(), () => { throw new Error('ELK must not run'); });
    expect(c).toEqual(a);
  });

  it('folders level: 250 x 120 cards, no files', async () => {
    const g = graph('folders', { api: ['a.ts'], lib: ['c.ts'], ui: ['e.ts'] }, [['api/a.ts', 'lib/c.ts'], ['api/a.ts', 'ui/e.ts']]);
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    for (const r of pos.folders.values()) expect([r.w, r.h]).toEqual([250, 120]);
    // ELK layered RIGHT: api is left of what it imports.
    expect(pos.folders.get('dir:api')!.x).toBeLessThan(pos.folders.get('dir:lib')!.x);
  });

  it('folders level: cards sit on a regular grid of rows and columns (F12)', async () => {
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) spec[`f${i}`] = ['1.ts'];
    const g = graph('folders', spec, [['f0/1.ts', 'f1/1.ts'], ['f1/1.ts', 'f2/1.ts'], ['f0/1.ts', 'f3/1.ts'], ['f4/1.ts', 'f5/1.ts']]);
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    expect([FOLDER_GRID_X, FOLDER_GRID_Y]).toEqual([FOLDER_CARD_W + LAYER_GAP, FOLDER_CARD_H + FOLDER_GAP]);
    for (const [id, r] of pos.folders) {
      expect(r.x % FOLDER_GRID_X, `${id} x on the grid`).toBe(0);
      expect(r.y % FOLDER_GRID_Y, `${id} y on the grid`).toBe(0);
    }
    // Still the import flow: f0 is left of what it imports.
    expect(pos.folders.get('dir:f0')!.x).toBeLessThan(pos.folders.get('dir:f1')!.x);
    expect(await placeMap(g, emptyPositions(), noPins(), run)).toEqual(pos);
  });

  it('folders level: a large layout leaves no empty row or column (#15)', async () => {
    // 120 unlinked folders pack into shelves 160 px apart (card plus PACK_GAP), more than the 152 px grid
    // row: rounding alone skipped a row after ten shelves.
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 120; i++) spec[`f${String(i).padStart(3, '0')}`] = ['1.ts'];
    const g = graph('folders', spec);
    const column: ElkRun = async gr => ({ ...gr, children: gr.children!.map((c, i) => ({ ...c, x: 0, y: i * 160 })) });
    const pos = await placeMap(g, emptyPositions(), noPins(), column);
    expectSound(g, pos);
    const rows = new Set<number>(), cols = new Set<number>();
    for (const [id, r] of pos.folders) {
      expect(r.y % FOLDER_GRID_Y, `${id} y on the grid`).toBe(0);
      expect(r.x % FOLDER_GRID_X, `${id} x on the grid`).toBe(0);
      rows.add(r.y / FOLDER_GRID_Y);
      cols.add(r.x / FOLDER_GRID_X);
    }
    expect([...rows].sort((a, b) => a - b)).toEqual([...Array(rows.size).keys()]);
    expect([...cols].sort((a, b) => a - b)).toEqual([...Array(cols.size).keys()]);
    expect(rows.size).toBeGreaterThan(10);
  });

  it('functions level: rows are as tall as their tallest card and the folder sizes to them', async () => {
    const g = graph('functions', { a: ['1.ts', '2.ts', '3.ts', '4.ts'] }, [], { 'a/2.ts': 3, 'a/4.ts': 1 });
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    const r = pos.folders.get('dir:a')!;
    const row0 = 64 + 24 * 3, row1 = 64 + 24;
    expect(r.h).toBe(FOLDER_HEAD + row0 + GAP + row1 + GAP + FOLDER_PAD * 2);
    expect(pos.files.get('a/4.ts')!.y).toBe(r.y + FOLDER_HEAD + FOLDER_PAD + row0 + GAP);
  });
  it('functions level: a row below a card that shrinks does not move up (push-down only) (F14)', async () => {
    const g0 = graph('functions', { a: ['1.ts', '2.ts', '3.ts', '4.ts'] }, [], { 'a/1.ts': 5, 'a/4.ts': 1 });
    const first = await placeMap(g0, emptyPositions(), noPins(), run);
    // 1.ts loses four symbols: its row keeps its height, so 3.ts and 4.ts (row 1) stay put.
    const g1 = graph('functions', { a: ['1.ts', '2.ts', '3.ts', '4.ts'] }, [], { 'a/1.ts': 1, 'a/4.ts': 1 });
    const second = await placeMap(g1, first, noPins(), run);
    expectSound(g1, second);
    for (const id of ['a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts']) expect(second.files.get(id)).toEqual(first.files.get(id));
    expect(second.folders.get('dir:a')).toEqual(first.folders.get('dir:a'));
    // A row that grows still pushes the rows below it down.
    const g2 = graph('functions', { a: ['1.ts', '2.ts', '3.ts', '4.ts'] }, [], { 'a/1.ts': 8, 'a/4.ts': 1 });
    const third = await placeMap(g2, second, noPins(), run);
    expect(third.files.get('a/3.ts')!.y).toBe(second.files.get('a/3.ts')!.y + 3 * 24);
  });
});

describe('placeMap: stability (Review Focus 1)', () => {
  it('40 new files keep every existing file in place or straight below it, each next to its import partner', async () => {
    const g0 = base();
    const first = await placeMap(g0, emptyPositions(), noPins(), run);
    // lib and ui share ELK's second column, so growth of the upper one pushes the lower one down.
    const libR = first.folders.get('dir:lib')!, uiR = first.folders.get('dir:ui')!;
    expect(libR.x).toBe(uiR.x);
    const upper = libR.y < uiR.y ? 'lib' : 'ui';
    const lower = upper === 'lib' ? 'ui' : 'lib';

    const spec = { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts'], ui: ['e.ts', 'f.ts'] } as Record<string, string[]>;
    const imports: [string, string][] = [['api/a.ts', 'lib/c.ts'], ['api/b.ts', 'ui/e.ts'], ['ui/f.ts', 'ui/e.ts']];
    const partner = new Map<string, string>();
    const olds = { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts'], ui: ['e.ts', 'f.ts'] } as Record<string, string[]>;
    for (let i = 0; i < 40; i++) {
      // Most go to the upper folder of the shared column; every file imports an existing one in its folder.
      const d = i < 24 ? upper : i < 32 ? 'api' : lower;
      const name = `n${String(i).padStart(2, '0')}.ts`;
      spec[d] = [...spec[d], name];
      const p = `${d}/${olds[d][i % olds[d].length]}`;
      imports.push([`${d}/${name}`, p]);
      partner.set(`${d}/${name}`, p);
    }
    const g1 = graph('files', spec, imports);
    const second = await placeMap(g1, first, noPins(), () => { throw new Error('ELK must not run for new files'); });
    expectSound(g1, second);

    for (const f of g0.files) {
      const a = first.files.get(f.id)!, b = second.files.get(f.id)!;
      expect(b.x, f.id).toBe(a.x);
      expect(b.y, f.id).toBeGreaterThanOrEqual(a.y);
    }
    for (const id of first.folders.keys()) {
      expect(second.folders.get(id)!.x).toBe(first.folders.get(id)!.x);
      expect(second.folders.get(id)!.y).toBeGreaterThanOrEqual(first.folders.get(id)!.y);
    }
    // The lower folder was pushed down by exactly the upper folder's growth.
    const growth = second.folders.get(dirId(upper))!.h - first.folders.get(dirId(upper))!.h;
    expect(growth).toBeGreaterThan(0);
    expect(second.folders.get(dirId(lower))!.y - first.folders.get(dirId(lower))!.y).toBe(growth);

    // Next to the partner whenever the partner still had a free neighbor slot.
    const occupied = new Map<string, Set<number>>();
    for (const f of g1.files) {
      const s = second.slots.get(f.id)!;
      if (!occupied.has(f.folder)) occupied.set(f.folder, new Set());
      occupied.get(f.folder)!.add(s);
    }
    for (const [id, p] of partner) {
      const folder = g1.files.find(f => f.id === id)!.folder;
      const cols = second.cols.get(folder)!;
      const [c, r] = slotOf(second.slots.get(id)!, cols), [pc, pr] = slotOf(second.slots.get(p)!, cols);
      if (Math.abs(c - pc) <= 1 && Math.abs(r - pr) <= 1) continue;
      const occ = occupied.get(folder)!;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = pc + dc, nr = pr + dr;
        if (nc < 0 || nc >= cols || nr < 0 || (dc === 0 && dr === 0)) continue;
        expect(occ.has(nr * cols + nc), `${id} skipped a free slot next to ${p}`).toBe(true);
      }
    }
    // (These folders started with two files, so they are one column wide; a new file lands next to its
    // partner whenever a neighbor slot is free, as checked above.)
  });

  it('a new folder needs no ELK run and moves no existing folder; removing it moves nothing either', async () => {
    const g0 = base();
    const first = await placeMap(g0, emptyPositions(), noPins(), run);
    let calls = 0;
    const counting: ElkRun = g => { calls++; return run(g); };
    const g1 = graph('files', { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts'], ui: ['e.ts', 'f.ts'], db: ['g.ts', 'h.ts'] },
      [['api/a.ts', 'lib/c.ts'], ['api/b.ts', 'ui/e.ts'], ['ui/f.ts', 'ui/e.ts'], ['lib/d.ts', 'db/g.ts']]);
    const second = await placeMap(g1, first, noPins(), counting);
    expect(calls).toBe(0);
    expectSound(g1, second);
    for (const [id, r] of first.folders) expect(second.folders.get(id)).toEqual(r);
    for (const [id, p] of first.files) expect(second.files.get(id)).toEqual(p);
    // Removing it again: dropped from the result, nothing else moves.
    const third = await placeMap(g0, second, noPins(), counting);
    expect(calls).toBe(0);
    expect(third.folders.has('dir:db')).toBe(false);
    expect(third.files.has('db/g.ts')).toBe(false);
    expect(third.slots.has('db/g.ts')).toBe(false);
    expect(third.folders).toEqual(first.folders);
    expect(third.files).toEqual(first.files);
  });

  it('a new folder goes to the free cell next to a folder it is linked with, in the packed grid (F13)', async () => {
    // A packed row: a | b, both one card wide.
    const prev: Positions = {
      folders: new Map([['dir:a', { x: 0, y: 0, w: 250, h: 120 }], ['dir:b', { x: 290, y: 0, w: 250, h: 120 }]]),
      files: new Map(), slots: new Map(), cols: new Map(), rows: new Map(),
    };
    const never: ElkRun = () => { throw new Error('ELK must not run'); };
    // b imports c: c goes right of b (the flow runs left to right).
    const g1 = graph('folders', { a: ['1.ts'], b: ['1.ts'], c: ['1.ts'] }, [['b/1.ts', 'c/1.ts']]);
    const pos = await placeMap(g1, prev, noPins(), never);
    expect(pos.folders.get('dir:a')).toEqual({ x: 0, y: 0, w: 250, h: 120 });
    expect(pos.folders.get('dir:b')).toEqual({ x: 290, y: 0, w: 250, h: 120 });
    expect(pos.folders.get('dir:c')).toEqual({ x: 290 + 250 + LAYER_GAP, y: 0, w: 250, h: 120 });
    // a imports d, but b holds the cell right of a: d goes below a.
    const g2 = graph('folders', { a: ['1.ts'], b: ['1.ts'], d: ['1.ts'] }, [['a/1.ts', 'd/1.ts']]);
    const pos2 = await placeMap(g2, prev, noPins(), never);
    expect(pos2.folders.get('dir:d')).toEqual({ x: 0, y: 120 + FOLDER_GAP, w: 250, h: 120 });
  });

  it('a new folder with no links goes to the end of the shortest column (F13)', async () => {
    // Three packed columns: a over a2, b alone, c over c2.
    const prev: Positions = {
      folders: new Map([
        ['dir:a', { x: 0, y: 0, w: 250, h: 120 }], ['dir:a2', { x: 0, y: 152, w: 250, h: 120 }],
        ['dir:b', { x: 290, y: 0, w: 250, h: 120 }],
        ['dir:c', { x: 580, y: 0, w: 250, h: 120 }], ['dir:c2', { x: 580, y: 152, w: 250, h: 120 }],
      ]),
      files: new Map(), slots: new Map(), cols: new Map(), rows: new Map(),
    };
    const g1 = graph('folders', { a: ['1.ts'], a2: ['1.ts'], b: ['1.ts'], c: ['1.ts'], c2: ['1.ts'], e: ['1.ts'], f: ['1.ts'] });
    const pos = await placeMap(g1, prev, noPins(), () => { throw new Error('ELK must not run'); });
    expect(pos.folders.get('dir:e')).toEqual({ x: 290, y: 120 + FOLDER_GAP, w: 250, h: 120 });
    // Then every column ends at 272: the leftmost wins.
    expect(pos.folders.get('dir:f')).toEqual({ x: 0, y: 272 + FOLDER_GAP, w: 250, h: 120 });
    expectSound(g1, pos);
  });
});

describe('placeMap: folder columns and packing', () => {
  it('a folder gets 1, 2 or 3 columns from its first file count and keeps them as it grows', async () => {
    expect([1, 3, 4, 8, 9, 40].map(folderCols)).toEqual([1, 1, 2, 2, 3, 3]);
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}.ts`);
    const g0 = graph('files', { small: names(2), mid: names(5), big: names(9) });
    const first = await placeMap(g0, emptyPositions(), noPins(), run);
    expect(first.cols.get('dir:small')).toBe(1);
    expect(first.cols.get('dir:mid')).toBe(2);
    expect(first.cols.get('dir:big')).toBe(COLS_PER_FOLDER);
    expect(first.folders.get('dir:mid')!.w).toBe(regionW(2));
    // Twelve more files in the small folder: still one column, same width and place; it only grows down.
    const g1 = graph('files', { small: names(14), mid: names(5), big: names(9) });
    const second = await placeMap(g1, first, noPins(), () => { throw new Error('ELK must not run'); });
    expectSound(g1, second);
    expect(second.cols.get('dir:small')).toBe(1);
    const a = first.folders.get('dir:small')!, b = second.folders.get('dir:small')!;
    expect([b.x, b.y, b.w]).toEqual([a.x, a.y, a.w]);
    expect(b.h).toBeGreaterThan(a.h);
    for (const id of g0.files.map(f => f.id)) expect(second.files.get(id)!.x).toBe(first.files.get(id)!.x);
    for (const id of g1.files.filter(f => f.folder === 'dir:small').map(f => f.id)) {
      expect(second.files.get(id)!.x).toBe(b.x + FOLDER_PAD);
    }
  });

  it('packs ten unrelated folders into a wide grid, not a column', async () => {
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) spec[`f${i}`] = Array.from({ length: 1 + (i % 4) }, (_, j) => `${j}.ts`);
    const g = graph('files', spec);
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of pos.folders.values()) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
    const ratio = (x2 - x1) / (y2 - y1);
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(3);
  });

  it('packs a 13-file, 10-folder project tightly enough to read most of it at zoom 0.85', async () => {
    const g = graph('files', {
      'apps/api/src': ['db.ts', 'index.ts'], 'apps/api/src/routes': ['orders.ts'], 'apps/api/src/services': ['orderService.ts'],
      'db/migrations': ['001.sql', '002.sql'], 'services/ml/routers': ['__init__.py', 'predict.py'], 'services/ml': ['main.py'],
      'apps/web/app': ['page.tsx'], 'apps/web/app/api/health': ['route.ts'], 'apps/web/app/orders': ['page.tsx'], prisma: ['schema.prisma'],
    }, [
      ['apps/api/src/index.ts', 'apps/api/src/routes/orders.ts'], ['apps/api/src/routes/orders.ts', 'apps/api/src/services/orderService.ts'],
      ['apps/api/src/services/orderService.ts', 'apps/api/src/db.ts'], ['services/ml/main.py', 'services/ml/routers/predict.py'],
    ]);
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expectSound(g, pos);
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of pos.folders.values()) { x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
    // Was 972 x 1033 with the looser gaps; a 1440 px center pane shows about 860 x 810 flow px at 0.85.
    expect(x2 - x1).toBeLessThanOrEqual(900);
    expect(y2 - y1).toBeLessThanOrEqual(950);
  });

  it('packGroups moves connected folders together and keeps their relative placement', () => {
    const pos = new Map([['a', { x: 0, y: 0 }], ['b', { x: 400, y: 0 }], ['c', { x: 0, y: 900 }]]);
    const sizes = new Map([['a', { w: 260, h: 200 }], ['b', { w: 260, h: 200 }], ['c', { w: 260, h: 200 }]]);
    const out = packGroups(pos, sizes, [['a', 'b']], ['a', 'b', 'c']);
    expect(out.get('b')!.x - out.get('a')!.x).toBe(400);
    expect(out.get('b')!.y - out.get('a')!.y).toBe(0);
    // c is no longer far below: it sits in the same row band as the a-b group.
    expect(out.get('c')!.y).toBeLessThan(300);
    expect(packGroups(pos, sizes, [['a', 'b']], ['a', 'b', 'c'])).toEqual(out);
  });
});

describe('placeMap: pins (Review Focus 2)', () => {
  it('a pinned file stays at its pin through a relayout that adds neighbors', async () => {
    const g0 = base();
    const pins: Pins = { files: { 'lib/c.ts': { x: -500, y: 1234 } }, functions: {}, folders: {} };
    const first = await placeMap(g0, emptyPositions(), pins, run);
    expect(first.files.get('lib/c.ts')).toEqual({ x: -500, y: 1234 });
    expectSound(g0, first, pins);
    const g1 = graph('files', { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts', 'x.ts', 'y.ts', 'z.ts'], ui: ['e.ts', 'f.ts'], db: ['q.ts'] },
      [['api/a.ts', 'lib/c.ts'], ['api/b.ts', 'ui/e.ts'], ['ui/f.ts', 'ui/e.ts'], ['lib/x.ts', 'lib/c.ts'], ['lib/y.ts', 'lib/c.ts'], ['lib/z.ts', 'lib/c.ts'], ['db/q.ts', 'lib/c.ts']]);
    const second = await placeMap(g1, first, pins, run);
    expect(second.files.get('lib/c.ts')).toEqual({ x: -500, y: 1234 });
    expectSound(g1, second, pins);
    // It keeps its slot, so no neighbor takes it.
    expect(second.slots.get('lib/c.ts')).toBe(first.slots.get('lib/c.ts'));
    expect([...second.slots].filter(([id, s]) => id.startsWith('lib/') && s === second.slots.get('lib/c.ts'))).toHaveLength(1);
  });

  it('pins override folders at the folders level only', async () => {
    const pins: Pins = { files: {}, functions: {}, folders: { 'dir:api': { x: 7, y: -900 } } };
    const gf = graph('folders', { api: ['a.ts'], lib: ['c.ts'] }, [['api/a.ts', 'lib/c.ts']]);
    const pos = await placeMap(gf, emptyPositions(), pins, run);
    expect(pos.folders.get('dir:api')).toEqual({ x: 7, y: -900, w: 250, h: 120 });
    const g = graph('files', { api: ['a.ts'], lib: ['c.ts'] }, [['api/a.ts', 'lib/c.ts']]);
    const files = await placeMap(g, emptyPositions(), pins, run);
    expect(files.folders.get('dir:api')).not.toMatchObject({ x: 7, y: -900 });
  });
});

describe('placeMap: pins per level (F11)', () => {
  it('a file pinned at the files level is not pinned at the functions level, and the other way round', async () => {
    const pins: Pins = { files: { 'lib/c.ts': { x: -500, y: 1234 } }, functions: { 'lib/d.ts': { x: 900, y: -300 } }, folders: {} };
    const gFiles = base();
    const atFiles = await placeMap(gFiles, emptyPositions(), pins, run);
    expect(atFiles.files.get('lib/c.ts')).toEqual({ x: -500, y: 1234 });
    expect(atFiles.files.get('lib/d.ts')).not.toEqual({ x: 900, y: -300 });
    expectSound(gFiles, atFiles, pins);
    // Taller cards at the functions level: a files-level pin there would overlap its neighbors.
    const gFns = graph('functions', { api: ['a.ts', 'b.ts'], lib: ['c.ts', 'd.ts'], ui: ['e.ts', 'f.ts'] },
      [['api/a.ts', 'lib/c.ts'], ['api/b.ts', 'ui/e.ts'], ['ui/f.ts', 'ui/e.ts']], { 'lib/c.ts': 6, 'api/a.ts': 4 });
    const atFns = await placeMap(gFns, emptyPositions(), pins, run);
    expect(atFns.files.get('lib/c.ts')).not.toEqual({ x: -500, y: 1234 });
    expect(atFns.files.get('lib/d.ts')).toEqual({ x: 900, y: -300 });
    expectSound(gFns, atFns, pins);
  });
});

describe('placeMap: layout failures', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('falls back to a grid when ELK fails', async () => {
    const g = base();
    const failing: ElkRun = async () => { throw new Error('layout worker failed'); };
    const pos = await placeMap(g, emptyPositions(), noPins(), failing);
    expectSound(g, pos);
  });

  it('falls back to a grid when ELK never settles (10 s)', async () => {
    vi.useFakeTimers();
    const g = base();
    const never: ElkRun = () => new Promise(() => {});
    const p = placeMap(g, emptyPositions(), noPins(), never);
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT);
    const pos = await p;
    expectSound(g, pos);
  });
});

describe('placeMap: scale', () => {
  it('lays out 500 files in 25 folders in under 3 s with real elkjs', async () => {
    const spec: Record<string, string[]> = {};
    const imports: [string, string][] = [];
    for (let d = 0; d < 25; d++) spec[`d${d}`] = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    for (let d = 0; d < 25; d++) for (let i = 0; i < 20; i++) {
      imports.push([`d${d}/f${i}.ts`, `d${(d * 3 + i) % 25}/f${(i * 7) % 20}.ts`]);
      if (i > 0) imports.push([`d${d}/f${i}.ts`, `d${d}/f${i - 1}.ts`]);
    }
    const uniq = [...new Map(imports.filter(([a, b]) => a !== b).map(e => [e.join('>'), e])).values()];
    const g = graph('files', spec, uniq);
    const t0 = performance.now();
    const pos = await placeMap(g, emptyPositions(), noPins(), run);
    expect(performance.now() - t0).toBeLessThan(3000 * TIME_SCALE);
    expect(pos.files.size).toBe(500);
    const folders = [...pos.folders.values()];
    for (let i = 0; i < folders.length; i++) for (let j = i + 1; j < folders.length; j++) expect(overlaps(folders[i], folders[j])).toBe(false);
  });
});
