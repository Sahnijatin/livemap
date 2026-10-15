// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, sym, change, emptyDomain, event, session } from '../fixtures';
import { FileTree } from './FileTree';
import { rowRenderProbe } from './FileRow';
import { DIR_BATCH, ROW_BUDGET } from '../treeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let renders: string[];

const hello = (files: ReturnType<typeof file>[]) => ({
  type: 'hello' as const, root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
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

    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('src/a.ts', 'modified', { at: Date.now() }) }));
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
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('d1/f699.ts', 'modified', { at: Date.now() }) }));
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
    act(() => { vi.advanceTimersByTime(400); }); // past the fold animation
    expect(host.querySelector('[data-file="a/x.ts"]')).toBeNull();
    expect(header('a').querySelector('.dlive')).toBeNull();
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('a/x.ts', 'modified', { at: Date.now() }) }));
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

  it('folds a closing folder shut before removing its rows, and unfolds an opening one', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    const group = () => host.querySelector('[data-file="a/x.ts"]')?.closest('.dgroup') ?? null;
    expect(group()!.getAttribute('role')).toBe('group');
    expect(group()!.className).toBe('dgroup');
    act(() => header('a').click());
    expect(header('a').getAttribute('aria-expanded')).toBe('false');
    expect(group()!.classList.contains('fold')).toBe(true);
    expect(group()!.hasAttribute('inert')).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(group()).toBeNull();
    act(() => header('a').click());
    expect(group()!.classList.contains('unfold')).toBe(true);
    expect(group()!.hasAttribute('inert')).toBe(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(group()!.className).toBe('dgroup');
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
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('a/x.ts', 'modified', { at: Date.now() }) }));
    const dot = x().querySelector('.b-err')!;
    expect(dot.classList.contains('b-dot')).toBe(true);
    expect(dot.getAttribute('aria-label')).toBe('parse error');
    expect(dot.getAttribute('title')).toMatch(/parse error/i);
    expect(x().querySelector('.b-edit')).not.toBeNull();
    expect(x().querySelector('.fmeta')).toBeNull();
    expect(host.querySelector('[data-file="a/y.ts"] .fmeta')!.textContent).toBe('1');
  });
});

describe('FileTree live target', () => {
  const scrollSpy = vi.fn();
  const w = (store = useStore.getState()) => store;
  const working = () => session({ id: 's1', status: 'working', lastAt: Date.now() });
  const startEdit = (path: string) =>
    event({ sessionId: 's1', type: 'tool_start', at: Date.now(), tool: { id: 'x1', name: 'Edit', label: 'Edit', paths: [path] } });
  const target = (path: string) => {
    act(() => w().apply({ type: 'session', session: working() }));
    act(() => w().apply({ type: 'agentEvent', event: startEdit(path) }));
  };

  beforeEach(() => {
    scrollSpy.mockClear();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
  });
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

  it('shows NOW on the target and suppresses New on it', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts')]));
    mount();
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('src/a.ts', 'created', { at: Date.now() }) }));
    expect(host.querySelector('.b-new')).not.toBeNull();
    target('src/a.ts');
    const row = host.querySelector('[data-file="src/a.ts"]')!;
    expect(row.querySelector('.b-now')?.textContent).toBe('Now');
    expect(row.querySelector('.b-new')).toBeNull();
    expect(host.querySelectorAll('.b-now')).toHaveLength(1);
  });

  it('expands a collapsed folder and scrolls the target into view without changing selection', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('lib/b.ts')]));
    mount();
    act(() => host.querySelector<HTMLElement>('[data-dir="lib"]')!.click());
    act(() => { vi.advanceTimersByTime(400); }); // past the fold animation
    expect(host.querySelector('[data-file="lib/b.ts"]')).toBeNull();
    const before = useStore.getState().selected;
    target('lib/b.ts');
    expect(host.querySelector('[data-file="lib/b.ts"]')).not.toBeNull();
    expect(scrollSpy).toHaveBeenCalled();
    expect(useStore.getState().selected).toBe(before);
  });

  it('does not scroll after the user scrolled the tree within 5 s, and resumes after', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts')]));
    mount();
    act(() => { host.querySelector('.tree')!.dispatchEvent(new Event('scroll')); });
    target('src/a.ts');
    expect(scrollSpy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(6000); }); // the hold ends: the waiting target is revealed
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    act(() => w().apply({ type: 'agentEvent', event: { ...startEdit('src/b.ts'), tool: { id: 'x2', name: 'Edit', label: 'Edit', paths: ['src/b.ts'] } } }));
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });

  it('a target that changes during the hold is revealed once the hold ends', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts')]));
    mount();
    act(() => { host.querySelector('.tree')!.dispatchEvent(new Event('scroll')); });
    target('src/a.ts');
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => w().apply({ type: 'agentEvent', event: { ...startEdit('src/b.ts'), tool: { id: 'x2', name: 'Edit', label: 'Edit', paths: ['src/b.ts'] } } }));
    expect(scrollSpy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3100); });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect((scrollSpy.mock.contexts[0] as HTMLElement).dataset.file).toBe('src/b.ts');
  });

  it('a path with a newline is revealed without breaking the tree', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/we\nird.ts')]));
    mount();
    target('src/we\nird.ts');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-file]')).not.toBeNull();
  });

  it('ignores scroll events caused by its own smooth scroll, but not wheel; scrollend ends the guard', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts'), file('src/c.ts')]));
    mount();
    const tree = host.querySelector('.tree')!;
    const next = (path: string, id: string) =>
      act(() => w().apply({ type: 'agentEvent', event: { ...startEdit(path), tool: { id, name: 'Edit', label: 'Edit', paths: [path] } } }));
    target('src/a.ts');
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    act(() => { tree.dispatchEvent(new Event('scroll')); }); // our own animation
    next('src/b.ts', 'x2');
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    act(() => { tree.dispatchEvent(new Event('wheel', { bubbles: true })); }); // always the user
    next('src/c.ts', 'x3');
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(6000); }); // the hold ends: the waiting src/c.ts is revealed
    expect(scrollSpy).toHaveBeenCalledTimes(3);
    next('src/a.ts', 'x4');
    expect(scrollSpy).toHaveBeenCalledTimes(4);
    act(() => { tree.dispatchEvent(new Event('scrollend')); });
    act(() => { tree.dispatchEvent(new Event('scroll')); }); // after scrollend a scroll is the user's
    next('src/b.ts', 'x5');
    expect(scrollSpy).toHaveBeenCalledTimes(4);
  });

  it('uses instant scrolling under reduced motion and smooth otherwise', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts')]));
    mount();
    target('src/a.ts');
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' });
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      act(() => { vi.advanceTimersByTime(1000); });
      act(() => w().apply({ type: 'agentEvent', event: { ...startEdit('src/b.ts'), tool: { id: 'x2', name: 'Edit', label: 'Edit', paths: ['src/b.ts'] } } }));
      expect(scrollSpy.mock.calls[1][0]).toMatchObject({ behavior: 'auto' });
    } finally { window.matchMedia = orig; }
  });

  it('does not re-render the tree for agent events that leave the target unchanged', () => {
    useStore.getState().apply(hello([file('src/a.ts'), file('src/b.ts')]));
    mount();
    target('src/a.ts');
    renders.length = 0;
    act(() => w().apply({ type: 'agentEvent', event: event({ sessionId: 's1', type: 'message', text: 'thinking out loud' }) }));
    expect(renders).toEqual([]);
  });
});
