// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, change } from '../fixtures';
import { lineScrollTop } from '../scroll';

vi.mock('../highlight', () => ({ MAX_HIGHLIGHT_LINES: 5000, highlight: async () => null }));
const { CodeView } = await import('./CodeView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LINE_H = 20;
const PAD = 10;
const BOX_H = 560;
/** Where the code box sits in the page: below the inspector header, symbols and chips. */
const BOX_TOP = 650;

/**
 * jsdom has no layout, so give elements one: the box at BOX_TOP, line n at BOX_TOP + PAD + (n-1)*LINE_H
 * minus the box's scroll, and an offsetTop that (like the real bug) is measured from a far ancestor.
 */
function fakeLayout() {
  const scroll = new WeakMap<Element, number>();
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return scroll.get(this) ?? 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, v: number) { scroll.set(this, v); });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('code') ? BOX_H : 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    const n = Number(this.dataset.line);
    return n ? BOX_TOP + PAD + (n - 1) * LINE_H : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const box = el.closest('.code') as HTMLElement | null;
    let top = 0;
    if (el.classList.contains('code')) top = BOX_TOP;
    else if (el.dataset.line && box) top = BOX_TOP + PAD + (Number(el.dataset.line) - 1) * LINE_H - (scroll.get(box) ?? 0);
    return { top, bottom: top + LINE_H, left: 0, right: 0, width: 0, height: LINE_H, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  Element.prototype.scrollIntoView = vi.fn();
}

const expected = (line: number) => Math.round(PAD + (line - 1) * LINE_H - BOX_H / 3);

describe('lineScrollTop', () => {
  it('measures from the code box, not from the offsetParent', () => {
    fakeLayout();
    const box = document.createElement('pre');
    box.className = 'code';
    for (let n = 1; n <= 300; n++) { const d = document.createElement('div'); d.dataset.line = String(n); box.appendChild(d); }
    document.body.appendChild(box);
    const line = box.querySelector<HTMLElement>('[data-line="200"]')!;
    expect(lineScrollTop(box, line)).toBe(expected(200));
    box.scrollTop = 1234; // already scrolled: same answer
    expect(lineScrollTop(box, line)).toBe(expected(200));
    expect(lineScrollTop(box, box.querySelector<HTMLElement>('[data-line="2"]')!)).toBe(0);
    box.remove();
    vi.restoreAllMocks();
  });
});

describe('CodeView scrolling', () => {
  let host: HTMLDivElement;
  let root: Root;
  const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  beforeEach(() => {
    fakeLayout();
    useStore.getState().reset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ path: 'a.ts', content }), { status: 200 })));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
  const box = () => host.querySelector<HTMLElement>('pre.code')!;

  it('auto-scrolls to the first changed line near line 200 of a 300-line file', async () => {
    const f = file('a.ts', [], { lines: 300 });
    const c = change('a.ts', 'modified', { hunks: [{ oldStart: 198, newStart: 198, lines: [' x', ' y', '-old', '+new', ' z'] }] });
    act(() => root.render(<CodeView file={f} change={c} />));
    await settle();
    expect(box().querySelectorAll('[data-line]')).toHaveLength(300);
    expect(box().querySelector('[data-line="200"]')!.className).toBe('hl');
    expect(box().scrollTop).toBe(expected(200));
  });

  it('reveals a symbol line, flashes it, and clears the reveal request', async () => {
    const f = file('a.ts', [], { lines: 300 });
    act(() => root.render(<CodeView file={f} change={undefined} />));
    await settle();
    act(() => useStore.getState().revealLine('a.ts', 250));
    await settle();
    expect(box().scrollTop).toBe(expected(250));
    expect(box().querySelector('[data-line="250"]')!.classList.contains('flash')).toBe(true);
    expect(useStore.getState().reveal).toBeNull();
  });
});
