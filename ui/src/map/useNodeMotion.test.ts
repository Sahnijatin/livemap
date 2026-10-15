import { describe, it, expect } from 'vitest';
import type { MapGraph } from './mapModel';
import { DataCache, type Box } from './mapFlow';
import { FOLDER_HEAD } from './mapLayout';
import { buildNodes, patchNodes, planMoves, planSpawns } from './useNodeMotion';

const box = (x: number, y: number, w = 220, h = 64): Box => ({ x, y, w, h });
const none = { levelChanged: false, folderOf: new Map<string, string>(), dragging: new Set<string>() };

describe('planMoves', () => {
  it('moves changed boxes from where they are shown; new and unchanged nodes start at their target', () => {
    const shown = new Map([['a', box(0, 0)], ['b', box(0, 100)]]);
    const boxes = new Map([['a', box(0, 0)], ['b', box(0, 180)], ['c', box(300, 0)]]);
    const { next, movers } = planMoves(boxes, shown, none);
    expect(movers).toEqual([{ id: 'b', from: box(0, 100), to: box(0, 180) }]);
    expect(next.get('b')).toEqual(box(0, 100));
    expect(next.get('c')).toEqual(box(300, 0));
  });

  it('leaves a node the user is dragging where they hold it, even when its layout box moves', () => {
    const shown = new Map([['a', box(512, 77)]]);
    const boxes = new Map([['a', box(0, 300)]]);
    const { next, movers } = planMoves(boxes, shown, { ...none, dragging: new Set(['a']) });
    expect(movers).toEqual([]);
    expect(next.get('a')).toEqual(box(512, 77));
  });

  it('after a level switch, files open out of their folder card', () => {
    const shown = new Map([['dir:a', box(1000, 1000, 250, 120)]]);
    const boxes = new Map([['dir:a', box(0, 0, 260, 300)], ['a/x.ts', box(20, 64)]]);
    const { movers } = planMoves(boxes, shown, { ...none, levelChanged: true, folderOf: new Map([['a/x.ts', 'dir:a']]) });
    const x = movers.find(m => m.id === 'a/x.ts')!;
    expect(x.from).toEqual({ x: 1000 + 125 - 110, y: 1000 + 60 - 32, w: 220, h: 64 });
    expect(x.to).toEqual(box(20, 64));
  });
});

describe('nodes', () => {
  const graph: MapGraph = {
    level: 'files', large: false, edges: [],
    folders: [{ id: 'dir:a', path: 'a', label: 'a', layer: 'core', files: ['a/x.ts', 'a/y.ts'], counts: { files: 2, symbols: 0, routes: 0, tables: 0 }, isNew: false }],
    files: ['a/x.ts', 'a/y.ts'].map(id => ({ id, folder: 'dir:a', label: id, layer: 'core' as const, symbols: 0, rows: [], isNew: false, isLive: false, isFlagged: false })),
  };
  const shown = new Map([['dir:a', box(0, 0, 260, 228)], ['a/x.ts', box(20, 64)], ['a/y.ts', box(20, 144)]]);

  it('patchNodes gives moved nodes new objects and returns every other node object as is', () => {
    const ns = buildNodes(graph, shown, new DataCache(), new Set(), []);
    const out = patchNodes(ns, new Map([['a/y.ts', box(20, 200)]]));
    expect(out[0]).toBe(ns[0]);
    expect(out[1]).toBe(ns[1]);
    expect(out[2]).not.toBe(ns[2]);
    expect(out[2].position).toEqual({ x: 20, y: 200 });
    expect(patchNodes(ns, new Map())).toBe(ns);
  });

  it('folder labels are their own non-interactive nodes above the links; the region stays behind', () => {
    const ns = buildNodes(graph, shown, new DataCache(), new Set(), []);
    const region = ns.find(n => n.id === 'dir:a')!;
    expect(region.type).toBe('folder');
    expect(region.zIndex).toBe(-1);
    const labels = ns.filter(n => n.type === 'folderLabel');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      position: { x: 0, y: 0 }, width: 260, height: FOLDER_HEAD, selectable: false, draggable: false, zIndex: 1,
      data: { folder: graph.folders[0] },
    });
    // A moved folder takes its label along.
    const moved = patchNodes(ns, new Map([['dir:a', box(40, 80, 260, 228)]]));
    expect(moved.find(n => n.type === 'folderLabel')!.position).toEqual({ x: 40, y: 80 });
    // The folders level shows folder cards with their own labels.
    expect(buildNodes({ ...graph, level: 'folders' }, shown, new DataCache(), new Set(), []).some(n => n.type === 'folderLabel')).toBe(false);
  });

  it('buildNodes keeps unchanged node objects across rebuilds', () => {
    const cache = new DataCache();
    const first = buildNodes(graph, shown, cache, new Set(), []);
    const second = buildNodes(graph, new Map(shown).set('a/y.ts', box(20, 150)), cache, new Set(), first);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2].data).toBe(first[2].data);
  });
});

describe('planSpawns', () => {
  const mf = (id: string, folder: string) => ({ id, folder, label: id, layer: 'core', symbols: 0, rows: [], isNew: false, isLive: false, isFlagged: false });
  const edge = (source: string, target: string) => ({ id: `${source}->${target}`, source, target, weight: 1, isNew: true });
  const g = (edges: ReturnType<typeof edge>[]) => ({
    level: 'files', large: false, folders: [], edges,
    files: [mf('a', 'dir:x'), mf('n', 'dir:x')],
  }) as unknown as MapGraph;
  const boxes = new Map([['dir:x', box(0, 0, 400, 400)], ['a', box(20, 40)], ['n', box(20, 200)]]);
  const all = () => true;

  it('starts a new card at the center of its first placed partner', () => {
    const out = planSpawns(g([edge('n', 'a')]), boxes, new Map([['a', box(20, 40)]]), all);
    expect([...out]).toEqual([['n', { dx: 0, dy: -160 }]]);
  });

  it('falls back to the folder center, skips files that are not new, and does nothing on a first show', () => {
    const shown = new Map([['a', box(20, 40)]]);
    expect(planSpawns(g([]), boxes, shown, all).get('n')).toEqual({ dx: 200 - 130, dy: 200 - 232 });
    expect(planSpawns(g([edge('n', 'a')]), boxes, shown, id => id !== 'n').size).toBe(0);
    expect(planSpawns(g([edge('n', 'a')]), boxes, new Map(), all).size).toBe(0);
  });
});
