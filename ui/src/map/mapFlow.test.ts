import { describe, it, expect } from 'vitest';
import { Position } from '@xyflow/react';
import { linkPath } from './LinkEdge';
import type { MapFile } from './mapModel';
import { emptyPositions } from './mapLayout';
import { DataCache, FOCUS_ZOOM, READABLE_ZOOM, cameraPlan, edgeSides, nearestInDirection, shouldSavePin } from './mapFlow';

const file = (id: string, extra: Partial<MapFile> = {}): MapFile => ({
  id, folder: 'dir:a', label: id, layer: 'core', symbols: 1, rows: [], isNew: false, isLive: false, isFlagged: false, ...extra,
});

describe('cameraPlan', () => {
  it('fits everything only when the fitted zoom stays readable (>= 0.7), however small the map', () => {
    expect(READABLE_ZOOM).toBe(0.7);
    expect(cameraPlan(READABLE_ZOOM, true)).toEqual({ kind: 'fit' });
    expect(cameraPlan(0.9, false)).toEqual({ kind: 'fit' });
    // A 15-file project that fits only at 0.62 is not fitted: its cards would be unreadable.
    expect(cameraPlan(0.62, false)).toEqual({ kind: 'topleft', zoom: FOCUS_ZOOM });
  });

  it('otherwise centers the live or selected file at 0.85, else anchors the top-left cluster at 0.85', () => {
    expect(FOCUS_ZOOM).toBe(0.85);
    expect(cameraPlan(0.69, true)).toEqual({ kind: 'center', zoom: FOCUS_ZOOM });
    expect(cameraPlan(0.2, true)).toEqual({ kind: 'center', zoom: FOCUS_ZOOM });
    expect(cameraPlan(0.2, false)).toEqual({ kind: 'topleft', zoom: FOCUS_ZOOM });
  });
});

describe('DataCache', () => {
  it('keeps data objects while what a card shows is unchanged, and forgets pruned ids', () => {
    const c = new DataCache();
    const a = c.file(file('a'), 'files');
    expect(c.file(file('a'), 'files')).toBe(a);
    expect(c.file(file('a', { isLive: true }), 'files')).not.toBe(a);
    const b = c.file(file('b'), 'files');
    c.prune(new Set(['a']));
    expect(c.file(file('b'), 'files')).not.toBe(b);
  });
});

describe('nearestInDirection', () => {
  it('prefers the closest card along the axis, penalizing sideways distance', () => {
    const at = (x: number, y: number) => ({ x, y, w: 10, h: 10 });
    const c = [{ id: 'r', box: at(100, 0) }, { id: 'rd', box: at(60, 80) }, { id: 'l', box: at(-100, 0) }];
    expect(nearestInDirection(at(0, 0), c, 'right')).toBe('r');
    expect(nearestInDirection(at(0, 0), c, 'left')).toBe('l');
    expect(nearestInDirection(at(0, 0), c, 'down')).toBe('rd');
    expect(nearestInDirection(at(0, 0), c, 'up')).toBeNull();
  });
});

describe('linkPath (F12)', () => {
  const nums = (d: string) => d.match(/-?[\d.]+/g)!.map(Number);
  it('a link between close facing sides is a smooth curve: control points never overshoot each other', () => {
    // Two folder cards one grid gap (56 px) apart, rows 15 px off.
    const [sx, , c1x, , c2x, , tx] = nums(linkPath(250, 60, 306, 75, Position.Right, Position.Left));
    expect(sx).toBe(250);
    expect(tx).toBe(306);
    expect(c1x).toBeLessThanOrEqual(c2x);
    expect(c1x).toBeGreaterThanOrEqual(sx);
    expect(c2x).toBeLessThanOrEqual(tx);
  });
  it('a long or steep link still eases out horizontally', () => {
    const [sx, , c1x] = nums(linkPath(0, 0, 40, 400, Position.Right, Position.Left));
    expect(c1x - sx).toBe(50);
    const [lx, , l1x] = nums(linkPath(0, 0, 900, 0, Position.Right, Position.Left));
    expect(l1x - lx).toBe(450);
  });
});

describe('edgeSides (#15)', () => {
  it('links use only the two handles l and r: rightward r to l, leftward l to r, same column r to r', () => {
    const at = (x: number) => ({ x, y: 0, w: 250, h: 62 });
    expect(edgeSides(at(0), at(400))).toEqual({ sourceHandle: 'r', targetHandle: 'l' });
    expect(edgeSides(at(400), at(0))).toEqual({ sourceHandle: 'l', targetHandle: 'r' });
    expect(edgeSides(at(0), at(50))).toEqual({ sourceHandle: 'r', targetHandle: 'r' });
  });
});

describe('shouldSavePin (#15)', () => {
  const placed = emptyPositions();
  placed.files.set('a.ts', { x: 0, y: 0 });
  placed.folders.set('dir:src', { x: 0, y: 0, w: 300, h: 200 });

  it('saves a drag that ends on a card of the laid-out level', () => {
    expect(shouldSavePin({ id: 'a.ts', type: 'file' }, placed, false)).toBe(true);
    expect(shouldSavePin({ id: 'dir:src', type: 'folder' }, placed, false)).toBe(true);
  });

  it('saves nothing while a level switch or reset waits for its layout, or for a card that layout does not place', () => {
    expect(shouldSavePin({ id: 'a.ts', type: 'file' }, placed, true)).toBe(false);
    expect(shouldSavePin({ id: 'b.ts', type: 'file' }, placed, false)).toBe(false);
    expect(shouldSavePin({ id: 'a.ts', type: 'folder' }, placed, false)).toBe(false);
  });
});
