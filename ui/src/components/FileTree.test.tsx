// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, sym, change } from '../fixtures';
import { FileTree } from './FileTree';
import { rowRenderProbe } from './FileRow';
import { DIR_BATCH, ROW_BUDGET } from '../treeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let renders: string[];

const hello = (files: ReturnType<typeof file>[]) => ({
  type: 'hello' as const, root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
});
const rows = () => host.querySelectorAll('.frow').length;

function mount() {
  act(() => root.render(<FileTree />));
  act(() => { vi.advanceTimersByTime(2000); }); // past the hello pop window
  renders.length = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  renders = [];
  rowRenderProbe.fn = p => renders.push(p);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  rowRenderProbe.fn = null;
  vi.useRealTimers();
});

describe('FileTree rendering cost', () => {
  it('does not re-render unchanged rows on unrelated messages, file updates elsewhere, or the clock', () => {
    useStore.getState().apply(hello([file('src/a.ts', [sym('a')]), file('src/b.ts', [sym('b')]), file('src/c.ts')]));
    mount();
    expect(rows()).toBe(3);

    act(() => useStore.getState().apply({ type: 'usedBy', usedBy: [{ file: 'src/a.ts', symbol: 'a', usedIn: ['src/b.ts'] }] }));
    expect(renders).toEqual([]);

    act(() => useStore.getState().apply({ type: 'files', files: [file('src/b.ts', [sym('b'), sym('b2')])], removed: [] }));
    expect(renders).toEqual(['src/b.ts']);

    renders.length = 0;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(renders).toEqual([]);
  });

  it('re-renders only the changed row for a change, and again only when its badge expires', () => {
    useStore.getState().apply(hello([file('src/a.ts', [sym('a')]), file('src/b.ts'), file('src/c.ts')]));
    mount();

    act(() => useStore.getState().apply({ type: 'change', change: change('src/a.ts', 'modified', { at: Date.now() }) }));
    expect(new Set(renders)).toEqual(new Set(['src/a.ts']));
    expect(host.querySelector('.b-edit')).not.toBeNull();

    renders.length = 0;
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(renders).toEqual([]);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(host.querySelector('.b-edit')).toBeNull();
    expect(new Set(renders)).toEqual(new Set(['src/a.ts']));
  });

  it('moving focus with the keyboard re-renders at most the two rows involved', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts'), file('src/c.ts'), file('src/d.ts')]));
    mount();
    const a = host.querySelector<HTMLElement>('[data-nav="src/a.ts"]')!;
    act(() => a.focus());
    renders.length = 0;
    act(() => { a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect((document.activeElement as HTMLElement).dataset.nav).toBe('src/b.ts');
    expect(renders.length).toBeLessThanOrEqual(2);
    expect(renders).not.toContain('src/c.ts');
    expect(renders).not.toContain('src/d.ts');
  });
});

describe('FileTree render cap', () => {
  it('opens folders by default in small projects', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    expect(rows()).toBe(2);
  });

  it('collapses folders above 2,000 files and renders each folder in batches with Show more', () => {
    const files = [];
    for (let i = 0; i < 1200; i++) files.push(file(`big/f${String(i).padStart(4, '0')}.ts`));
    for (let d = 0; d < 4; d++) for (let i = 0; i < 300; i++) files.push(file(`d${d}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    expect(rows()).toBe(0);
    expect(host.querySelectorAll('.dir')).toHaveLength(5);

    act(() => host.querySelector<HTMLElement>('[data-dir="big"]')!.click());
    expect(DIR_BATCH).toBe(200);
    expect(rows()).toBe(200);
    const more = () => host.querySelector<HTMLElement>('[data-nav="more:big"]');
    expect(more()!.textContent).toBe('Show 200 more (1,000 hidden)');
    for (let i = 0; i < 4; i++) act(() => more()!.click());
    expect(rows()).toBe(1000);
    expect(more()!.textContent).toBe('Show 200 more (200 hidden)');
    act(() => more()!.click());
    expect(rows()).toBe(1200);
    expect(more()).toBeNull();
  });

  it('caps the total across folders (a filter that matches everything), keeping every folder header', () => {
    const files = [];
    for (let d = 0; d < 7; d++) for (let i = 0; i < 300; i++) files.push(file(`d${d}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    act(() => useStore.getState().setFilter('/f'));
    expect(ROW_BUDGET).toBe(1000);
    expect(rows()).toBe(1000);
    expect(host.querySelectorAll('.dir')).toHaveLength(7);
    expect(host.querySelector('[data-nav="more:d6"]')!.textContent).toBe('Show 200 more (300 hidden)');
    act(() => host.querySelector<HTMLElement>('[data-nav="more:d6"]')!.click());
    expect(host.querySelectorAll('[data-file^="d6/"]')).toHaveLength(200);
  });

  it('opens the folder of a file that is changing even in a big project, and shows it past the cap', () => {
    const files = [];
    for (let d = 0; d < 3; d++) for (let i = 0; i < 700; i++) files.push(file(`d${d}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    act(() => useStore.getState().apply({ type: 'change', change: change('d1/f699.ts', 'modified', { at: Date.now() }) }));
    expect(rows()).toBe(DIR_BATCH + 1);
    expect(host.querySelector('[data-file="d1/f699.ts"] .b-edit')).not.toBeNull();
  });
});

describe('FileTree collapsed folder indicator', () => {
  const header = (dir: string) => host.querySelector<HTMLElement>(`[data-dir="${dir}"]`)!;

  it('marks a user-closed folder whose file is changing, and clears it when reopened', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    act(() => header('a').click()); // user closes folder a
    expect(host.querySelector('[data-file="a/x.ts"]')).toBeNull();
    expect(header('a').querySelector('.dlive')).toBeNull();
    act(() => useStore.getState().apply({ type: 'change', change: change('a/x.ts', 'modified', { at: Date.now() }) }));
    expect(host.querySelector('[data-file="a/x.ts"]')).toBeNull(); // the user's choice is kept
    const dot = header('a').querySelector('.dlive')!;
    expect(dot).not.toBeNull();
    expect(dot.getAttribute('aria-label')).toBe('changed');
    expect(dot.classList.contains('pulse')).toBe(true);
    expect(header('b').querySelector('.dlive')).toBeNull();
    act(() => header('a').click()); // reopened: the row itself shows the badge
    expect(header('a').querySelector('.dlive')).toBeNull();
    expect(host.querySelector('[data-file="a/x.ts"] .b-edit')).not.toBeNull();
  });

  it('marks a user-closed folder that holds the selected file', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    act(() => useStore.getState().select('b/y.ts'));
    act(() => header('b').click());
    const dot = header('b').querySelector('.dlive')!;
    expect(dot).not.toBeNull();
    expect(dot.getAttribute('aria-label')).toBe('contains the selected file');
    expect(header('a').querySelector('.dlive')).toBeNull();
  });
});

describe('FileRow badges', () => {
  it('shows parse error as a labeled dot next to a live badge and hides the symbol count', () => {
    useStore.getState().apply(hello([file('a/x.ts', [sym('f')], { flags: { parseError: true } }), file('a/y.ts', [sym('g')])]));
    mount();
    const x = () => host.querySelector('[data-file="a/x.ts"]')!;
    expect(x().querySelector('.b-err')!.textContent).toBe('parse error'); // alone: full text
    expect(x().querySelector('.fmeta')).toBeNull();
    act(() => useStore.getState().apply({ type: 'change', change: change('a/x.ts', 'modified', { at: Date.now() }) }));
    const dot = x().querySelector('.b-err')!;
    expect(dot.classList.contains('b-dot')).toBe(true);
    expect(dot.getAttribute('aria-label')).toBe('parse error');
    expect(dot.getAttribute('title')).toMatch(/parse error/i);
    expect(x().querySelector('.b-edit')).not.toBeNull();
    expect(x().querySelector('.fmeta')).toBeNull();
    expect(host.querySelector('[data-file="a/y.ts"] .fmeta')!.textContent).toBe('1');
  });
});
