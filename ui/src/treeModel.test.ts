import { describe, it, expect, beforeEach } from 'vitest';
import type { FileModel } from '@shared/types.js';
import { file, sym } from './fixtures';
import {
  ROW_BUDGET, DIR_BATCH, ancestors, buildTree, chainOf, closedAbove, chainOpen, compareNames, dirActivity, loadTreeState, parseTreeState,
  saveTreeState, serializeTreeState, dirKey, moreKey, symKey, splitName, treeKey, visibleItems, type DirNode, type Item,
} from './treeModel';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const byPath = (list: FileModel[]): Record<string, FileModel> => Object.fromEntries(list.map(f => [f.path, f]));
const tree = (paths: string[], q = '') => buildTree(byPath(paths.map(p => file(p))), q);
const names = (n: DirNode) => [...n.dirs.map(d => `${d.name}/`), ...n.rows.map(r => r.file.path.slice(r.file.path.lastIndexOf('/') + 1))];
const allOpen = () => true;
const items = (root: DirNode, open: (paths: string[]) => boolean = allOpen) =>
  visibleItems(root, open, () => false, new Map()).items;
const label = (i: Item): string => (i.kind === 'dir' ? `${'  '.repeat(i.level - 1)}${i.label}/` : i.kind === 'file' ? `${'  '.repeat(i.level - 1)}${i.row.file.path}` : `more:${i.dir}`);

describe('buildTree', () => {
  it('nests folders, folders first then files, natural case-insensitive order, names as on disk', () => {
    const { root } = tree(['src/b.ts', 'src/A.ts', 'src/lib/x.ts', 'README.md', 'src/item10.ts', 'src/item2.ts', 'Docs/a.md', 'api/z.ts']);
    expect(names(root)).toEqual(['api/', 'Docs/', 'src/', 'README.md']);
    const src = root.dirs[2];
    expect(src.path).toBe('src');
    expect(names(src)).toEqual(['lib/', 'A.ts', 'b.ts', 'item2.ts', 'item10.ts']);
    expect(src.dirs[0].path).toBe('src/lib');
  });

  it('keeps two folders whose names differ only by case apart, in a stable order', () => {
    const { root } = tree(['lib/a.ts', 'Lib/b.ts', 'LIB/c.ts']);
    expect(root.dirs.map(d => d.path)).toEqual(['LIB', 'Lib', 'lib']);
    expect(root.dirs.map(d => d.count)).toEqual([1, 1, 1]);
    expect(compareNames('a', 'A')).toBeGreaterThan(0);
    expect(compareNames('A', 'a')).toBeLessThan(0);
    expect(compareNames('a', 'a')).toBe(0);
  });

  it('handles dots, parentheses, brackets, spaces and unicode in segments', () => {
    const paths = ['.agents/skills/x/SKILL.md', 'src/app/(admin)/[id]/page.tsx', 'my docs/ünïcode é.md', '.claude/a.md'];
    const { root } = tree(paths);
    expect(root.dirs.map(d => d.name)).toEqual(['.agents', '.claude', 'my docs', 'src']);
    const shown = items(root).filter(i => i.kind === 'file').map(i => (i as Extract<Item, { kind: 'file' }>).row.file.path);
    expect(shown.sort()).toEqual([...paths].sort());
  });

  it('counts every file below a folder and picks its dominant layer', () => {
    const { root } = tree(['web/components/a.tsx', 'web/components/b.tsx', 'web/api/c.ts', 'web/x.test.ts']);
    const web = root.dirs[0];
    expect(web.count).toBe(4);
    expect(web.layer).toBe('ui');
    expect(web.dirs.map(d => [d.name, d.count, d.layer])).toEqual([['api', 1, 'api'], ['components', 2, 'ui']]);
    expect(root.count).toBe(4);
  });

  it('puts root-level files at the top level, after the folders', () => {
    const { root } = tree(['a.ts', 'z/b.ts']);
    expect(items(root).map(label)).toEqual(['z/', '  z/b.ts', 'a.ts']);
  });

  it('drops a folder once its last file is gone', () => {
    const files = byPath([file('a/x.ts'), file('b/y.ts')]);
    delete files['a/x.ts'];
    expect(buildTree(files, '').root.dirs.map(d => d.path)).toEqual(['b']);
  });
});

