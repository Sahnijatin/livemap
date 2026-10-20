import { describe, it, expect } from 'vitest';
import type { ChangeSummary, CodeSymbol, FileModel, Flag, Lang } from '@shared/types.js';
import { buildMap, largeNote, LARGE_PROJECT, type MapInput } from './mapModel';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const sym = (name: string, line = 1, children: CodeSymbol[] = []): CodeSymbol => ({
  name, qname: name, kind: 'function', signature: `${name}()`, line, endLine: line + 1, exported: true, hash: name, children,
});
function file(path: string, local: string[] = [], symbols: CodeSymbol[] = [], lang: Lang = 'typescript', flags: FileModel['flags'] = {}): FileModel {
  return { path, lang, size: 10, lines: 10, symbols, imports: { local, external: [] }, routes: [], entities: [], env: [], flags };
}
const change = (path: string, added: string[], modified: string[], at = 1): ChangeSummary => ({
  id: at, path, kind: 'modified', at, lang: 'typescript',
  symbols: {
    added: added.map(n => ({ name: n, qname: n, kind: 'function', signature: '', line: 1 })),
    removed: [],
    modified: modified.map(n => ({ name: n, qname: n, kind: 'function', signature: '', line: 1, signatureChanged: false })),
  },
  routes: { added: [], removed: [] }, entities: { added: [], removed: [], changed: [] },
  imports: { added: [], removed: [], externalAdded: [] }, env: { added: [], removed: [] },
  lines: { added: 1, removed: 0 }, hunks: [], truncated: false,
});

function fixture(over: Partial<MapInput> = {}): MapInput {
  const list = [
    file('src/components/App.tsx', ['src/services/auth.ts', 'src/services/user.ts', 'src/lib.ts'], [sym('App'), sym('Header')], 'tsx'),
    file('src/components/Nav.tsx', ['src/services/auth.ts'], [sym('Nav')], 'tsx'),
    file('src/services/auth.ts', ['src/lib.ts'], [sym('login'), sym('logout', 5, [sym('inner', 6)])]),
    file('src/services/user.ts', ['src/lib.ts'], [sym('getUser')]),
    file('src/lib.ts', [], [sym('util')]),
    file('index.ts', ['src/lib.ts'], [sym('main')]),
    file('README.md', [], [sym('Title')], 'markdown'),
    file('package.json', [], [], 'json'),
    file('secret.env', [], [], 'secret', { secret: true }),
  ];
  return { files: Object.fromEntries(list.map(f => [f.path, f])), recent: {}, changes: [], flags: [], target: null, helloEdges: new Set(), ...over };
}

