import { describe, it, expect, beforeEach } from 'vitest';
import type { FileModel } from '@shared/types.js';
import { file, sym } from './fixtures';
import {
  ROW_BUDGET, DIR_BATCH, ancestors, buildTree, chainOf, closedAbove, chainOpen, compareNames, dirActivity, loadTreeState, parseTreeState,
  saveTreeState, splitName, treeKey, visibleItems, type DirNode, type Item,
} from './treeModel';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const byPath = (list: FileModel[]): Record<string, FileModel> => Object.fromEntries(list.map(f => [f.path, f]));
const tree = (paths: string[], q = '') => buildTree(byPath(paths.map(p => file(p))), q);
const names = (n: DirNode) => [...n.dirs.map(d => `${d.name}/`), ...n.rows.map(r => r.file.path.slice(r.file.path.lastIndexOf('/') + 1))];
const allOpen = () => true;
const items = (root: DirNode, open: (paths: string[], level: number) => boolean = allOpen) =>
  visibleItems(root, open, () => false, {}).items;
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
    const state = { src: true, 'src/app': true };
    const open = (paths: string[]) => chainOpen(paths, state, true);
    expect(items(after.root, open).map(label)).toContain('    src/app/page.tsx');
    expect(items(before.root, open).map(label)).toContain('  src/app/page.tsx');
  });

  it('a chain is open only when every folder in it is', () => {
    expect(chainOpen(['a', 'a/b'], {}, false)).toBe(true); // a small project starts fully open
    expect(chainOpen(['a', 'a/b'], {}, true)).toBe(false); // a big one starts closed
    expect(chainOpen(['a', 'a/b'], { 'a/b': false }, false)).toBe(false);
    expect(chainOpen(['a', 'a/b'], { a: true }, true)).toBe(false);
    expect(chainOpen(['a', 'a/b'], { a: true, 'a/b': true }, true)).toBe(true);
    expect(chainOpen(['constructor'], {}, true)).toBe(false); // inherited object keys are not stored choices
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
    const all = visibleItems(root, allOpen, () => false, {});
    expect(all.items.filter(i => i.kind === 'dir')).toHaveLength(7);
    expect(all.items.filter(i => i.kind === 'file')).toHaveLength(ROW_BUDGET);
    const more = all.items.filter(i => i.kind === 'more') as Extract<Item, { kind: 'more' }>[];
    expect(more.map(m => [m.dir, m.shown, m.hidden])).toEqual([['d0', 200, 100], ['d1', 200, 100], ['d2', 200, 100], ['d3', 200, 100], ['d4', 200, 100], ['d5', 0, 300], ['d6', 0, 300]]);
    const closed = visibleItems(root, () => false, () => false, {});
    expect(closed.items.map(label)).toEqual(['d0/', 'd1/', 'd2/', 'd3/', 'd4/', 'd5/', 'd6/']);
    const limited = visibleItems(root, allOpen, () => false, { d6: DIR_BATCH * 2 });
    expect(limited.items.filter(i => i.kind === 'file' && i.row.file.path.startsWith('d6/'))).toHaveLength(300);
  });

  it('renders pinned rows and the folders that hold them past the cap', () => {
    const paths: string[] = [];
    for (let i = 0; i < 250; i++) paths.push(`big/s${String(i).padStart(3, '0')}/a.ts`);
    const { root } = tree(paths);
    const pin = 'big/s249/a.ts';
    const { items: list } = visibleItems(root, allOpen, () => false, {}, [pin]);
    const dirs = list.filter(i => i.kind === 'dir');
    expect(dirs).toHaveLength(1 + DIR_BATCH + 1);
    expect(list.some(i => i.kind === 'file' && i.row.file.path === pin)).toBe(true);
    expect(list.find(i => i.kind === 'more')).toMatchObject({ dir: 'big', hidden: 49 });
  });

  it('gives each row its level and parent, and lists the keyboard order', () => {
    const { root } = tree(['a/b/c.ts', 'a/d.ts', 'e.ts']);
    const { items: list, navKeys } = visibleItems(root, allOpen, () => false, {});
    expect(list.map(i => [label(i).trim(), i.level, i.kind === 'more' ? null : i.up])).toEqual([
      ['a/', 1, null], ['b/', 2, 'dir:a'], ['a/b/c.ts', 3, 'dir:a/b'], ['a/d.ts', 2, 'dir:a'], ['e.ts', 1, null],
    ]);
    expect(navKeys).toEqual(['dir:a', 'dir:a/b', 'a/b/c.ts', 'a/d.ts', 'e.ts']);
  });
});

describe('activity and ancestors', () => {
  it('lists every ancestor folder of a path', () => {
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
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

  it('reads only path to boolean entries and ignores anything else', () => {
    expect(parseTreeState(null)).toEqual({});
    expect(parseTreeState('nope')).toEqual({});
    expect(parseTreeState('[1,2]')).toEqual({});
    expect(parseTreeState('{"a":true,"b":false,"c":1,"d":"x"}')).toEqual({ a: true, b: false });
    expect(treeKey('/p/shop')).toBe('livemap:tree:/p/shop');
  });

  it('survives missing or throwing storage', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
    try {
      expect(loadTreeState('/p')).toEqual({});
      expect(() => saveTreeState('/p', { a: true })).not.toThrow();
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('tree performance', () => {
  it('builds and lists 5,000 files quickly', () => {
    const paths: string[] = [];
    for (let i = 0; i < 5000; i++) paths.push(`src/m${i % 40}/sub${i % 7}/deep${i % 3}/file-${i}.ts`);
    const files = byPath(paths.map(p => file(p)));
    buildTree(files, ''); // warm the per-file caches, as the first render does
    const t0 = performance.now();
    const { root } = buildTree(files, '');
    visibleItems(root, allOpen, () => false, {});
    const ms = performance.now() - t0;
    console.log(`[tree perf] 5,000 files: ${ms.toFixed(1)} ms`);
    expect(root.count).toBe(5000);
    expect(ms).toBeLessThan(60 * TIME_SCALE);
  });
});

describe('closedAbove', () => {
  it('lists only the closed folders above a path', () => {
    expect(closedAbove('a/b/c/x.ts', {}, false)).toEqual([]);
    expect(closedAbove('a/b/c/x.ts', {}, true)).toEqual(['a', 'a/b', 'a/b/c']);
    expect(closedAbove('a/b/c/x.ts', { a: true, 'a/b/c': false }, true)).toEqual(['a/b', 'a/b/c']);
    expect(closedAbove('x.ts', {}, true)).toEqual([]);
  });
});
