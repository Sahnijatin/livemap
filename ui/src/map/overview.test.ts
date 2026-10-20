import { describe, it, expect } from 'vitest';
import type { MapFolder } from './mapModel';
import type { Box } from './mapFlow';
import { LABEL_H, LABEL_MAX_W, folderBoxes, labelWidth, nameFit, overviewLabels, quantZoom, rankFolders, rankOrderCache } from './overview';

const folder = (path: string, files: number): MapFolder => ({
  id: `dir:${path}`, path, label: path, layer: 'core', files: [],
  counts: { files, symbols: 0, routes: 0, tables: 0 }, isNew: false,
});
const box = (x: number, y: number, w = 250, h = 120): Box => ({ x, y, w, h });

describe('overviewLabels', () => {
  it('labels nothing at readable zooms (0.45 and up)', () => {
    const fs = [folder('src', 3)];
    expect(overviewLabels(fs, new Map([['dir:src', box(0, 0)]]), 'folders', 0.45)).toEqual([]);
    expect(overviewLabels(fs, new Map([['dir:src', box(0, 0)]]), 'folders', 0.3)).toHaveLength(1);
  });

  it('a label keeps its screen size: it is centered on a folder card, at the top left of a folder region', () => {
    const z = 0.2;
    const [a] = overviewLabels([folder('src', 3)], new Map([['dir:src', box(100, 200)]]), 'folders', z);
    const w = labelWidth('src/');
    expect(a).toMatchObject({ id: 'dir:src', text: 'src/' });
    expect(a.x).toBeCloseTo(100 + 125 - w / z / 2);
    expect(a.y).toBeCloseTo(200 + 60 - LABEL_H / z / 2);
    const [b] = overviewLabels([folder('src', 3)], new Map([['dir:src', box(100, 200, 740, 400)]]), 'files', z);
    expect(b.x).toBe(110);
    expect(b.y).toBe(206);
  });

  it('when labels collide, the folder with more files keeps its label; the rest stay as they are', () => {
    const fs = [folder('small', 2), folder('big', 40), folder('far', 1)];
    const bx = new Map([['dir:small', box(0, 0)], ['dir:big', box(300, 0)], ['dir:far', box(5000, 0)]]);
    // At 0.1 the two near cards are 30 px apart on screen: only the bigger one is labeled.
    expect(overviewLabels(fs, bx, 'folders', 0.1).map(l => l.id).sort()).toEqual(['dir:big', 'dir:far']);
    // At 0.4 there is room for all three.
    expect(overviewLabels(fs, bx, 'folders', 0.4)).toHaveLength(3);
  });

  it('caps a long name at the label width (the label cuts it in the middle) and names the root', () => {
    expect(labelWidth('packages/feature-01-search/src/billing-and-invoicing-controllers/')).toBe(LABEL_MAX_W);
    const root = { ...folder('', 1), label: 'Project root' };
    expect(overviewLabels([root], new Map([['dir:', box(0, 0)]]), 'folders', 0.2)[0].text).toBe('Project root');
  });

  it('skips folders without a box (not laid out yet)', () => {
    expect(overviewLabels([folder('src', 3)], new Map(), 'files', 0.2)).toEqual([]);
  });
});

describe('quantZoom', () => {
  it('rounds to steps of 1.25, so labels re-render a few times per zoom-out, not every frame', () => {
    expect(quantZoom(0.2)).toBeCloseTo(1.25 ** -7);
    expect(quantZoom(0.21)).toBe(quantZoom(0.2));
    expect(quantZoom(0.1)).not.toBe(quantZoom(0.2));
  });
});

describe('nameFit', () => {
  it('whole when it fits; else a middle cut keeping the whole folders that leave the start 3 characters; else "…" and the end', () => {
    expect(nameFit('apps/web/src/hooks/', 19)).toMatchObject({ mode: 'whole', shown: 19 });
    // 'controllers/billing/' would leave no start, so the end is 'billing/'.
    expect(nameFit('apps/api/src/controllers/billing/', 19)).toMatchObject({ mode: 'middle', shown: 8 });
    expect(nameFit('packages/feature-01-search/src/', 26)).toMatchObject({ mode: 'middle', shown: 22 });
    // A last folder that alone leaves no room for a start: "…notification-hub/".
    expect(nameFit('packages/notification-hub/', 19)).toMatchObject({ mode: 'end', shown: 17 });
  });
});

