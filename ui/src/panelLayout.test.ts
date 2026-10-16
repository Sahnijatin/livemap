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
    expect(LIMITS).toEqual({ files: [200, 520], inspector: [300, Infinity] });
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
    expect(fitLayout(layout({ w: { files: 10, inspector: 9000 } }), 2536, 2560)).toEqual({ files: 200, inspector: 2536 - 420 - 24 - 200 });
    // No fixed maximum for the inspector: a set width that fits is drawn.
    expect(fitLayout(layout({ w: { files: 300, inspector: 1100 } }), 1896, 1920)).toEqual({ files: 300, inspector: 1100 });
  });

  it('fits the .app box it is given, not the viewport (safe-area insets, other gutters)', () => {
    const l = layout({ w: { files: 400, inspector: 600 } });
    expect(fitLayout(l, 1876, 1900)).toEqual({ files: 400, inspector: 600 });
    expect(center(1400, l, fitLayout(l, 1400, 1900))).toBeGreaterThanOrEqual(CENTER_MIN);
    // A smaller box than the one the widths were set in: the inspector gives way first.
    expect(fitLayout(l, 1400, 1900)).toEqual({ files: 400, inspector: 556 });
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
  it('in the box a handle last set a width in: the panel not resized last shrinks first, then the other', () => {
    const w = { files: 400, inspector: 600 };
    // 1176 box: 1176 - 420 - 24 = 732 for both panels, 268 too many.
    expect(fitLayout(layout({ w, at: 1176 }), 1176, 1200)).toEqual({ files: 200, inspector: 532 });
    expect(fitLayout(layout({ w, last: 'files', at: 1176 }), 1176, 1200)).toEqual({ files: 400, inspector: 332 });
    expect(fitLayout(layout({ w, last: 'inspector', at: 1176 }), 1176, 1200)).toEqual({ files: 200, inspector: 532 });
    // Narrower still: both at their minimums.
    expect(fitLayout(layout({ w, last: 'files' }), 900, 1080)).toEqual({ files: 200, inspector: 300 });
  });

  it('in a smaller box (window resize, reload on a smaller screen) the inspector gives way first, down to its default', () => {
    // 980 set on a 1920 screen, reloaded at 1440: the project panel keeps its width.
    const l = layout({ w: { files: null, inspector: 980 }, last: 'inspector', at: 1896 });
    expect(fitLayout(l, 1896, 1920)).toEqual({ files: 272, inspector: 980 });
    expect(fitLayout(l, 1416, 1440)).toEqual({ files: 272, inspector: 1416 - 444 - 272 });
    expect(fitLayout(l, 1076, 1100)).toEqual({ files: 248, inspector: 384 });
    // Past its default, the normal rules: the panel not resized last, then the other.
    expect(fitLayout(l, 900, 1100)).toEqual({ files: 200, inspector: 300 });
    // A stored layout from before boxes were remembered counts as set in a box of any size.
    const w = { files: 400, inspector: 600 };
    expect(fitLayout(layout({ w }), 1176, 1200)).toEqual({ files: 392, inspector: 340 });
    expect(fitLayout(layout({ w, last: 'files' }), 1176, 1200)).toEqual({ files: 400, inspector: 332 });
  });

  it('starts from what was drawn in the box the width was set in, so nothing jumps as the box shrinks or grows', () => {
    // The inspector handle squeezed the project panel to 252 in a 1896 box.
    const l = layout({ w: { files: 272, inspector: 1200 }, last: 'inspector', at: 1896 });
    expect(fitLayout(l, 1896, 1920)).toEqual({ files: 252, inspector: 1200 });
    expect(fitLayout(l, 1895, 1920)).toEqual({ files: 252, inspector: 1199 });
    expect(fitLayout(l, 1916, 1940)).toEqual({ files: 272, inspector: 1200 });
  });

  it('reach: the widest a panel draws, with the other at its minimum (or collapsed) and the center at CENTER_MIN', () => {
    expect(reach(layout(), 'files', 1176)).toBe(1176 - 420 - 12 - 312);
    expect(reach(layout(), 'files', 2400)).toBe(520);
    expect(reach(layout({ collapsed: { files: false, inspector: true } }), 'files', 900)).toBe(468);
    // A width within reach, set by the panel resized last, is drawn exactly.
    const l = layout({ w: { files: reach(layout(), 'files', 1176), inspector: 720 }, last: 'files', at: 1176 });
    expect(fitLayout(l, 1176, 1200).files).toBe(432);
  });
});

