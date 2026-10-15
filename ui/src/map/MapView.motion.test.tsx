// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { emptyDomain, file, sym } from '../fixtures';
import type { ElkRun } from '../layout/elk';
import { MOVE_S } from './mapFlow';
import { FILE_W } from './mapLayout';

/** Each move runs as three frames (start, middle, end) so tests see where the spring takes the nodes. */
const frames: number[][] = [];
const motionProps: Record<string, unknown>[] = [];
let recordingDiv: unknown;
vi.mock('framer-motion', async orig => {
  const real = await orig<typeof import('framer-motion')>();
  const React = await import('react');
  recordingDiv = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    motionProps.push(props);
    return React.createElement(real.motion.div as React.ElementType, { ...props, ref });
  });
  return {
    ...real,
    // motion.div records its props, so tests can read a card's spring-in start.
    motion: new Proxy(real.motion, {
      get(target, key, recv) {
        if (key !== 'div') return Reflect.get(target, key, recv);
        return recordingDiv;
      },
    }),
    animate: vi.fn((_from: number, _to: number, opts: { duration: number; bounce: number; onUpdate(t: number): void; onComplete(): void }) => {
      frames.push([opts.duration, opts.bounce]);
      opts.onUpdate(0);
      opts.onUpdate(0.5);
      opts.onComplete();
      return { stop() {} };
    }),
  };
});

const { MapView, forgetMapSession } = await import('./MapView');
const { animate } = await import('framer-motion');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React Flow needs these browser APIs; jsdom has neither. Its camera transitions log NaN warnings in jsdom.
const quiet = vi.spyOn(console, 'error');
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;
  class DM { m22 = 1; constructor() {} }
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DM;
  quiet.mockImplementation((...args: unknown[]) => { if (!String(args[0]).includes('NaN')) process.stderr.write(`${String(args[0])}\n`); });
});
afterAll(() => quiet.mockRestore());

const rowRun: ElkRun = async g => ({ ...g, children: g.children!.map((c, i) => ({ ...c, x: i * 900, y: 0 })) });
const imp = (path: string, local: string[], n: number): FileModel =>
  file(path, Array.from({ length: n }, (_, i) => sym(`s${i}`)), { imports: { local, external: [] } });

let host: HTMLDivElement;
let tools: HTMLDivElement;
let root: Root;

beforeEach(() => {
  frames.length = 0;
  motionProps.length = 0;
  vi.mocked(animate).mockClear();
  useStore.getState().reset();
  forgetMapSession();
  host = document.createElement('div');
  tools = document.createElement('div');
  document.body.append(host, tools);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  tools.remove();
  vi.unstubAllGlobals();
});

const wrapper = (path: string) => host.querySelector<HTMLElement>(`.node[data-path="${path}"]`)!.closest<HTMLElement>('.react-flow__node')!;

