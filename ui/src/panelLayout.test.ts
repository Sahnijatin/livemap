import { describe, it, expect, afterEach, vi } from 'vitest';
import { CENTER_MIN, GAP, LAYOUT_KEY, LIMITS, defaultWidth, fitLayout, loadLayout, parseLayout, saveLayout, type PanelLayout } from './panelLayout';
import { widthFor } from './panelDrag';
import { PANELS, shownLayout } from './panels';

const layout = (p: Partial<PanelLayout> = {}): PanelLayout => ({ w: { files: null, inspector: null }, collapsed: { files: false, inspector: false }, ...p });

/** Center column width in an `.app` box `width` wide (a GAP beside each shown panel). */
const center = (width: number, l: PanelLayout, fit = fitLayout(l, width, width + 24)) =>
  width - (l.collapsed.files ? 0 : fit.files + GAP) - (l.collapsed.inspector ? 0 : fit.inspector + GAP);

describe('constants', () => {
  it('name each panel, its shortcut and its element once', () => {
    expect(PANELS).toEqual({ files: { name: 'project panel', key: '[', id: 'sidebar' }, inspector: { name: 'inspector', key: ']', id: 'inspector' } });
    expect(LIMITS).toEqual({ files: [200, 520], inspector: [300, 720] });
    expect([CENTER_MIN, GAP]).toEqual([420, 12]);
  });
});

describe('defaultWidth', () => {
  it('is 272/384 from a 1280 px viewport and 248/340 below', () => {
    expect([defaultWidth('files', 1440), defaultWidth('inspector', 1440)]).toEqual([272, 384]);
    expect([defaultWidth('files', 1280), defaultWidth('inspector', 1280)]).toEqual([272, 384]);
    expect([defaultWidth('files', 1279), defaultWidth('inspector', 1279)]).toEqual([248, 340]);
  });
});

describe('fitLayout', () => {
  it('uses the default widths (by viewport) when none are set', () => {
    expect(fitLayout(layout(), 1416, 1440)).toEqual({ files: 272, inspector: 384 });
    expect(fitLayout(layout(), 1076, 1100)).toEqual({ files: 248, inspector: 340 });
  });

  it('keeps chosen widths that fit and clamps those out of range', () => {
    expect(fitLayout(layout({ w: { files: 300, inspector: 600 } }), 1576, 1600)).toEqual({ files: 300, inspector: 600 });
    expect(fitLayout(layout({ w: { files: 10, inspector: 9000 } }), 2536, 2560)).toEqual({ files: 200, inspector: 720 });
  });

  it('fits the .app box it is given, not the viewport (safe-area insets, other gutters)', () => {
    const l = layout({ w: { files: 400, inspector: 600 } });
    expect(fitLayout(l, 1876, 1900)).toEqual({ files: 400, inspector: 600 });
    expect(center(1400, l, fitLayout(l, 1400, 1900))).toBeGreaterThanOrEqual(CENTER_MIN);
    expect(fitLayout(l, 1400, 1900).inspector).toBeLessThan(600);
  });

  it('shrinks both panels when the box narrows, so the center keeps CENTER_MIN', () => {
    const l = layout({ w: { files: 520, inspector: 720 } });
    for (const width of [1056, 1176, 1416, 1676]) {
      const fit = fitLayout(l, width, width + 24);
      expect(center(width, l, fit)).toBeGreaterThanOrEqual(CENTER_MIN);
      expect(fit.files).toBeGreaterThanOrEqual(200);
      expect(fit.inspector).toBeGreaterThanOrEqual(300);
    }
    expect(fitLayout(l, 2176, 2200)).toEqual({ files: 520, inspector: 720 });
  });

  it('gives a collapsed panel no room, so the other may grow', () => {
    const l = layout({ w: { files: 520, inspector: 720 }, collapsed: { files: true, inspector: false } });
    expect(fitLayout(l, 1176, 1200).inspector).toBe(720);
    expect(center(1176, l)).toBeGreaterThanOrEqual(CENTER_MIN);
  });
});

describe('widthFor', () => {
  it('is the drawn width itself when nothing is squeezed', () => {
    expect(widthFor(layout(), 'files', 333, 1416, 1440)).toBe(333);
    expect(widthFor(layout(), 'inspector', 300, 1416, 1440)).toBe(300);
  });

  it('in a squeezed box: a stored width that fitLayout draws exactly at the target, so a drag follows the pointer', () => {
    // Stored inspector 720 in a 1200 px window: the sidebar is drawn narrower than its default.
    const l = layout({ w: { files: null, inspector: 720 } });
    const width = 1176, vw = 1200;
    const start = fitLayout(l, width, vw).files;
    expect(start).toBeLessThan(248);
    const max = fitLayout({ ...l, w: { ...l.w, files: LIMITS.files[1] } }, width, vw).files;
    let prev = start;
    for (let d = start; d <= max; d++) {
      const w = widthFor(l, 'files', d, width, vw);
      const drawn = fitLayout({ ...l, w: { ...l.w, files: w } }, width, vw).files;
      expect(drawn).toBe(d);
      expect(drawn).toBeGreaterThanOrEqual(prev);
      expect(center(width, { ...l, w: { ...l.w, files: w } })).toBeGreaterThanOrEqual(CENTER_MIN);
      prev = drawn;
    }
    // Past what the box allows: the limit.
    expect(widthFor(l, 'files', max + 50, width, vw)).toBe(LIMITS.files[1]);
  });
});

describe('shownLayout', () => {
  it('shows a collapsed inspector while peeking, without touching the stored layout', () => {
    const l = layout({ collapsed: { files: true, inspector: true } });
    expect(shownLayout(l, false)).toBe(l);
    expect(shownLayout(l, true).collapsed).toEqual({ files: true, inspector: false });
    expect(l.collapsed.inspector).toBe(true);
  });
});

describe('parseLayout', () => {
  it('reads a stored layout and clamps its widths', () => {
    expect(parseLayout(JSON.stringify({ w: { files: 300, inspector: 9999 }, collapsed: { files: true, inspector: false } })))
      .toEqual(layout({ w: { files: 300, inspector: 720 }, collapsed: { files: true, inspector: false } }));
  });

  it('ignores bad values', () => {
    const empty = layout();
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '{"w":"x"}']) expect(parseLayout(raw)).toEqual(empty);
    expect(parseLayout(JSON.stringify({ w: { files: 'wide', inspector: -1 }, collapsed: { files: 'yes', inspector: 1 } })))
      .toEqual(layout({ w: { files: null, inspector: 300 } }));
  });
});

describe('loadLayout and saveLayout', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trip through localStorage under one key', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const l = layout({ w: { files: 320, inspector: null }, collapsed: { files: false, inspector: true } });
    saveLayout(l);
    expect([...store.keys()]).toEqual([LAYOUT_KEY]);
    expect(LAYOUT_KEY).toBe('livemap:layout');
    expect(loadLayout()).toEqual(l);
  });

  it('fall back to defaults when storage throws or is missing', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(() => saveLayout(layout())).not.toThrow();
    expect(loadLayout()).toEqual(layout());
    vi.stubGlobal('localStorage', undefined);
    expect(loadLayout()).toEqual(layout());
  });
});