describe('overviewLabels at scale', () => {
  const many = (n: number) => {
    const fs: MapFolder[] = [];
    const bx = new Map<string, Box>();
    for (let i = 0; i < n; i++) {
      const f = folder(`pkg/area-${i % 37}/mod-${i}`, (i * 7919) % 50);
      fs.push(f);
      bx.set(f.id, box((i % 60) * 306, Math.floor(i / 60) * 152));
    }
    return { fs, bx };
  };
  /** The same greedy placement with a plain pairwise check. */
  const naive = (fs: MapFolder[], bx: Map<string, Box>, z: number) => {
    const order = [...fs].sort((a, b) => b.counts.files - a.counts.files || (a.path < b.path ? -1 : 1));
    const placed: Box[] = [];
    const ids: string[] = [];
    const h = LABEL_H / z, m = 6 / z;
    for (const f of order) {
      const b = bx.get(f.id)!;
      const w = labelWidth(`${f.label}/`) / z;
      const r = { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
      if (placed.some(p => r.x < p.x + p.w + m && p.x < r.x + r.w + m && r.y < p.y + p.h + m && p.y < r.y + r.h + m)) continue;
      placed.push(r);
      ids.push(f.id);
    }
    return ids.sort();
  };

  it('places the same labels as a pairwise check, for 3,000 folders within budget', () => {
    const { fs, bx } = many(3000);
    for (const z of [0.1, 0.3]) expect(overviewLabels(fs, bx, 'folders', z).map(l => l.id).sort()).toEqual(naive(fs, bx, z));
    const t0 = performance.now();
    overviewLabels(fs, bx, 'folders', 0.2);
    expect(performance.now() - t0).toBeLessThan(60 * (Number(process.env.LIVEMAP_TIME_SCALE) || 1));
  });

  it('keeps the size order while file counts stay the same (a live event rebuilds the folders, not their order)', () => {
    const { fs } = many(50);
    const a = rankFolders(fs).map(f => f.id);
    const hits = rankOrderCache.hits;
    expect(rankFolders(fs.map(f => ({ ...f }))).map(f => f.id)).toEqual(a);
    expect(rankOrderCache.hits).toBe(hits + 1);
    const more = fs.map((f, i) => (i === 49 ? { ...f, counts: { ...f.counts, files: 999 } } : f));
    expect(rankFolders(more)[0].id).toBe(fs[49].id);
  });

  it('new folders claim their label first and say so', () => {
    const fs = [folder('big', 40), { ...folder('fresh', 1), isNew: true }];
    const bx = new Map([['dir:big', box(0, 0)], ['dir:fresh', box(300, 0)]]);
    const ls = overviewLabels(fs, bx, 'folders', 0.1);
    expect(ls.map(l => [l.id, l.isNew])).toEqual([['dir:fresh', true]]);
  });

  it('labels only what fits inside the visible area, so none is clipped at an edge', () => {
    const fs = [folder('left', 3), folder('edge', 3)];
    const bx = new Map([['dir:left', box(0, 0)], ['dir:edge', box(2000, 0)]]);
    const view = { x: -500, y: -500, w: 2600, h: 1200 };
    expect(overviewLabels(fs, bx, 'folders', 0.2, view).map(l => l.id)).toEqual(['dir:left']);
  });
});

describe('folderBoxes', () => {
  it('reads folder boxes from the live nodes, so labels follow a drag or a move', () => {
    const nodes = [
      { id: 'dir:a', type: 'folder', position: { x: 10, y: 20 }, width: 250, height: 120, data: {} },
      { id: 'src/a.ts', type: 'file', position: { x: 0, y: 0 }, width: 220, height: 64, data: {} },
      { id: 'dir:a#label', type: 'folderLabel', position: { x: 10, y: 20 }, width: 250, height: 44, data: {} },
    ] as unknown as Parameters<typeof folderBoxes>[0];
    expect([...folderBoxes(nodes)]).toEqual([['dir:a', { x: 10, y: 20, w: 250, h: 120 }]]);
  });
});
