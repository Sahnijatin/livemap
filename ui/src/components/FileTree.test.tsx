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

  it('in a big project a change marks its collapsed folders; an open folder shows the changing file past the cap', () => {
    const files = [];
    for (let d = 0; d < 3; d++) for (let i = 0; i < 700; i++) files.push(file(`d${d}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    act(() => useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('d1/f699.ts', 'modified', { at: Date.now() }) }));
    expect(rows()).toBe(0);
    expect(host.querySelector('[data-dir="d1"] .dlive')!.getAttribute('aria-label')).toBe('changed');
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
    expect(top).toEqual(['dir:.agents/skills', 'dir:Web', 'README.md']);
    expect(dir('.agents/skills')!.querySelector('.fn')!.textContent).toBe('.agents/skills');
    expect(dir('.agents/skills')!.getAttribute('title')).toBe('.agents/skills · 2 files');
    expect(dir('Web')!.querySelector('b')!.textContent).toBe('2');
    expect(dir('Web')!.getAttribute('aria-expanded')).toBe('true'); // top level of a small project
    expect(dir('Web/lib')!.getAttribute('aria-expanded')).toBe('false'); // deeper folders start closed
    expect(dir('Web/lib')!.getAttribute('aria-level')).toBe('2');
    expect(host.querySelector('[data-file="Web/App.tsx"]')!.getAttribute('aria-level')).toBe('2');
    expect(host.querySelector('[data-file="Web/lib/util.ts"]')).toBeNull();
  });

  it('starts every folder closed at 2,000 files', () => {
    const files = [];
    for (let i = 0; i < 2000; i++) files.push(file(`d${i % 4}/f${i}.ts`));
    useStore.getState().apply(hello(files));
    mount();
    expect(host.querySelectorAll('.dir')).toHaveLength(4);
    expect(rows()).toBe(0);
  });

  it('remembers opened and closed folders per project across remounts, ignoring folders that are gone', () => {
    useStore.getState().apply(hello([file('a/b/x.ts'), file('a/y.ts'), file('c/z.ts')]));
    mount();
    act(() => dir('a/b')!.click());
    act(() => dir('c')!.click());
    expect(JSON.parse(localStorage.getItem('livemap:tree:/p/shop')!)).toEqual({ 'a/b': true, c: false });
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem('livemap:tree:/p/shop', JSON.stringify({ 'a/b': true, c: false, gone: true, bad: 3 }));
    mount();
    expect(host.querySelector('[data-file="a/b/x.ts"]')).not.toBeNull();
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
    expect(dir('a')!.querySelector('.dlive')!.getAttribute('aria-label')).toBe('changed');
    expect(dir('a')!.querySelector('.dlive')!.classList.contains('new')).toBe(true);
  });

  it('moves with the arrow keys: Right opens then enters, Left closes then goes up, Home and End', () => {
    useStore.getState().apply(hello([file('a/b/x.ts'), file('a/y.ts'), file('z.ts')]));
    mount();
    const a = dir('a')!;
    act(() => a.focus());
    key('ArrowDown');
    expect(focused()).toBe('dir:a/b');
    key('ArrowRight');
    expect(dir('a/b')!.getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('dir:a/b');
    key('ArrowRight');
    expect(focused()).toBe('a/b/x.ts');
    key('ArrowLeft');
    expect(focused()).toBe('dir:a/b');
    key('ArrowLeft');
    expect(dir('a/b')!.getAttribute('aria-expanded')).toBe('false');
    key('ArrowLeft');
    expect(focused()).toBe('dir:a');
    key('End');
    expect(focused()).toBe('z.ts');
    key('ArrowLeft'); // a root file has no parent: focus stays
    expect(focused()).toBe('z.ts');
    key('Home');
    expect(focused()).toBe('dir:a');
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
    expect(dir('src/app/(admin)')!.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('livemap:tree:/p/shop')!)).toEqual({ docs: false });
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
