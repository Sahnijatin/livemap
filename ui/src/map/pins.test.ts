import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadPins, savePins, resetPins, pinsKey, filePins, fileKind, type Pins } from './pins';

function memStorage() {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
  return mem;
}

describe('pins', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips per project under livemap:pins:<root>', () => {
    const mem = memStorage();
    const pins: Pins = { files: { 'src/a.ts': { x: 10, y: -20 } }, functions: { 'src/a.ts': { x: 3, y: 4 } }, folders: { 'dir:src': { x: 1.5, y: 2 } } };
    savePins('/work/app', pins);
    expect(pinsKey('/work/app')).toBe('livemap:pins:/work/app');
    expect(mem.has('livemap:pins:/work/app')).toBe(true);
    expect(loadPins('/work/app')).toEqual(pins);
    expect(loadPins('/work/other')).toEqual({ files: {}, functions: {}, folders: {} });
  });

  it('keeps pins for files named __proto__ or constructor across a reload (#72)', () => {
    memStorage();
    const pins: Pins = { files: {}, functions: {}, folders: {} };
    pins.files = Object.assign(Object.create(null) as Record<string, { x: number; y: number }>, { ['__proto__']: { x: 1, y: 2 } });
    savePins('/p', pins);
    const back = loadPins('/p');
    expect(Object.keys(back.files)).toEqual(['__proto__']);
    expect(back.files['__proto__']).toEqual({ x: 1, y: 2 });
    expect(Object.getPrototypeOf(back.files)).toBeNull();
    expect(filePins(back, 'files').constructor).toBeUndefined();
    expect(filePins(back, 'folders').constructor).toBeUndefined();
    expect(filePins(loadPins('/none'), 'functions').constructor).toBeUndefined();
  });

  it('resetPins clears them', () => {
    memStorage();
    savePins('/r', { files: { a: { x: 1, y: 2 } }, functions: {}, folders: {} });
    resetPins('/r');
    expect(loadPins('/r')).toEqual({ files: {}, functions: {}, folders: {} });
  });

  it('a throwing or missing localStorage gives empty pins and never throws', () => {
    const boom = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(loadPins('/r')).toEqual({ files: {}, functions: {}, folders: {} });
    expect(() => savePins('/r', { files: {}, functions: {}, folders: {} })).not.toThrow();
    expect(() => resetPins('/r')).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(loadPins('/r')).toEqual({ files: {}, functions: {}, folders: {} });
    expect(() => savePins('/r', { files: {}, functions: {}, folders: {} })).not.toThrow();
  });

  it('ignores corrupt or malformed stored values', () => {
    const mem = memStorage();
    mem.set('livemap:pins:/r', '{not json');
    expect(loadPins('/r')).toEqual({ files: {}, functions: {}, folders: {} });
    mem.set('livemap:pins:/r', JSON.stringify({ files: { ok: { x: 1, y: 2 }, bad: { x: 'a', y: 2 }, nan: null }, folders: 5 }));
    expect(loadPins('/r')).toEqual({ files: { ok: { x: 1, y: 2 } }, functions: {}, folders: {} });
  });

  it('file pins are kept per level; pins stored before levels had their own load as files-level pins (F11)', () => {
    const mem = memStorage();
    mem.set('livemap:pins:/r', JSON.stringify({ files: { 'a.ts': { x: 1, y: 2 } }, folders: { 'dir:a': { x: 3, y: 4 } } }));
    const pins = loadPins('/r');
    expect(pins).toEqual({ files: { 'a.ts': { x: 1, y: 2 } }, functions: {}, folders: { 'dir:a': { x: 3, y: 4 } } });
    expect(filePins(pins, 'files')).toBe(pins.files);
    expect(filePins(pins, 'functions')).toBe(pins.functions);
    expect(filePins(pins, 'folders')).toEqual({});
    expect(fileKind('files')).toBe('files');
    expect(fileKind('functions')).toBe('functions');
  });
});