describe('the inspector has no fixed maximum', () => {
  it('reaches what leaves the center at CENTER_MIN with the project panel at its minimum (or collapsed)', () => {
    expect(reach(layout(), 'inspector', 1176)).toBe(1176 - 420 - 12 - 212);
    expect(reach(layout(), 'inspector', 1896)).toBe(1896 - 420 - 12 - 212);
    expect(reach(layout({ w: { files: 400, inspector: null } }), 'inspector', 1896)).toBe(1252);
    expect(reach(layout({ collapsed: { files: true, inspector: false } }), 'inspector', 1896)).toBe(1896 - 420 - 12);
    expect(reach(layout(), 'inspector', 900)).toBe(300);
    // The handle in use wins: that width, set by the inspector handle, is drawn and the project panel gives way.
    const l = layout({ w: { files: 400, inspector: 1252 }, last: 'inspector', at: 1896 });
    expect(fitLayout(l, 1896, 1920)).toEqual({ files: 200, inspector: 1252 });
  });
});

describe('a widened inspector', () => {
  it('fills its reach: the project panel gives way to its minimum, and it follows the box', () => {
    const l = layout({ w: { files: 300, inspector: 400 }, wide: true, last: 'inspector' });
    expect(fitLayout(l, 1576, 1600)).toEqual({ files: 200, inspector: 1576 - 444 - 200 });
    expect(fitLayout(l, 1896, 1920)).toEqual({ files: 200, inspector: reach(l, 'inspector', 1896) });
    expect(fitLayout({ ...l, collapsed: { files: true, inspector: false } }, 1896, 1920).inspector).toBe(1896 - 432);
    expect(fitLayout(l, 900, 1080)).toEqual({ files: 200, inspector: 300 });
  });

  it('gives way to a project panel resized after it', () => {
    const l = layout({ w: { files: 300, inspector: 400 }, wide: true, last: 'files', at: 1896 });
    expect(fitLayout(l, 1896, 1920)).toEqual({ files: 300, inspector: 1896 - 444 - 300 });
  });

  it('does not change the project panel while the inspector is collapsed, and restores both widths', () => {
    const l = layout({ w: { files: 300, inspector: 500 }, wide: true, last: 'inspector', collapsed: { files: false, inspector: true } });
    expect(fitLayout(l, 1896, 1920).files).toBe(300);
    expect(fitLayout({ ...l, wide: false, collapsed: { files: false, inspector: false } }, 1896, 1920)).toEqual({ files: 300, inspector: 500 });
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
      .toEqual(layout({ w: { files: 300, inspector: 9999 }, collapsed: { files: true, inspector: false }, last: 'files' }));
    expect(parseLayout(JSON.stringify({ w: { inspector: 500 }, wide: true }))).toEqual(layout({ w: { files: null, inspector: 500 }, wide: true }));
    expect(parseLayout(JSON.stringify({ wide: 'yes' })).wide).toBeUndefined();
    expect(parseLayout(JSON.stringify({ at: 1896 })).at).toBe(1896);
    for (const at of [-5, 'x', null, 0]) expect(parseLayout(JSON.stringify({ at })).at).toBeUndefined();
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
    const l = layout({ w: { files: 320, inspector: 450 }, collapsed: { files: false, inspector: true }, wide: true, at: 1416 });
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
