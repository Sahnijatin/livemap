import { describe, it, expect, afterEach, vi } from 'vitest';
import { CENTER_MIN, LAYOUT_KEY, LIMITS, clampWidth, defaultWidth, fitLayout, loadLayout, parseLayout, saveLayout, type PanelLayout } from './panelLayout';

const layout = (p: Partial<PanelLayout> = {}): PanelLayout => ({ w: { files: null, inspector: null }, collapsed: { files: false, inspector: false }, ...p });

/** Center column width for a viewport (12 px gutters, a 12 px gap beside each shown panel). */
const center = (vw: number, l: PanelLayout, fit = fitLayout(l, vw)) =>
  vw - 24 - (l.collapsed.files ? 0 : fit.files + 12) - (l.collapsed.inspector ? 0 : fit.inspector + 12);

describe('defaultWidth', () => {
  it('is 272/384 from 1280 px and 248/340 below', () => {
    expect([defaultWidth('files', 1440), defaultWidth('inspector', 1440)]).toEqual([272, 384]);
    expect([defaultWidth('files', 1280), defaultWidth('inspector', 1280)]).toEqual([272, 384]);
    expect([defaultWidth('files', 1279), defaultWidth('inspector', 1279)]).toEqual([248, 340]);
    expect([defaultWidth('files', 1080), defaultWidth('inspector', 1080)]).toEqual([248, 340]);
  });
});

describe('clampWidth', () => {
  it('keeps each panel within its limits', () => {
    expect(LIMITS).toEqual({ files: [200, 520], inspector: [300, 720] });
    expect(clampWidth('files', 50, 2560, 0)).toBe(200);
    expect(clampWidth('files', 900, 2560, 0)).toBe(520);
    expect(clampWidth('inspector', 100, 2560, 0)).toBe(300);
    expect(clampWidth('inspector', 1200, 2560, 0)).toBe(720);
    expect(clampWidth('files', 333.6, 2560, 0)).toBe(334);
  });

  it('never leaves the center column narrower than CENTER_MIN', () => {
    expect(CENTER_MIN).toBe(420);
    // 1280 - 24 gutters - 420 center - 12 gap - (384 + 12) inspector = 428.
    expect(clampWidth('files', 520, 1280, 384 + 12)).toBe(428);
    // Inspector collapsed: 1280 - 24 - 420 - 12 = 824, so only the panel limit applies.
    expect(clampWidth('files', 520, 1280, 0)).toBe(520);
    // The minimum wins over the center when both cannot hold.
    expect(clampWidth('inspector', 720, 1080, 520 + 12)).toBe(300);
  });

  it('treats junk as the minimum', () => {
    expect(clampWidth('files', Number.NaN, 1440, 0)).toBe(200);
  });
});

describe('fitLayout', () => {
  it('uses the default widths when none are set', () => {
    expect(fitLayout(layout(), 1440)).toEqual({ files: 272, inspector: 384 });
    expect(fitLayout(layout(), 1100)).toEqual({ files: 248, inspector: 340 });
  });

  it('keeps chosen widths that fit and clamps those out of range', () => {
    expect(fitLayout(layout({ w: { files: 300, inspector: 600 } }), 1600)).toEqual({ files: 300, inspector: 600 });
    expect(fitLayout(layout({ w: { files: 10, inspector: 9000 } }), 2560)).toEqual({ files: 200, inspector: 720 });
  });

  it('shrinks both panels when the window narrows, so the center keeps CENTER_MIN', () => {
    const l = layout({ w: { files: 520, inspector: 720 } });
    for (const vw of [1080, 1200, 1440, 1700]) {
      const fit = fitLayout(l, vw);
      expect(center(vw, l, fit)).toBeGreaterThanOrEqual(CENTER_MIN);
      expect(fit.files).toBeGreaterThanOrEqual(200);
      expect(fit.inspector).toBeGreaterThanOrEqual(300);
    }
    // Wide enough for both: untouched.
    expect(fitLayout(l, 2200)).toEqual({ files: 520, inspector: 720 });
  });

  it('gives a collapsed panel no room, so the other may grow', () => {
    const l = layout({ w: { files: 520, inspector: 720 }, collapsed: { files: true, inspector: false } });
    expect(fitLayout(l, 1200).inspector).toBe(720);
    expect(center(1200, l)).toBeGreaterThanOrEqual(CENTER_MIN);
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
    expect(parseLayout(JSON.stringify({ w: { files: Infinity } }))).toEqual(empty);
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
    expect(() => saveLayout(layout())).not.toThrow();
  });
});