describe('buildMap', () => {
  it('files level: only code files, import edges', () => {
    const g = buildMap(fixture(), 'files', new Set());
    expect(g.files.map(f => f.id)).toEqual([
      'index.ts', 'src/components/App.tsx', 'src/components/Nav.tsx', 'src/lib.ts', 'src/services/auth.ts', 'src/services/user.ts',
    ]);
    expect(g.edges).toHaveLength(7);
    expect(g.edges.every(e => e.weight === 1)).toBe(true);
    expect(g.edges.find(e => e.id === 'src/components/Nav.tsx->src/services/auth.ts')).toBeTruthy();
    expect(g.files.every(f => f.rows.length === 0)).toBe(true);
    expect(g.large).toBe(false);
  });

  it('a folder mostly of markdown is in the Docs layer; its markdown still has no cards', () => {
    const skill = '.agents/skills/supabase-row-level-security';
    const list = [
      file(`${skill}/validate.sh`, [], [sym('check')], 'shell'),
      file(`${skill}/SKILL.md`, [], [sym('Title')], 'markdown'),
      file(`${skill}/notes.md`, [], [sym('Title')], 'markdown'),
      file('handbook/onboarding/setup.md', [], [sym('Title')], 'markdown'),
      file('handbook/onboarding/faq.md', [], [sym('Title')], 'markdown'),
      file('handbook/onboarding/snippet.ts', [], [sym('demo')]),
      // Code with a README beside it stays code.
      file('src/services/auth.ts', [], [sym('login')]),
      file('src/services/user.ts', [], [sym('getUser')]),
      file('src/services/README.md', [], [sym('Title')], 'markdown'),
      // A package's README and CHANGELOG do not make it docs.
      file('packages/foo/index.ts', [], [sym('main')]),
      file('packages/foo/README.md', [], [sym('Title')], 'markdown'),
      file('packages/foo/CHANGELOG.md', [], [sym('Title')], 'markdown'),
      // Markdown must be more than half of the folder, not just its largest share.
      file('lib/mixed/x.ts', [], [sym('x')]),
      file('lib/mixed/y.sql', [], [sym('y')], 'sql'),
      file('lib/mixed/a.md', [], [sym('Title')], 'markdown'),
      file('lib/mixed/b.md', [], [sym('Title')], 'markdown'),
    ];
    const input = fixture({ files: Object.fromEntries(list.map(f => [f.path, f])) });
    const g = buildMap(input, 'folders', new Set());
    expect(g.folders.find(f => f.path === skill)?.layer).toBe('docs');
    expect(g.folders.find(f => f.path === skill)?.counts.files).toBe(1);
    expect(g.folders.find(f => f.path === 'handbook/onboarding')?.layer).toBe('docs');
    expect(g.folders.find(f => f.path === 'src/services')?.layer).toBe('logic');
    expect(g.folders.find(f => f.path === 'packages/foo')?.layer).toBe('core');
    expect(g.folders.find(f => f.path === 'lib/mixed')?.layer).toBe('core');
    expect(buildMap(input, 'files', new Set()).files.map(f => f.id)).toContain('handbook/onboarding/snippet.ts');
    expect(buildMap(input, 'files', new Set()).files.some(f => f.id.endsWith('.md'))).toBe(false);
  });

  it('largeNote: each level says what it shows, only in a large project', () => {
    const folders = 'Large project: showing folders. Open one to see its files.';
    expect(largeNote('folders', true, 0, 12)).toBe(folders);
    expect(largeNote('folders', true, 3, 12)).toBe(folders);
    expect(largeNote('files', true, 0, 12)).toBe('Large project: open a folder to see its files.');
    expect(largeNote('functions', true, 0, 12)).toBe('Large project: open a folder to see its functions.');
    // While some folders are open, the note counts the closed ones; with all open there is none.
    expect(largeNote('files', true, 3, 12)).toBe('9 folders are closed.');
    expect(largeNote('functions', true, 11, 12)).toBe('1 folder is closed.');
    expect(largeNote('files', true, 12, 12)).toBeNull();
    for (const l of ['folders', 'files', 'functions'] as const) expect(largeNote(l, false, 0, 12)).toBeNull();
  });

  it('folders level: aggregated weights, root folder label', () => {
    const g = buildMap(fixture(), 'folders', new Set());
    expect(g.folders.map(f => f.id)).toEqual(['dir:', 'dir:src', 'dir:src/components', 'dir:src/services']);
    expect(g.folders[0].label).toBe('Project root');
    expect(g.folders[2].layer).toBe('ui');
    expect(g.folders[2].counts.files).toBe(2);
    const w = Object.fromEntries(g.edges.map(e => [e.id, e.weight]));
    expect(w).toEqual({
      'dir:src/components->dir:src/services': 3,
      'dir:src/components->dir:src': 1,
      'dir:src/services->dir:src': 2,
      'dir:->dir:src': 1,
    });
  });

  it('functions level: top-level rows with tags from the latest change', () => {
    const changes = [change('src/services/auth.ts', [], ['login'], 1), change('src/services/auth.ts', ['logout'], [], 2)];
    const g = buildMap(fixture({ changes }), 'functions', new Set());
    const auth = g.files.find(f => f.id === 'src/services/auth.ts')!;
    expect(auth.rows).toEqual([{ name: 'login', kind: 'function' }, { name: 'logout', kind: 'function', tag: 'new' }]);
    expect(auth.symbols).toBe(3);
  });

  it('caps rows at 8', () => {
    const many = file('a/x.ts', [], Array.from({ length: 12 }, (_, i) => sym('f' + i, i)));
    const g = buildMap(fixture({ files: { 'a/x.ts': many } }), 'functions', new Set());
    expect(g.files[0].rows.map(r => r.name)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']);
  });

  it('live, flagged, new and edge isNew', () => {
    const flags: Flag[] = [{ id: 1, target: 'src/lib.ts', note: 'x', createdAt: 1, deliveredAt: 2 }, { id: 2, target: null, note: 'y', createdAt: 1 }];
    const helloEdges = new Set(['index.ts->src/lib.ts']);
    const g = buildMap(fixture({ flags, target: 'src/components/Nav.tsx', recent: { 'src/services/user.ts': 'new', 'src/lib.ts': 'edited' }, helloEdges }), 'files', new Set());
    const by = Object.fromEntries(g.files.map(f => [f.id, f]));
    expect(by['src/components/Nav.tsx'].isLive).toBe(true);
    expect(by['src/lib.ts'].isLive).toBe(false);
    expect(by['src/lib.ts'].isFlagged).toBe(true);
    expect(by['src/services/user.ts'].isNew).toBe(true);
    expect(by['src/lib.ts'].isNew).toBe(false);
    expect(g.edges.find(e => e.id === 'index.ts->src/lib.ts')!.isNew).toBe(false);
    expect(g.edges.filter(e => e.isNew)).toHaveLength(6);
  });

  it('large project: only expanded folders at file level', () => {
    const files: Record<string, FileModel> = {};
    for (let i = 0; i < 600; i++) {
      const dir = i % 2 ? 'a' : 'b';
      const p = `${dir}/f${i}.ts`;
      files[p] = file(p, i > 1 ? [`${dir}/f${i % 2 ? 1 : 0}.ts`, `${dir === 'a' ? 'b' : 'a'}/f${i % 2 ? 0 : 1}.ts`] : []);
    }
    const input = fixture({ files });
    const g = buildMap(input, 'files', new Set(['dir:a']));
    expect(LARGE_PROJECT).toBe(500);
    expect(g.large).toBe(true);
    expect(g.files).toHaveLength(300);
    expect(g.files.every(f => f.folder === 'dir:a')).toBe(true);
    expect(g.edges.every(e => e.source.startsWith('a/') && e.target.startsWith('a/'))).toBe(true);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(buildMap(input, 'folders', new Set()).folders).toHaveLength(2);
  });

  it('5,000 files at folders level is fast', () => {
    const files: Record<string, FileModel> = {};
    for (let i = 0; i < 5000; i++) {
      const p = `pkg${i % 100}/src/f${i}.ts`;
      files[p] = file(p, [`pkg${(i + 1) % 100}/src/f${(i + 1) % 5000}.ts`, `pkg${(i + 7) % 100}/src/f${(i + 7) % 5000}.ts`], [sym('a'), sym('b')]);
    }
    const t0 = performance.now();
    const g = buildMap(fixture({ files }), 'folders', new Set());
    const ms = performance.now() - t0;
    console.log(`buildMap 5000 files folders level: ${ms.toFixed(1)} ms`);
    expect(g.folders).toHaveLength(100);
    expect(ms).toBeLessThan(250 * TIME_SCALE);
  });
});
