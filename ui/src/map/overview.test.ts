import { describe, it, expect } from 'vitest';
import type { MapFolder } from './mapModel';
import type { Box } from './mapFlow';
import { LABEL_H, LABEL_MAX_W, labelWidth, overviewLabels, quantZoom } from './overview';
import { splitFolder } from './FolderNode';

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

describe('splitFolder', () => {
  it('keeps the last folders that fit in 24 characters as the end, so similar folders stay apart', () => {
    expect(splitFolder('apps/web/src/hooks')).toEqual(['apps/web/src/hooks', '']);
    expect(splitFolder('packages/feature-01-search/src')).toEqual(['packages/', 'feature-01-search/src']);
    expect(splitFolder('apps/api/src/controllers/billing-invoices')).toEqual(['apps/api/src/controllers/', 'billing-invoices']);
    // A last folder longer than that is split by word, as in the file tree.
    expect(splitFolder('.agents/skills/supabase-row-level-security')).toEqual(['.agents/skills/supabase-row-', 'level-security']);
  });
});
