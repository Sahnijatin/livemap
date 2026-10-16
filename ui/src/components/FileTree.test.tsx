// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, sym, change, emptyDomain, event, session } from '../fixtures';
import { FileTree, loadTreeKeys, treeKeysLoader } from './FileTree';
import { rowRenderProbe } from './FileRow';
import { DIR_BATCH, ROW_BUDGET, dirKey, moreKey } from '../treeModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let renders: string[];

const hello = (files: ReturnType<typeof file>[]) => ({
  type: 'hello' as const, root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
});
const rows = () => host.querySelectorAll('.frow').length;
/** The row with this nav key (keys can hold characters a CSS selector cannot). */
const navEl = (k: string) => [...host.querySelectorAll<HTMLElement>('[data-nav]')].find(e => e.dataset.nav === k) ?? null;

function mount() {
  act(() => root.render(<FileTree />));
  act(() => { vi.advanceTimersByTime(2000); }); // past the hello pop window
  renders.length = 0;
}

beforeAll(async () => { await loadTreeKeys(); });
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
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
    const more = () => navEl(moreKey('big'));
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
    expect(rows() + 7).toBe(ROW_BUDGET); // the 7 folder rows count against the budget too
    expect(host.querySelectorAll('.dir')).toHaveLength(7);
    expect(navEl(moreKey('d6'))!.textContent).toBe('Show 200 more (300 hidden)');
    act(() => navEl(moreKey('d6'))!.click());
    expect(host.querySelectorAll('[data-file^="d6/"]')).toHaveLength(200);
  });

  it('in a big project a change marks its collapsed folders; an open folder shows the changing file past the cap', () => {
    const files = [];
    for (let d = 0; d < 3; d++) for (let i = 0; i < 700; i++) files.push(file(`d${d}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('d1/f699.ts', 'modified', { at: Date.now() }) }));
    expect(rows()).toBe(0);
    expect(host.querySelector('[data-dir="d1"] .dlive')!.getAttribute('aria-label')).toBe('edited');
    act(() => host.querySelector<HTMLElement>('[data-dir="d1"]')!.click());
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
    expect(dot.getAttribute('aria-label')).toBe('edited');
    expect(dot.classList.contains('pulse')).toBe(false); // only a file being written pulses
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
    localStorage.setItem('livemap:tree:/p/shop', JSON.stringify([['lib', false]])); // closed in an earlier session
    useStore.getState().apply(hello([file('src/a.ts'), file('lib/b.ts')]));
    mount();
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

/** The element whose data-`key` is exactly `value` (jsdom has no CSS.escape). */
const byData = (key: 'dir' | 'file', value: string) =>
  [...host.querySelectorAll<HTMLElement>(`[data-${key}]`)].find(e => e.dataset[key] === value) ?? null;
const stored = () => JSON.parse(localStorage.getItem('livemap:tree:/p/shop') ?? 'null') as [string, boolean][] | null;

describe('FileTree folders', () => {
  const dir = (path: string) => host.querySelector<HTMLElement>(`[data-dir="${path}"]`);
  const key = (k: string, el = document.activeElement as HTMLElement) =>
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  const focused = () => (document.activeElement as HTMLElement).dataset.nav;
  const scrollSpy = vi.fn();
  beforeEach(() => {
    scrollSpy.mockClear();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
  });
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

  it('nests folders by name as on disk, folders first, root files at the top level', () => {
    useStore.getState().apply(hello([file('README.md'), file('Web/App.tsx'), file('Web/lib/util.ts'), file('.agents/skills/a/SKILL.md'), file('.agents/skills/b/SKILL.md')]));
    mount();
    const tree = host.querySelector('[role=tree]')!;
    const top = [...tree.querySelectorAll<HTMLElement>('[role=treeitem][aria-level="1"]')].map(e => e.dataset.nav);
    expect(top).toEqual([dirKey('.agents/skills'), dirKey('Web'), 'README.md']);
    expect(dir('.agents/skills')!.querySelector('.fn')!.textContent).toBe('.agents/skills');
    expect(dir('.agents/skills')!.getAttribute('title')).toBe('.agents/skills · 2 files');
    expect(dir('Web')!.querySelector('b')!.textContent).toBe('2');
    expect(dir('Web')!.getAttribute('aria-expanded')).toBe('true'); // a small project starts fully open
    expect(dir('Web/lib')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('Web/lib')!.getAttribute('aria-level')).toBe('2');
    expect(host.querySelector('[data-file="Web/App.tsx"]')!.getAttribute('aria-level')).toBe('2');
    expect(host.querySelector('[data-file="Web/lib/util.ts"]')!.getAttribute('aria-level')).toBe('3');
  });

  it('shows only the top level at 2,000 files, and everything open below that', () => {
    const files = [];
    for (let i = 0; i < 2000; i++) files.push(file(`d${i % 4}/sub/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    expect([...host.querySelectorAll<HTMLElement>('[role=treeitem]')].map(e => e.dataset.nav)).toEqual([dirKey('d0/sub'), dirKey('d1/sub'), dirKey('d2/sub'), dirKey('d3/sub')]);
  });

  it('decides the default once per project: crossing 2,000 files mid-session keeps folders as they are', () => {
    const files = [];
    for (let i = 0; i < 1999; i++) files.push(file(`d${i % 4}/sub/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    expect(host.querySelector('[data-file="d0/sub/f0.ts"]')).not.toBeNull();
    act(() => useStore.getState().apply({ type: 'files', files: [file('top.ts'), file('d0/sub/new.ts')], removed: [] }));
    expect(host.querySelector('[data-file="d0/sub/f0.ts"]')).not.toBeNull();
    expect(dir('d1/sub')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('typeahead finds any folder in a compact row', () => {
    useStore.getState().apply(hello([file('src/app/page.tsx'), file('lib/a.ts')]));
    mount();
    act(() => dir('lib')!.focus());
    key('a');
    key('p');
    expect(focused()).toBe(dirKey('src/app'));
  });

  it('keeps other folders still while a closing folder folds', () => {
    const files = [];
    for (let d = 0; d < 6; d++) for (let i = 0; i < 200; i++) files.push(file(`d${d}/f${String(i).padStart(3, '0')}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    const count = (d: string) => host.querySelectorAll(`[data-file^="${d}/"]`).length;
    expect([0, 1, 2, 3, 4, 5].map(d => count(`d${d}`))).toEqual([200, 200, 200, 200, 194, 0]); // 6 folder rows count too
    act(() => dir('d0')!.click());
    expect(count('d0')).toBe(200); // still folding
    expect([1, 2, 3, 4, 5].map(d => count(`d${d}`))).toEqual([200, 200, 200, 200, 194]);
    act(() => { vi.advanceTimersByTime(400); });
    expect(count('d0')).toBe(0);
    expect([1, 2, 3, 4, 5].map(d => count(`d${d}`))).toEqual([200, 200, 200, 200, 194]);
  });

  it('remembers opened and closed folders per project across remounts, ignoring folders that are gone', () => {
    useStore.getState().apply(hello([file('a/b/x.ts'), file('a/y.ts'), file('c/z.ts')]));
    mount();
    act(() => dir('a/b')!.click());
    act(() => dir('c')!.click());
    act(() => dir('c')!.click());
    expect(localStorage.getItem('livemap:tree:/p/shop')).toBeNull(); // saved after a 300 ms pause
    act(() => { vi.advanceTimersByTime(300); });
    expect(stored()).toEqual([['a/b', false], ['c', true]]);
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem('livemap:tree:/p/shop', JSON.stringify({ 'a/b': false, c: false, gone: true, bad: 3 }));
    mount();
    expect(host.querySelector('[data-file="a/b/x.ts"]')).toBeNull();
    expect(host.querySelector('[data-file="a/y.ts"]')).not.toBeNull();
    expect(host.querySelector('[data-file="c/z.ts"]')).toBeNull();
    localStorage.setItem('livemap:tree:/p/shop', '{not json');
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(host.querySelector('[data-file="c/z.ts"]')).not.toBeNull();
  });

  it('a compact chain splits when a file lands in its middle and keeps its open state', () => {
    useStore.getState().apply(hello([file('src/app/(admin)/page.tsx'), file('lib/a.ts')]));
    mount();
    expect(dir('src/app/(admin)')!.querySelector('.fn')!.textContent).toBe('src/app/(admin)');
    expect(host.querySelector('[data-file="src/app/(admin)/page.tsx"]')).not.toBeNull();
    act(() => dir('lib')!.click()); // a user choice elsewhere survives the update
    act(() => useStore.getState().apply({ type: 'files', files: [file('src/app/layout.tsx')], removed: [] }));
    expect(dir('src/app/(admin)')!.querySelector('.fn')!.textContent).toBe('(admin)'); // its own row now
    expect(dir('src/app')!.querySelector('.fn')!.textContent).toBe('src/app');
    expect(dir('src/app')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('src/app/(admin)')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('src/app/(admin)')!.getAttribute('aria-level')).toBe('2');
    expect(host.querySelector('[data-file="src/app/(admin)/page.tsx"]')).not.toBeNull();
    expect(dir('lib')!.getAttribute('aria-expanded')).toBe('false');
    // Removing the file joins the chain again, still open; removing the last file drops the folder.
    act(() => useStore.getState().apply({ type: 'files', files: [], removed: ['src/app/layout.tsx'] }));
    expect(dir('src/app/(admin)')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('src/app/(admin)')!.querySelector('.fn')!.textContent).toBe('src/app/(admin)');
    act(() => useStore.getState().apply({ type: 'files', files: [], removed: ['src/app/(admin)/page.tsx'] }));
    expect(dir('src/app/(admin)')).toBeNull();
    expect(dir('src')).toBeNull();
  });

  it('marks collapsed folders above a file the agent is writing, at any depth', () => {
    useStore.getState().apply(hello([file('a/b/c/x.ts'), file('a/b/y.ts'), file('a/z.ts')]));
    mount();
    act(() => dir('a')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('a/b/c/x.ts', 'created', { at: Date.now() }) }));
    expect(dir('a')!.querySelector('.dlive')!.getAttribute('aria-label')).toBe('new');
    expect(dir('a')!.querySelector('.dlive')!.classList.contains('new')).toBe(true);
  });

  it('moves with the arrow keys: Right opens then enters, Left closes then goes up, Home and End', () => {
    useStore.getState().apply(hello([file('a/b/x.ts'), file('a/y.ts'), file('z.ts')]));
    mount();
    act(() => dir('a/b')!.click()); // start with a/b closed
    act(() => { vi.advanceTimersByTime(400); });
    const a = dir('a')!;
    act(() => a.focus());
    key('ArrowDown');
    expect(focused()).toBe(dirKey('a/b'));
    key('ArrowRight');
    expect(dir('a/b')!.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe(dirKey('a/b'));
    key('ArrowRight');
    expect(focused()).toBe('a/b/x.ts');
    key('ArrowLeft');
    expect(focused()).toBe(dirKey('a/b'));
    key('ArrowLeft');
    expect(dir('a/b')!.getAttribute('aria-expanded')).toBe('false');
    key('ArrowLeft');
    expect(focused()).toBe(dirKey('a'));
    key('End');
    expect(focused()).toBe('z.ts');
    key('ArrowLeft'); // a root file has no parent: focus stays
    expect(focused()).toBe('z.ts');
    key('Home');
    expect(focused()).toBe(dirKey('a'));
    key('y'); // typeahead
    expect(focused()).toBe('a/y.ts');
    expect(host.querySelectorAll('[role=treeitem][tabindex="0"]')).toHaveLength(1);
  });

  it('opens the folders above a file selected elsewhere and scrolls it into view', () => {
    const files = [];
    for (let i = 0; i < 2100; i++) files.push(file(`pkg/m${i % 3}/deep/f${i}.ts`));
    files.push(file('pkg/other.ts'));
    useStore.getState().apply(hello(files));
    mount();
    expect(rows()).toBe(0);
    act(() => useStore.getState().select('pkg/m1/deep/f1.ts'));
    const row = host.querySelector<HTMLElement>('[data-file="pkg/m1/deep/f1.ts"]')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(scrollSpy.mock.contexts.at(-1)).toBe(row);
    expect(dir('pkg/m0/deep')!.getAttribute('aria-expanded')).toBe('false'); // m0/deep is one compact row
  });

  it('a filter opens the folders above matches and hides the rest; clearing it restores the folders', () => {
    useStore.getState().apply(hello([file('src/app/(admin)/users/page.tsx'), file('src/app/(admin)/orders/page.tsx'), file('src/lib/a.ts'), file('docs/x.md', [sym('users')])]));
    mount();
    act(() => dir('docs')!.click()); // user closes docs
    act(() => useStore.getState().setFilter('users'));
    expect(dir('src/app/(admin)/users')!.querySelector('.fn')!.textContent).toBe('src/app/(admin)/users');
    expect(host.querySelector('[data-file="src/app/(admin)/users/page.tsx"]')).not.toBeNull();
    expect(host.querySelector('[data-file="src/lib/a.ts"]')).toBeNull();
    expect(host.querySelector('[data-file="docs/x.md"]')).not.toBeNull(); // symbol match, folder forced open
    act(() => dir('src/app/(admin)/users')!.click()); // closing during a filter is not remembered
    act(() => { vi.advanceTimersByTime(400); }); // past the fold animation
    expect(host.querySelector('[data-file="src/app/(admin)/users/page.tsx"]')).toBeNull();
    act(() => useStore.getState().setFilter(''));
    expect(dir('docs')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('src')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('src/app/(admin)')!.getAttribute('aria-expanded')).toBe('true');
    act(() => { vi.advanceTimersByTime(300); });
    expect(stored()).toEqual([['docs', false]]);
  });

  it('shows a newline in a name as a visible symbol', () => {
    useStore.getState().apply(hello([file('src/we\nird.ts')]));
    mount();
    const row = byData('file', 'src/we\nird.ts')!;
    expect(row.querySelector('.fn')!.textContent).toBe('we\u2424ird.ts');
    expect(row.getAttribute('title')).toBe('src/we\nird.ts');
  });

  it('keeps the start and end of a long name visible and the full path in the tooltip', () => {
    useStore.getState().apply(hello([file('tests/api/bounty-contract-route.test.ts')]));
    mount();
    const row = host.querySelector<HTMLElement>('[data-file="tests/api/bounty-contract-route.test.ts"]')!;
    const parts = [...row.querySelectorAll('.fn > span')].map(s => s.textContent);
    expect(parts).toEqual(['bounty-contract-', 'route.test.ts']);
    expect(row.getAttribute('title')).toBe('tests/api/bounty-contract-route.test.ts');
  });
});

describe('FileTree folder state', () => {
  const dir = (path: string) => byData('dir', path);
  const remount = () => { act(() => root.unmount()); root = createRoot(host); mount(); };
  const working = () => session({ id: 's1', status: 'working', lastAt: Date.now() });
  let tool = 0;
  const target = (path: string) => {
    act(() => useStore.getState().apply({ type: 'session', session: working() }));
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ sessionId: 's1', type: 'tool_start', at: Date.now(), tool: { id: `t${++tool}`, name: 'Edit', label: 'Edit', paths: [path] } }) }));
  };
  beforeEach(() => { (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = vi.fn(); });
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

  it('folders the agent opens are never saved, and close again as it moves on', () => {
    const files = [];
    for (let i = 0; i < 2100; i++) files.push(file(`d${i % 30}/sub/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    for (let d = 0; d < 30; d++) target(`d${d}/sub/f${d}.ts`);
    expect(host.querySelector('[data-file="d29/sub/f29.ts"]')).not.toBeNull();
    expect(host.querySelector('[data-file="d0/sub/f0.ts"]')).toBeNull();
    expect(host.querySelectorAll('[aria-expanded="true"]')).toHaveLength(1); // the d29/sub row
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stored()).toBeNull();
    act(() => useStore.getState().apply({ type: 'session', session: { ...working(), status: 'idle' } }));
    remount();
    expect(host.querySelectorAll('.frow')).toHaveLength(0); // the big-project default is back
    expect(host.querySelectorAll('[aria-expanded="true"]')).toHaveLength(0);
  });

  it('a folder the user closed this session stays closed as the agent works in it; a select opens it', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('a/y.ts'), file('a/z.ts'), file('b/z.ts')]));
    mount();
    act(() => dir('a')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    target('a/x.ts');
    target('a/z.ts');
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('a')!.querySelector('.dlive')!.getAttribute('aria-label')).toBe('being written');
    act(() => useStore.getState().select('a/y.ts')); // the user's own pick opens it, for the session
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('true');
    act(() => { vi.advanceTimersByTime(400); });
    expect(stored()).toEqual([['a', false]]);
    act(() => useStore.getState().apply({ type: 'session', session: { ...working(), status: 'idle' } }));
    act(() => useStore.getState().select(null));
    remount();
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('false');
    // A folder closed in an earlier session is shown for the agent, and closing it now holds for the session.
    target('a/x.ts');
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('true');
    act(() => dir('a')!.click());
    target('a/y.ts');
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes folders only the agent opened once it moves on, but not ones the user picked a file in', () => {
    const files = [];
    for (let i = 0; i < 2100; i++) files.push(file(`d${i % 3}/s/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    target('d0/s/f0.ts');
    expect(dir('d0/s')!.getAttribute('aria-expanded')).toBe('true');
    act(() => useStore.getState().select('d2/s/f2.ts'));
    target('d1/s/f1.ts');
    expect(dir('d0/s')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('d1/s')!.getAttribute('aria-expanded')).toBe('true');
    target('d0/s/f3.ts');
    expect(dir('d1/s')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('d2/s')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a file picked in a filtered view keeps only its own folders open after the filter clears, for the session', () => {
    const files = [];
    for (let i = 0; i < 2100; i++) files.push(file(`d${i % 3}/s/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    act(() => useStore.getState().setFilter('f1'));
    act(() => byData('file', 'd1/s/f1.ts')!.click());
    act(() => useStore.getState().setFilter(''));
    expect(dir('d1/s')!.getAttribute('aria-expanded')).toBe('true');
    expect(dir('d0/s')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('d2/s')!.getAttribute('aria-expanded')).toBe('false');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stored()).toBeNull();
  });

  it('a file selected elsewhere under a filter is shown even if the user closed its folder in the filter', () => {
    useStore.getState().apply(hello([file('a/b/x.ts'), file('a/b/y.ts'), file('c/x.ts')]));
    mount();
    act(() => useStore.getState().setFilter('x'));
    act(() => dir('a/b')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    expect(host.querySelector('[data-file="a/b/x.ts"]')).toBeNull();
    act(() => useStore.getState().select('a/b/x.ts'));
    expect(host.querySelector('[data-file="a/b/x.ts"]')).not.toBeNull();
    expect(dir('a/b')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('handles folders named like object keys', () => {
    const names = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
    useStore.getState().apply(hello(names.map(n => file(`${n}/f.ts`)).concat(file('constructor/sub/g.ts'))));
    mount();
    for (const n of names) {
      expect(dir(n)!.getAttribute('aria-expanded')).toBe('true');
      expect(byData('file', `${n}/f.ts`)).not.toBeNull();
    }
    act(() => dir('constructor')!.click());
    act(() => dir('__proto__')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    expect(host.querySelector('[data-file="constructor/f.ts"]')).toBeNull();
    expect(host.querySelector('[data-file="__proto__/f.ts"]')).toBeNull();
    expect(stored()).toEqual([['constructor', false], ['__proto__', false]]);
    act(() => useStore.getState().setFilter('f.ts'));
    act(() => dir('toString')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    expect(host.querySelector('[data-file="toString/f.ts"]')).toBeNull();
    expect(host.querySelector('[data-file="valueOf/f.ts"]')).not.toBeNull();
    act(() => useStore.getState().setFilter(''));
    remount();
    expect(dir('constructor')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('__proto__')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('toString')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('saves after a pause, and right away when the page is hidden', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    act(() => dir('a')!.click());
    act(() => { vi.advanceTimersByTime(200); });
    act(() => dir('b')!.click());
    act(() => { vi.advanceTimersByTime(200); });
    expect(stored()).toBeNull();
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(stored()).toEqual([['a', false], ['b', false]]);
  });
});

describe('FileTree round 3', () => {
  const dir = (path: string) => byData('dir', path);
  const focused = () => (document.activeElement as HTMLElement).dataset.nav;
  const press = (k: string) => act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
  const scrollSpy = vi.fn();
  const working = (status: 'working' | 'idle' = 'working') => session({ id: 's1', status, lastAt: Date.now() });
  let tool = 100;
  const target = (path: string) => {
    act(() => useStore.getState().apply({ type: 'session', session: working() }));
    act(() => useStore.getState().apply({ type: 'agentEvent', event: event({ sessionId: 's1', type: 'tool_start', at: Date.now(), tool: { id: `r${++tool}`, name: 'Edit', label: 'Edit', paths: [path] } }) }));
  };
  const idle = () => act(() => useStore.getState().apply({ type: 'session', session: working('idle') }));
  beforeEach(() => { scrollSpy.mockClear(); (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy; });
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

  it('starts fresh for another project: Show more and folders closed under a filter do not carry over', () => {
    const files = (n: number) => Array.from({ length: n }, (_, i) => file(`big/f${String(i).padStart(4, '0')}.ts`)).concat(file('lib/x.ts'));
    function Keyed() { const r = useStore(s => s.root); return <FileTree key={r} />; }
    useStore.getState().apply(hello(files(500)));
    act(() => root.render(<Keyed />));
    act(() => { vi.advanceTimersByTime(2000); });
    act(() => navEl(moreKey('big'))!.click());
    expect(host.querySelectorAll('[data-file^="big/"]')).toHaveLength(400);
    act(() => useStore.getState().setFilter('x'));
    act(() => dir('lib')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    expect(byData('file', 'lib/x.ts')).toBeNull();
    act(() => useStore.getState().apply({ ...hello(files(500)), root: '/p/other', name: 'other' }));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(byData('file', 'lib/x.ts')).not.toBeNull(); // the filter is the same, its closed folder is not
    act(() => useStore.getState().setFilter(''));
    expect(host.querySelectorAll('[data-file^="big/"]')).toHaveLength(200);
  });

  it('decides big or not when the first index finishes, not at the first files', () => {
    useStore.getState().apply({ ...hello([file('a/x.ts'), file('b/y.ts')]), indexing: true });
    mount();
    const more = Array.from({ length: 2050 }, (_, i) => file(`a/gen/f${i}.ts`));
    act(() => useStore.getState().apply({ type: 'files', files: more, removed: [] }));
    act(() => useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts'), ...more]))); // indexing done
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('false');
    expect(dir('b')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the folders only the agent opened when it goes idle', () => {
    const many = Array.from({ length: 2100 }, (_, i) => file(`d${i % 3}/s/f${i}.ts`));
    useStore.getState().apply(hello(many));
    mount();
    target('d0/s/f0.ts');
    expect(dir('d0/s')!.getAttribute('aria-expanded')).toBe('true');
    idle();
    expect(dir('d0/s')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('selecting the same file again reopens a folder the user closed', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    act(() => useStore.getState().select('a/x.ts'));
    act(() => dir('a')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('false');
    act(() => useStore.getState().select('a/x.ts'));
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('true');
    act(() => dir('a')!.click());
    act(() => useStore.getState().revealLine('a/x.ts', 3));
    expect(dir('a')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not scroll to an agent file hidden by a user close, now or later', () => {
    useStore.getState().apply(hello([file('a/x.ts'), file('b/y.ts')]));
    mount();
    act(() => dir('a')!.click());
    act(() => { vi.advanceTimersByTime(400); });
    target('a/x.ts');
    expect(scrollSpy).not.toHaveBeenCalled();
    act(() => dir('a')!.click()); // the user opens it again much later: no stale scroll
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('drops a reveal whose row never showed', () => {
    useStore.getState().apply(hello([file('a/x.ts')]));
    mount();
    act(() => useStore.getState().select('gone/z.ts')); // not in the tree (a file from another point in history)
    act(() => useStore.getState().apply({ type: 'files', files: [file('gone/z.ts')], removed: [] }));
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('typeahead takes any printable character', () => {
    useStore.getState().apply(hello([file('src/app/(admin)/page.tsx'), file('src/app/[slug]/page.tsx'), file('@types/x.d.ts'), file('src/app/z.ts')]));
    mount();
    act(() => dir('src/app')!.focus());
    press('(');
    expect(focused()).toBe(dirKey('src/app/(admin)'));
    act(() => { vi.advanceTimersByTime(1000); });
    press('[');
    expect(focused()).toBe(dirKey('src/app/[slug]'));
    act(() => { vi.advanceTimersByTime(1000); });
    press('@');
    expect(focused()).toBe(dirKey('@types'));
  });

  it('keeps ids apart from file names that look like them', () => {
    useStore.getState().apply(hello([file('dir:src'), file('src/a.ts'), file('more:src'), file('src/b.ts#x:1')]));
    mount();
    const keys = [...host.querySelectorAll<HTMLElement>('[data-nav]')].map(e => e.dataset.nav);
    expect(new Set(keys).size).toBe(keys.length);
    act(() => dir('src')!.focus());
    const seen: (string | undefined)[] = [focused()];
    for (let i = 0; i < 4; i++) { press('ArrowDown'); seen.push(focused()); }
    expect(seen).toEqual([dirKey('src'), 'src/a.ts', 'src/b.ts#x:1', 'dir:src', 'more:src']);
    press('Home');
    expect(focused()).toBe(dirKey('src'));
    press('End');
    expect(focused()).toBe('more:src');
  });
});

describe('FileTree lazy keys', () => {
  let real: typeof treeKeysLoader.load;
  beforeEach(() => { real = treeKeysLoader.load; });
  afterEach(async () => { treeKeysLoader.load = real; treeKeysLoader.reset(); await loadTreeKeys(); });
  const focused = () => (document.activeElement as HTMLElement).dataset.nav;
  const press = (k: string) => act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

  it('replays keys pressed while the handler loads, in order', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    treeKeysLoader.reset();
    treeKeysLoader.load = () => gate.then(real);
    useStore.getState().apply(hello([file('a.ts'), file('b.ts'), file('c.ts')]));
    mount();
    act(() => byData('file', 'a.ts')!.focus());
    press('ArrowDown');
    press('ArrowDown');
    expect(focused()).toBe('a.ts');
    await act(async () => { resolve(); await gate; await loadTreeKeys(); });
    expect(focused()).toBe('c.ts');
  });

  it('retries after a failed load on the next key', async () => {
    let calls = 0;
    treeKeysLoader.reset();
    treeKeysLoader.load = () => (++calls === 1 ? Promise.reject(new Error('offline')) : real());
    useStore.getState().apply(hello([file('a.ts'), file('b.ts')]));
    mount();
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); // the first load fails
    expect(calls).toBe(1);
    act(() => byData('file', 'a.ts')!.focus());
    press('ArrowDown'); // retries, and is replayed once loaded
    expect(calls).toBe(2);
    await act(async () => { await loadTreeKeys(); });
    expect(focused()).toBe('b.ts');
  });
});