describe('compact folders', () => {
  it('shows a chain of single-folder folders as one row and lists the deepest folder\'s children', () => {
    const { root } = tree(['src/app/(admin)/admin/page.tsx', 'src/app/(admin)/admin/x/page.tsx', 'top.ts']);
    expect(chainOf(root.dirs[0]).map(d => d.path)).toEqual(['src', 'src/app', 'src/app/(admin)', 'src/app/(admin)/admin']);
    expect(items(root).map(label)).toEqual([
      'src/app/(admin)/admin/',
      '  x/',
      '    src/app/(admin)/admin/x/page.tsx',
      '  src/app/(admin)/admin/page.tsx',
      'top.ts',
    ]);
    const head = items(root)[0] as Extract<Item, { kind: 'dir' }>;
    expect(head.chain).toEqual(['src', 'src/app', 'src/app/(admin)', 'src/app/(admin)/admin']);
    expect(head.node.count).toBe(2);
  });

  it('splits a chain when a file is added to a middle folder, keeping state keyed by full path', () => {
    const before = tree(['src/app/page.tsx']);
    expect(items(before.root).map(label)).toEqual(['src/app/', '  src/app/page.tsx']);
    const after = tree(['src/app/page.tsx', 'src/main.ts']);
    expect(items(after.root).map(label)).toEqual(['src/', '  app/', '    src/app/page.tsx', '  src/main.ts']);
    // The chain was opened as a whole, so both folders are open after the split, and closed again when it rejoins.
    const state = new Map([['src', true], ['src/app', true]]);
    const open = (paths: string[]) => chainOpen(paths, state, true);
    expect(items(after.root, open).map(label)).toContain('    src/app/page.tsx');
    expect(items(before.root, open).map(label)).toContain('  src/app/page.tsx');
  });

  it('a chain is open only when every folder in it is', () => {
    const m = (o: Record<string, boolean>) => new Map(Object.entries(o));
    expect(chainOpen(['a', 'a/b'], m({}), false)).toBe(true); // a small project starts fully open
    expect(chainOpen(['a', 'a/b'], m({}), true)).toBe(false); // a big one starts closed
    expect(chainOpen(['a', 'a/b'], m({ 'a/b': false }), false)).toBe(false);
    expect(chainOpen(['a', 'a/b'], m({ a: true }), true)).toBe(false);
    expect(chainOpen(['a', 'a/b'], m({ a: true, 'a/b': true }), true)).toBe(true);
    // Revealed folders are open for the session, even ones the user closed.
    expect(chainOpen(['a', 'a/b'], m({ a: false }), true, new Set(['a', 'a/b']))).toBe(true);
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(chainOpen([name], new Map(), true)).toBe(false);
      expect(chainOpen([name], new Map(), false)).toBe(true);
    }
  });
});

describe('filter', () => {
  it('keeps matching files with their folders, hides other branches, and matches symbols', () => {
    const files = byPath([file('src/app/(admin)/admin/users/page.tsx'), file('src/app/(admin)/admin/orders/page.tsx'), file('lib/util.ts', [sym('formatUser'), sym('other')])]);
    const { root } = buildTree(files, 'users');
    expect(items(root).map(label)).toEqual(['src/app/(admin)/admin/users/', '  src/app/(admin)/admin/users/page.tsx']);
    const sym1 = buildTree(files, 'formatuser').root;
    const rows = items(sym1).filter(i => i.kind === 'file') as Extract<Item, { kind: 'file' }>[];
    expect(rows.map(r => [r.row.file.path, r.row.forceOpen, r.row.symbols.map(s => s.sym.name)])).toEqual([['lib/util.ts', true, ['formatUser']]]);
  });
});

