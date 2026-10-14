// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, useContext, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfigContext } from 'framer-motion';
import { EASE, LAYOUT, MotionRoot, SPRING, useGlide, useLeaving, usePrefersReducedMotion, usePresenceList } from './motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let reduce = false;
let listeners: (() => void)[] = [];
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  reduce = false;
  listeners = [];
  window.matchMedia = ((q: string) => ({
    get matches() { return q.includes('prefers-reduced-motion: reduce') && reduce; },
    media: q,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => { listeners = listeners.filter(l => l !== fn); },
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});

describe('motion tokens', () => {
  it('match spec §10: movement easing, gentle spring, critically damped layout', () => {
    expect(EASE).toEqual([0.32, 0.72, 0, 1]);
    expect(SPRING).toEqual({ type: 'spring', stiffness: 380, damping: 32 });
    expect(LAYOUT).toEqual({ type: 'spring', bounce: 0, duration: 0.45 });
  });
});

describe('usePrefersReducedMotion', () => {
  let seen: boolean[];
  function Probe() { seen.push(usePrefersReducedMotion()); return null; }
  beforeEach(() => { seen = []; });

  it('is true when matchMedia reports prefers-reduced-motion: reduce', () => {
    reduce = true;
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(true);
  });

  it('is false otherwise, and follows changes to the setting', () => {
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    reduce = true;
    act(() => listeners.forEach(l => l()));
    expect(seen.at(-1)).toBe(true);
  });
});

describe('MotionRoot', () => {
  let config: { reducedMotion?: string; skipAnimations?: boolean; transition?: unknown } | null;
  function Probe() { config = useContext(MotionConfigContext); return null; }
  beforeEach(() => { config = null; });

  it('passes reducedMotion="user" and the 0.45 s movement easing as the default transition', () => {
    act(() => root.render(<MotionRoot><Probe /></MotionRoot>));
    expect(config!.reducedMotion).toBe('user');
    expect(config!.transition).toEqual({ duration: 0.45, ease: EASE });
    expect(config!.skipAnimations).toBe(false);
  });

  it('skips every framer-motion animation (opacity included) under reduced motion', () => {
    reduce = true;
    act(() => root.render(<MotionRoot><Probe /></MotionRoot>));
    expect(config!.reducedMotion).toBe('user');
    expect(config!.skipAnimations).toBe(true);
  });
});

describe('useLeaving', () => {
  let out: { prev: string | null; from: string | null };
  function Probe({ v }: { v: string }) { out = useLeaving(v, 200); return null; }

  it('keeps the previous value while it leaves, then drops it; `from` remembers where the change came from', () => {
    vi.useFakeTimers();
    act(() => root.render(<Probe v="a" />));
    expect(out).toEqual({ prev: null, from: null });
    act(() => root.render(<Probe v="b" />));
    expect(out).toEqual({ prev: 'a', from: 'a' });
    act(() => { vi.advanceTimersByTime(199); });
    expect(out.prev).toBe('a');
    act(() => { vi.advanceTimersByTime(2); });
    expect(out).toEqual({ prev: null, from: 'a' });
  });

  it('has nothing leaving under reduced motion', () => {
    reduce = true;
    act(() => root.render(<Probe v="a" />));
    act(() => root.render(<Probe v="b" />));
    expect(out).toEqual({ prev: null, from: 'a' });
  });
});

describe('usePresenceList', () => {
  let out: { item: string; leaving: boolean }[];
  function Probe({ items }: { items: string[] }) { out = usePresenceList(items, s => s, 250); return null; }

  it('keeps a removed item in place, marked leaving, until its exit ends', () => {
    vi.useFakeTimers();
    act(() => root.render(<Probe items={['a', 'b', 'c']} />));
    act(() => root.render(<Probe items={['a', 'c']} />));
    expect(out).toEqual([{ item: 'a', leaving: false }, { item: 'b', leaving: true }, { item: 'c', leaving: false }]);
    act(() => { vi.advanceTimersByTime(260); });
    expect(out).toEqual([{ item: 'a', leaving: false }, { item: 'c', leaving: false }]);
  });

  it('an item that comes back while leaving is present again', () => {
    vi.useFakeTimers();
    act(() => root.render(<Probe items={['a', 'b']} />));
    act(() => root.render(<Probe items={['a']} />));
    act(() => root.render(<Probe items={['a', 'b']} />));
    expect(out).toEqual([{ item: 'a', leaving: false }, { item: 'b', leaving: false }]);
    act(() => { vi.advanceTimersByTime(300); });
    expect(out.map(o => o.item)).toEqual(['a', 'b']);
  });

  it('drops removed items at once under reduced motion', () => {
    reduce = true;
    act(() => root.render(<Probe items={['a', 'b']} />));
    act(() => root.render(<Probe items={['b']} />));
    expect(out).toEqual([{ item: 'b', leaving: false }]);
  });
});

describe('useGlide (F9)', () => {
  type Cb = (entries: ResizeObserverEntry[]) => void;
  let observers: Cb[] = [];
  const realRO = globalThis.ResizeObserver;
  beforeEach(() => {
    observers = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: Cb) { observers.push(cb); }
      observe() {} unobserve() {} disconnect() {}
    };
  });
  afterEach(() => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO; });

  const entry = (target: Element, h: number, w: number) =>
    ({ target, borderBoxSize: [{ blockSize: h, inlineSize: w }], contentRect: { height: h, width: w } }) as unknown as ResizeObserverEntry;

  function Column() {
    const box = useRef<HTMLDivElement>(null);
    useGlide(box);
    return <div ref={box}><section id="s1">one</section></div>;
  }

  function mountColumn() {
    act(() => root.render(<Column />));
    const col = host.firstElementChild as HTMLElement;
    Object.defineProperty(col, 'clientHeight', { configurable: true, get: () => 800 });
    const s1 = host.querySelector<HTMLElement>('#s1')!;
    const animate = vi.fn(() => ({ onfinish: null, oncancel: null }));
    (s1 as unknown as { animate: unknown }).animate = animate;
    // Layout reads in the observer callback would force a reflow: sizes must come from the entries.
    const reads = vi.fn(() => 999);
    Object.defineProperty(s1, 'offsetHeight', { configurable: true, get: reads });
    Object.defineProperty(s1, 'offsetWidth', { configurable: true, get: reads });
    return { s1, animate, reads };
  }

  it('glides a height change, using the sizes the observer reports', () => {
    const { s1, animate, reads } = mountColumn();
    act(() => observers[0]([entry(s1, 100, 300)]));
    act(() => observers[0]([entry(s1, 160, 300)]));
    expect(animate).toHaveBeenCalledTimes(1);
    const frames = (animate.mock.calls[0] as unknown[])[0] as { height: string }[];
    expect(frames[0].height).toBe('100px');
    expect(frames[1].height).toBe('160px');
    expect(reads).not.toHaveBeenCalled();
  });

  it('does not glide when the width changed too (a resize reflows the text, not a content change)', () => {
    const { s1, animate } = mountColumn();
    act(() => observers[0]([entry(s1, 100, 300)]));
    act(() => observers[0]([entry(s1, 160, 240)]));
    expect(animate).not.toHaveBeenCalled();
    // The new size is the base for the next change.
    act(() => observers[0]([entry(s1, 200, 240)]));
    expect(animate).toHaveBeenCalledTimes(1);
  });
});
