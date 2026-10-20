// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { pinsKey } from './pins';
import { SAVE_DELAY, usePins, type PinStore } from './usePins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness() {
  const mem = new Map<string, string>();
  const setItem = vi.fn((k: string, v: string) => void mem.set(k, v));
  const getItem = vi.fn((k: string) => mem.get(k) ?? null);
  vi.stubGlobal('localStorage', { getItem, setItem, removeItem: (k: string) => void mem.delete(k) });
  const host = document.createElement('div');
  const root = createRoot(host);
  let store: PinStore | null = null;
  function Probe({ project }: { project: string }) { store = usePins(project); return null; }
  return { mem, setItem, getItem, root, Probe, store: () => store! };
}

describe('usePins', () => {
  it('saves 300 ms after the last pin, once', () => {
    vi.useFakeTimers();
    const h = harness();
    act(() => h.root.render(<h.Probe project="/p/a" />));
    act(() => { h.store().pin('files', 'x.ts', { x: 1, y: 2 }); });
    vi.advanceTimersByTime(SAVE_DELAY - 50);
    act(() => { h.store().pin('files', 'y.ts', { x: 3, y: 4 }); });
    vi.advanceTimersByTime(SAVE_DELAY - 1);
    expect(h.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.mem.get(pinsKey('/p/a'))!).files).toEqual({ 'x.ts': { x: 1, y: 2 }, 'y.ts': { x: 3, y: 4 } });
    act(() => h.root.unmount());
  });

  it('pins a file named __proto__ as a key, and constructor reads as unpinned (#72)', () => {
    const h = harness();
    act(() => h.root.render(<h.Probe project="/p/c" />));
    act(() => { h.store().pin('files', '__proto__', { x: 1, y: 2 }); });
    expect(Object.keys(h.store().get().files)).toEqual(['__proto__']);
    expect(h.store().get().files.constructor).toBeUndefined();
    act(() => h.store().reset());
    expect(h.store().get().folders.constructor).toBeUndefined();
    act(() => h.root.unmount());
  });

  it('writes a pending save when the project changes, then loads the new project', () => {
    vi.useFakeTimers();
    const h = harness();
    h.mem.set(pinsKey('/p/b'), JSON.stringify({ files: { 'b.ts': { x: 9, y: 9 } }, folders: {} }));
    act(() => h.root.render(<h.Probe project="/p/a" />));
    act(() => { h.store().pin('folders', 'dir:src', { x: 5, y: 6 }); });
    act(() => h.root.render(<h.Probe project="/p/b" />));
    expect(JSON.parse(h.mem.get(pinsKey('/p/a'))!).folders).toEqual({ 'dir:src': { x: 5, y: 6 } });
    expect(h.store().get().files).toEqual({ 'b.ts': { x: 9, y: 9 } });
    act(() => h.store().reset());
    expect(h.mem.has(pinsKey('/p/b'))).toBe(false);
    expect(h.store().get()).toEqual({ files: {}, functions: {}, folders: {} });
    act(() => h.root.unmount());
  });

  it('reads storage once per project, not on every render (F10)', () => {
    const h = harness();
    act(() => h.root.render(<h.Probe project="/p/a" />));
    act(() => h.root.render(<h.Probe project="/p/a" />));
    act(() => h.root.render(<h.Probe project="/p/a" />));
    expect(h.getItem).toHaveBeenCalledTimes(1);
    act(() => h.root.render(<h.Probe project="/p/b" />));
    expect(h.getItem).toHaveBeenCalledTimes(2);
    act(() => h.root.unmount());
  });

  it('functions-level file pins are saved apart from files-level ones (F11)', () => {
    vi.useFakeTimers();
    const h = harness();
    act(() => h.root.render(<h.Probe project="/p/a" />));
    act(() => { h.store().pin('functions', 'x.ts', { x: 1, y: 2 }); });
    vi.advanceTimersByTime(SAVE_DELAY);
    const saved = JSON.parse(h.mem.get(pinsKey('/p/a'))!);
    expect(saved.functions).toEqual({ 'x.ts': { x: 1, y: 2 } });
    expect(saved.files).toEqual({});
    act(() => h.root.unmount());
  });
});