describe('MapView with motion on', () => {
  it('a level switch moves nodes with a critically damped spring and ends at the final boxes', async () => {
    useStore.getState().apply({
      type: 'hello', root: '/p/m', name: 'm', changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [],
      control: { paused: false, flags: [] },
      files: [imp('a/one.ts', ['a/two.ts'], 3), imp('a/two.ts', [], 1), imp('b/three.ts', [], 0)],
    });
    await act(async () => root.render(<MapView run={rowRun} tools={tools} />));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const twoY = Number(host.querySelector<HTMLElement>('.node[data-path="a/two.ts"]')!.dataset.y);
    const threeEl = wrapper('b/three.ts');
    expect(animate).not.toHaveBeenCalled();

    const fn = [...tools.querySelectorAll<HTMLButtonElement>('.mini-seg button')].find(b => b.textContent === 'Functions')!;
    await act(async () => { fn.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    expect(animate).toHaveBeenCalled();
    expect(frames[0]).toEqual([MOVE_S, 0]);
    // Final boxes: one.ts grew by three rows; two.ts, below it in a one-column folder, was pushed down by that much.
    expect(wrapper('a/one.ts').style.height).toBe(`${64 + 3 * 24}px`);
    expect(Number(host.querySelector<HTMLElement>('.node[data-path="a/two.ts"]')!.dataset.y)).toBe(twoY + 3 * 24);
    // A file without symbols does not move: same DOM node, same place.
    expect(wrapper('b/three.ts')).toBe(threeEl);
    expect(threeEl.style.height).toBe('64px');
  });
});

describe('spring-in for new files', () => {
  const settle = async () => {
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  };
  const start = async () => {
    useStore.getState().apply({
      type: 'hello', root: '/p/s', name: 's', changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [],
      control: { paused: false, flags: [] },
      files: [imp('a/one.ts', [], 1), imp('a/two.ts', ['a/one.ts'], 1), imp('b/three.ts', [], 1)],
    });
    await act(async () => root.render(<MapView run={rowRun} tools={tools} />));
    await settle();
  };
  const add = async (...fs: FileModel[]) => {
    await act(async () => { useStore.getState().apply({ type: 'files', files: fs, removed: [] }); });
    await settle();
  };
  const at = (path: string) => {
    const el = host.querySelector<HTMLElement>(`.node[data-path="${path}"]`)!;
    return { x: Number(el.dataset.x), y: Number(el.dataset.y) };
  };
  const spawnOf = (path: string) => motionProps.filter(p => p['data-spawn'] === path);
  const folderBox = (id: string) => {
    const el = host.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
  };

  it('a new file springs in from its placed edge partner', async () => {
    await start();
    await add(imp('b/four.ts', ['a/one.ts'], 1));
    const props = spawnOf('b/four.ts');
    expect(props.length).toBeGreaterThan(0);
    const one = at('a/one.ts'), four = at('b/four.ts');
    // Both cards are 64 px tall at the files level, so the centers differ by the corner offset.
    expect(props[0].initial).toEqual({ x: one.x - four.x, y: one.y - four.y, scale: 0.6, opacity: 0 });
    expect(props[0].animate).toEqual({ x: 0, y: 0, scale: 1, opacity: 1 });
    expect(props[0].transition).toEqual({ type: 'spring', stiffness: 260, damping: 24 });
    // Files that were there at hello do not spring.
    expect(spawnOf('a/one.ts')).toEqual([]);
    expect(spawnOf('b/three.ts')).toEqual([]);
  });

  it('a new file without a placed partner springs in from its folder center', async () => {
    await start();
    await add(imp('c/solo.ts', [], 1));
    const props = spawnOf('c/solo.ts');
    expect(props.length).toBeGreaterThan(0);
    const f = folderBox('dir:c'), solo = at('c/solo.ts');
    const init = props[0].initial as { x: number; y: number };
    expect(init.x).toBeCloseTo(f.x + f.w / 2 - (solo.x + FILE_W / 2), 0);
    expect(init.y).toBeCloseTo(f.y + f.h / 2 - (solo.y + 64 / 2), 0);
  });

  it('springs once per file per session: showing the map again does not replay it', async () => {
    await start();
    await add(imp('b/four.ts', ['a/one.ts'], 1));
    expect(spawnOf('b/four.ts').length).toBeGreaterThan(0);
    act(() => root.unmount());
    motionProps.length = 0;
    root = createRoot(host);
    await act(async () => root.render(<MapView run={rowRun} tools={tools} />));
    await settle();
    expect(host.querySelector('.node[data-path="b/four.ts"]')).not.toBeNull();
    expect(spawnOf('b/four.ts')).toEqual([]);
  });

  it('under reduced motion a new file has no initial offset', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    await start();
    await add(imp('b/four.ts', ['a/one.ts'], 1));
    expect(host.querySelector('.node[data-path="b/four.ts"]')).not.toBeNull();
    expect(spawnOf('b/four.ts')).toEqual([]);
  });
});