describe('visibleItems', () => {
  it('lists only the children of open folders and caps rows per folder and overall', () => {
    const paths: string[] = [];
    for (let d = 0; d < 7; d++) for (let i = 0; i < 300; i++) paths.push(`d${d}/f${i}.ts`);
    const { root } = tree(paths);
    const all = visibleItems(root, allOpen, () => false, new Map());
    expect(all.items.filter(i => i.kind === 'dir')).toHaveLength(7);
    expect(all.items.filter(i => i.kind === 'file')).toHaveLength(ROW_BUDGET - 7); // folder rows count too
    const more = all.items.filter(i => i.kind === 'more') as Extract<Item, { kind: 'more' }>[];
    expect(more.map(m => [m.dir, m.shown, m.hidden])).toEqual([['d0', 200, 100], ['d1', 200, 100], ['d2', 200, 100], ['d3', 200, 100], ['d4', 193, 107], ['d5', 0, 300], ['d6', 0, 300]]);
    const closed = visibleItems(root, () => false, () => false, new Map());
    expect(closed.items.map(label)).toEqual(['d0/', 'd1/', 'd2/', 'd3/', 'd4/', 'd5/', 'd6/']);
    const limited = visibleItems(root, allOpen, () => false, new Map([[moreKey('d6'), DIR_BATCH * 2]]));
    expect(limited.items.filter(i => i.kind === 'file' && i.row.file.path.startsWith('d6/'))).toHaveLength(300);
  });

  it('puts a folder\'s "more folders" row after its last shown folder and "more files" after its last file', () => {
    const paths: string[] = [];
    for (let i = 0; i < 250; i++) paths.push(`x/s${String(i).padStart(3, '0')}/a.ts`, `x/f${String(i).padStart(3, '0')}.ts`);
    const { root } = tree(paths);
    const onlyX = (p: string[]) => p[p.length - 1] === 'x';
    const list = visibleItems(root, onlyX, () => false, new Map([[moreKey('x'), 10]])).items;
    const at = (pred: (i: Item) => boolean) => list.findIndex(pred);
    const lastDir = list.map(i => i.kind === 'dir' && i.node.path.startsWith('x/')).lastIndexOf(true);
    const lastFile = list.map(i => i.kind === 'file').lastIndexOf(true);
    const moreDirs = at(i => i.kind === 'more' && i.part === 'dirs');
    const moreFiles = at(i => i.kind === 'more' && i.part === 'files');
    expect(moreDirs).toBe(lastDir + 1);
    expect(moreFiles).toBe(lastFile + 1);
    expect(list[moreDirs]).toMatchObject({ dir: 'x', shown: 200, hidden: 50 });
    expect(list[moreFiles]).toMatchObject({ dir: 'x', shown: 10, hidden: 240 });
    expect(new Set([moreKey('x', 'dirs'), moreKey('x')]).size).toBe(2);
    // "Show more folders" raises the folder cap only.
    const more = visibleItems(root, onlyX, () => false, new Map([[moreKey('x', 'dirs'), 400], [moreKey('x'), 10]])).items;
    expect(more.filter(i => i.kind === 'dir')).toHaveLength(251);
    expect(more.filter(i => i.kind === 'file')).toHaveLength(10);
  });

  it('files keep their own room after "Show more folders" raises the folder cap past the batch', () => {
    const paths: string[] = [];
    for (let i = 0; i < 250; i++) paths.push(`x/s${String(i).padStart(3, '0')}/a.ts`);
    for (let i = 0; i < 5; i++) paths.push(`x/f${i}.ts`);
    const { root } = tree(paths);
    const onlyX = (p: string[]) => p[p.length - 1] === 'x';
    const list = visibleItems(root, onlyX, () => false, new Map([[moreKey('x', 'dirs'), 400]])).items;
    expect(list.filter(i => i.kind === 'dir')).toHaveLength(251);
    expect(list.filter(i => i.kind === 'file')).toHaveLength(5);
    expect(list.some(i => i.kind === 'more')).toBe(false);
  });

  it('renders pinned rows and the folders that hold them past the cap', () => {
    const paths: string[] = [];
    for (let i = 0; i < 250; i++) paths.push(`big/s${String(i).padStart(3, '0')}/a.ts`);
    const { root } = tree(paths);
    const pin = 'big/s249/a.ts';
    const { items: list } = visibleItems(root, allOpen, () => false, new Map(), [pin]);
    const dirs = list.filter(i => i.kind === 'dir');
    expect(dirs).toHaveLength(1 + DIR_BATCH + 1);
    expect(list.some(i => i.kind === 'file' && i.row.file.path === pin)).toBe(true);
    expect(list.find(i => i.kind === 'more')).toMatchObject({ dir: 'big', hidden: 49 });
  });

  it('gives each row its level and parent, and lists the keyboard order', () => {
    const { root } = tree(['a/b/c.ts', 'a/d.ts', 'e.ts']);
    const { items: list, navKeys } = visibleItems(root, allOpen, () => false, new Map());
    expect(list.map(i => [label(i).trim(), i.level, i.kind === 'more' ? null : i.up])).toEqual([
      ['a/', 1, null], ['b/', 2, dirKey('a')], ['a/b/c.ts', 3, dirKey('a/b')], ['a/d.ts', 2, dirKey('a')], ['e.ts', 1, null],
    ]);
    expect(navKeys).toEqual([dirKey('a'), dirKey('a/b'), 'a/b/c.ts', 'a/d.ts', 'e.ts']);
  });

  it('keeps folder, more and symbol ids apart from any file path', () => {
    // A NUL cannot appear in a POSIX path, so no file can be named like an id.
    for (const k of [dirKey('src'), moreKey('src'), symKey('src/a.ts', sym('f'))]) expect(k).toContain('\0');
    expect(dirKey('src')).not.toBe(moreKey('src'));
    const { root } = tree(['dir:src', 'more:src', 'src/a.ts']);
    const { navKeys } = visibleItems(root, allOpen, () => false, new Map());
    expect(new Set(navKeys).size).toBe(navKeys.length);
    expect(Object.keys(visibleItems(root, allOpen, () => false, new Map())).sort()).toEqual(['items', 'navKeys']);
  });
});

