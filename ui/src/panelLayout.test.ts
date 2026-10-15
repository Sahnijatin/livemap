import { describe, it, expect, afterEach, vi } from 'vitest';
import { CENTER_MIN, GAP, LAYOUT_KEY, LIMITS, defaultWidth, fitLayout, loadLayout, parseLayout, reach, saveLayout, type PanelLayout } from './panelLayout';
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
    expect(fitLayout(l, 1400, 1900)).toEqual({ files: 356, inspector: 600 });
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

describe('which panel gives way', () => {
  it('the panel not resized last shrinks first, then the other; the sidebar first when neither was', () => {
    const w = { files: 400, inspector: 600 };
    // 1176 box: 1176 - 420 - 24 = 732 for both panels, 268 too many.
    expect(fitLayout(layout({ w }), 1176, 1200)).toEqual({ files: 200, inspector: 532 });
    expect(fitLayout(layout({ w, last: 'files' }), 1176, 1200)).toEqual({ files: 400, inspector: 332 });
    expect(fitLayout(layout({ w, last: 'inspector' }), 1176, 1200)).toEqual({ files: 200, inspector: 532 });
    // Narrower still: both at their minimums.
    expect(fitLayout(layout({ w, last: 'files' }), 900, 1080)).toEqual({ files: 200, inspector: 300 });
  });

  it('reach: the widest a panel draws, with the other at its minimum (or collapsed) and the center at CENTER_MIN', () => {
    expect(reach(layout(), 'files', 1176)).toBe(1176 - 420 - 12 - 312);
    expect(reach(layout(), 'inspector', 1176)).toBe(1176 - 420 - 12 - 212);
    expect(reach(layout(), 'files', 2400)).toBe(520);
    expect(reach(layout({ collapsed: { files: false, inspector: true } }), 'files', 900)).toBe(468);
    // A width within reach, set by the panel resized last, is drawn exactly.
    const l = layout({ w: { files: reach(layout(), 'files', 1176), inspector: 720 }, last: 'files' });
    expect(fitLayout(l, 1176, 1200).files).toBe(432);
  });
});

describe('shownLayout', () => {
  it('shows a collapsed inspector while peeking, without touching the stored layout', () => {
    const l = layout({ collapsed: { files: true, inspector: true } });
    const files = { 'a.ts': {} } as never;
    expect(shownLayout({ layout: l, peek: null, selected: 'a.ts', files })).toBe(l);
    expect(shownLayout({ layout: l, peek: 'a.ts', selected: 'a.ts', files }).collapsed).toEqual({ files: true, inspector: false });
    // Only for the peeked file, while it is selected and exists.
    expect(shownLayout({ layout: l, peek: 'b.ts', selected: 'a.ts', files })).toBe(l);
    expect(shownLayout({ layout: l, peek: 'a.ts', selected: null, files })).toBe(l);
    expect(shownLayout({ layout: l, peek: 'gone.ts', selected: 'gone.ts', files })).toBe(l);
    expect(l.collapsed.inspector).toBe(true);
  });
});

describe('parseLayout', () => {
  it('reads a stored layout and clamps its widths', () => {
    expect(parseLayout(JSON.stringify({ w: { files: 300, inspector: 9999 }, collapsed: { files: true, inspector: false }, last: 'files' })))
      .toEqual(layout({ w: { files: 300, inspector: 720 }, collapsed: { files: true, inspector: false }, last: 'files' }));
    expect(parseLayout(JSON.stringify({ last: 'center' })).last).toBeUndefined();
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