describe('activity and ancestors', () => {
  it('lists every ancestor folder of a path', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
    // Never the project root, even for a path with a leading slash.
    expect(ancestors('/a/b/c.ts')).toEqual(['/a', '/a/b']);
    expect(ancestors('/x.ts')).toEqual([]);
  });

  it('marks each folder above a live file, the file being written winning over edits and new files', () => {
    const act = dirActivity({ 'a/b/x.ts': 'new', 'a/y.ts': 'edited', 'z/q.ts': 'new' }, 'z/w/now.ts');
    expect(act.get('a')).toBe('edited');
    expect(act.get('a/b')).toBe('new');
    expect(act.get('z')).toBe('now');
    expect(act.get('z/w')).toBe('now');
    expect(act.has('')).toBe(false);
  });
});

describe('splitName', () => {
  it('keeps a short name whole', () => {
    expect(splitName('page.tsx')).toEqual(['page.tsx', '']);
    expect(splitName('maintenance', 'dir')).toEqual(['maintenance', '']);
  });

  it('keeps a file\'s last word and extension as the end', () => {
    expect(splitName('bounty-contract-route.test.ts')).toEqual(['bounty-contract-', 'route.test.ts']);
    expect(splitName('payout_schedule_handler.ts')).toEqual(['payout_schedule_', 'handler.ts']);
    expect(splitName('orderService.ts')).toEqual(['order', 'Service.ts']);
    expect(splitName('averyveryverylongnamewithoutbreaks.ts')).toEqual(['averyveryverylongnamewithou', 'tbreaks.ts']);
  });

  it('keeps a folder row\'s last folder as the end, splitting a long one by word', () => {
    expect(splitName('src/app/(admin)', 'dir')).toEqual(['src/app/', '(admin)']);
    expect(splitName('scripts/maintenance', 'dir')).toEqual(['scripts/', 'maintenance']);
    expect(splitName('.agents/skills/supabase-row-level-security', 'dir')).toEqual(['.agents/skills/supabase-row-', 'level-security']);
    expect(splitName('supabase-auth-integration', 'dir')).toEqual(['supabase-auth-', 'integration']);
    expect(splitName('a/averyveryverylongfoldername', 'dir')).toEqual(['a/averyveryverylong', 'foldername']);
  });

  it('never cuts inside a character', () => {
    const name = '\u{1F600}'.repeat(20) + '\u{1F680}.ts';
    const [head, tail] = splitName(name);
    expect(head + tail).toBe(name);
    expect(Array.from(tail)).toHaveLength(10);
    expect(/[\uD800-\uDBFF]$/.test(head)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(tail)).toBe(false);
  });

  it('never returns an empty start with a non-empty end', () => {
    for (const n of ['x'.repeat(15), 'a/' + 'y'.repeat(30), '-'.repeat(20), 'ab-cd-ef-gh-ij-kl-mn']) {
      for (const kind of ['file', 'dir'] as const) {
        const [head, tail] = splitName(n, kind);
        expect(head + tail).toBe(n);
        if (tail) expect(head.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('stored folder state', () => {
  beforeEach(() => globalThis.localStorage?.clear());

  it('reads [path, open] pairs, ignoring anything else', () => {
    expect(parseTreeState(null)).toEqual(new Map());
    expect(parseTreeState('nope')).toEqual(new Map());
    expect(parseTreeState('[1,2]')).toEqual(new Map());
    expect([...parseTreeState('[["b",true],["2023",false],["x",1],[3,true],["c"]]')]).toEqual([['b', true], ['2023', false]]);
    expect(parseTreeState('{"a":true,"b":false}')).toEqual(new Map());
    expect([...parseTreeState('[["constructor",true],["__proto__",false],["toString",true]]')]).toEqual([['constructor', true], ['__proto__', false], ['toString', true]]);
    expect(treeKey('/p/shop')).toBe('livemap:tree:/p/shop');
  });

  it('keeps the newest choices in order, integer-like names included, and drops the oldest past the cap', () => {
    const state = new Map<string, boolean>([['b', true], ['2023', false], ['a', true]]);
    state.delete('b');
    state.set('b', false); // moved to the end: newest
    expect(serializeTreeState(state)).toBe('[["2023",false],["a",true],["b",false]]');
    expect(serializeTreeState(state, 2)).toBe('[["a",true],["b",false]]');
    expect([...parseTreeState(serializeTreeState(state))]).toEqual([...state]);
  });

  it('survives missing or throwing storage', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
      expect(loadTreeState('/p')).toEqual(new Map());
      expect(() => saveTreeState('/p', new Map([['a', true]]))).not.toThrow();
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('tree performance', () => {
  /** The median of three timed runs, so one slow tick on a busy runner does not fail the budget. */
  const median = (run: () => void): number => {
    const t: number[] = [];
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); run(); t.push(performance.now() - t0); }
    return t.sort((a, b) => a - b)[1];
  };

  it('builds and lists 5,000 files quickly', () => {
    const paths: string[] = [];
    for (let i = 0; i < 5000; i++) paths.push(`src/m${i % 40}/sub${i % 7}/deep${i % 3}/file-${i}.ts`);
    const files = byPath(paths.map(p => file(p)));
    buildTree(files, ''); // warm the per-file caches, as the first render does
    let count = 0;
    const ms = median(() => { const { root } = buildTree(files, ''); visibleItems(root, allOpen, () => false, new Map()); count = root.count; });
    console.log(`[tree perf] 5,000 files: ${ms.toFixed(1)} ms (median of 3)`);
    expect(count).toBe(5000);
    expect(ms).toBeLessThan(120 * TIME_SCALE);
  });

  it('lists 100,000 files in 10,000 folders under a one-letter filter in bounded rows', () => {
    const paths: string[] = [];
    for (let i = 0; i < 100_000; i++) paths.push(`a${i % 100}/s${Math.floor(i / 100) % 100}/file${i}.ts`);
    const { root } = buildTree(byPath(paths.map(p => file(p))), 's');
    let list: Item[] = [];
    const ms = median(() => { list = visibleItems(root, allOpen, () => false, new Map()).items; });
    console.log(`[tree perf] 100,000 files filtered: ${ms.toFixed(1)} ms (median of 3), ${list.length} items`);
    expect(list.filter(i => i.kind !== 'more').length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(ms).toBeLessThan(50 * TIME_SCALE);
  });
});

describe('closedAbove', () => {
  it('lists only the closed folders above a path', () => {
    const m = (o: Record<string, boolean>) => new Map(Object.entries(o));
    expect(closedAbove('a/b/c/x.ts', m({}), false)).toEqual([]);
    expect(closedAbove('a/b/c/x.ts', m({}), true)).toEqual(['a', 'a/b', 'a/b/c']);
    expect(closedAbove('a/b/c/x.ts', m({ a: true, 'a/b/c': false }), true)).toEqual(['a/b', 'a/b/c']);
    expect(closedAbove('a/b/c/x.ts', m({}), true, new Set(['a']))).toEqual(['a/b', 'a/b/c']);
    expect(closedAbove('x.ts', m({}), true)).toEqual([]);
  });
});

describe('row budget', () => {
  it('gives each open folder level its files before deeper folders use up the budget', () => {
    const paths = ['README.md', 'package.json'];
    for (let i = 0; i < 1200; i++) paths.push(`src/m${i % 6}/f${i}.ts`);
    const { root } = tree(paths);
    const list = items(root);
    const shown = list.filter(i => i.kind === 'file').map(i => (i as Extract<Item, { kind: 'file' }>).row.file.path);
    expect(shown).toContain('README.md');
    expect(shown).toContain('package.json');
    expect(shown.length + list.filter(i => i.kind === 'dir').length).toBe(ROW_BUDGET);
    expect(list.filter(i => i.kind === 'more' && i.dir === '')).toHaveLength(0);
  });

  it('counts folder rows against the budget, so a broad filter stays bounded', () => {
    const paths: string[] = [];
    for (let i = 0; i < 300; i++) for (let j = 0; j < 5; j++) paths.push(`p${i}/q${j}/f.ts`);
    const { root } = tree(paths);
    const list = items(root);
    expect(list.filter(i => i.kind !== 'more').length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(list.some(i => i.kind === 'more')).toBe(true);
  });

  it('asks only whether a folder row is open, given the folders it stands for', () => {
    const { root } = tree(['a/b/x.ts', 'c.ts']);
    const calls: unknown[][] = [];
    visibleItems(root, (...args: unknown[]) => { calls.push(args); return true; }, () => false, new Map());
    expect(calls).toEqual([[['a', 'a/b']]]);
  });
});
