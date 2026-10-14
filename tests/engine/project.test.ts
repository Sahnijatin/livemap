import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectModel } from '../../src/engine/project.js';
import { indexStats } from '../../src/engine/imports.js';

let root: string;
function put(rel: string, data: string | Buffer): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-project-'));
  put('src/a.ts', "import { hello } from './b';\nhello();\n");
  put('src/b.ts', 'export function hello() {}\nexport const unused = 1;\n');
  put('README.md', '# Title\n\n## Part\n');
  put('.env', 'API_KEY=supersecret\nDB_URL=postgres://x\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

async function scanned(): Promise<ProjectModel> {
  const m = new ProjectModel(root);
  await m.scan();
  return m;
}

describe('ProjectModel', () => {
  it('scans files, resolves imports, hides secrets', async () => {
    const progress: [number, number][] = [];
    const m = new ProjectModel(root);
    await m.scan((d, t) => progress.push([d, t]));
    expect(m.all().map(f => f.path).sort()).toEqual(['.env', 'README.md', 'src/a.ts', 'src/b.ts']);
    expect(m.get('src/a.ts')!.imports.local).toEqual(['src/b.ts']);
    expect(m.content('.env')).toBeNull();
    const env = m.get('.env')!;
    expect(env.env).toEqual(['API_KEY', 'DB_URL']);
    expect(env.flags.secret).toBe(true);
    expect(env.symbols).toEqual([]);
    expect(env.lines).toBe(0);
    expect(JSON.stringify(env)).not.toContain('supersecret');
    const b = m.get('src/b.ts')!;
    expect(b.symbols.map(s => s.name)).toEqual(['hello', 'unused']);
    expect(b.lines).toBe(2);
    expect(b.routes).toEqual([]);
    expect(b.entities).toEqual([]);
    expect(b.deps).toBeUndefined();
    expect(m.get('README.md')!.symbols.map(s => s.name)).toEqual(['Title']);
    expect(m.content('src/b.ts')).toContain('export function hello');
    expect(progress.at(-1)).toEqual([4, 4]);
  });

  it('reports created and modified, null on identical content', async () => {
    const m = await scanned();
    put('src/c.ts', 'export const c = 1;\n');
    const r1 = await m.update('src/c.ts', 'add');
    expect(r1!.kind).toBe('created');
    expect(r1!.before).toBeNull();
    expect(r1!.afterText).toBe('export const c = 1;\n');
    put('src/a.ts', "import { hello } from './b';\nimport { c } from './c';\nhello();\n");
    const r2 = await m.update('src/a.ts', 'change');
    expect(r2!.kind).toBe('modified');
    expect(r2!.after!.imports.local).toContain('src/c.ts');
    expect(r2!.beforeText).toContain("from './b'");
    expect(await m.update('src/a.ts', 'change')).toBeNull();
  });

  it('heals dangling imports when the target appears, and breaks them on delete', async () => {
    const m = await scanned();
    put('src/d.ts', "import { e } from './e';\n");
    await m.update('src/d.ts', 'add');
    expect(m.get('src/d.ts')!.imports.local).toEqual([]);
    put('src/e.ts', 'export const e = 1;\n');
    const r = await m.update('src/e.ts', 'add');
    expect(r!.touched.map(f => f.path)).toContain('src/d.ts');
    expect(m.get('src/d.ts')!.imports.local).toEqual(['src/e.ts']);
    fs.rmSync(path.join(root, 'src/e.ts'));
    const del = await m.update('src/e.ts', 'unlink');
    expect(del!.kind).toBe('deleted');
    expect(del!.after).toBeNull();
    expect(del!.touched.map(f => f.path)).toEqual(['src/d.ts']);
    expect(m.get('src/d.ts')!.imports.local).toEqual([]);
    expect(await m.update('src/e.ts', 'unlink')).toBeNull();
  });

  it('keeps last good symbols on a parse error and clears the flag when fixed', async () => {
    const m = await scanned();
    put('src/b.ts', 'export function hello( {\n');
    const r = await m.update('src/b.ts', 'change');
    expect(r!.after!.flags.parseError).toBe(true);
    expect(r!.after!.symbols.map(s => s.name)).toContain('hello');
    put('src/b.ts', 'export function hello() {}\nexport function bye() {}\n');
    const fixed = await m.update('src/b.ts', 'change');
    expect(fixed!.after!.flags.parseError).toBeUndefined();
    expect(fixed!.after!.symbols.map(s => s.name)).toEqual(['hello', 'bye']);
  });

  it('stays flagged with last good symbols across repeated broken saves', async () => {
    const m = await scanned();
    put('src/b.ts', 'export function hello( {\n');
    await m.update('src/b.ts', 'change');
    put('src/b.ts', 'export function other( {\n');
    const r = await m.update('src/b.ts', 'change');
    expect(r!.after!.flags.parseError).toBe(true);
    expect(r!.after!.symbols.map(s => s.name)).toEqual(['hello', 'unused']);
  });

  it('does not flag a file whose first parse fails, keeping recovered symbols', async () => {
    put('src/bad.ts', 'export function ok() {}\nexport function broken( {\n');
    const m = await scanned();
    const f = m.get('src/bad.ts')!;
    expect(f.flags.parseError).toBeUndefined();
    expect(f.symbols.map(s => s.name)).toContain('ok');
  });

  it('removeDir deletes every file under the directory', async () => {
    const m = await scanned();
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    const rs = await m.removeDir('src');
    expect(rs.map(r => r.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(rs.every(r => r.kind === 'deleted' && r.after === null)).toBe(true);
    expect(m.get('src/a.ts')).toBeUndefined();
    expect(m.all().map(f => f.path).sort()).toEqual(['.env', 'README.md']);
  });

  it('removeDir keeps files that are back on disk (directory deleted and recreated)', async () => {
    const m = await scanned();
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    put('src/a.ts', "import { hello } from './b';\nhello();\n");
    const rs = await m.removeDir('src');
    expect(rs.map(r => [r.path, r.kind])).toEqual([['src/b.ts', 'deleted']]);
    expect(m.get('src/a.ts')).toBeDefined();
    expect(m.get('src/b.ts')).toBeUndefined();
  });

  it('ignores ignored paths and honors directory patterns', async () => {
    put('.gitignore', 'secret/\n');
    put('node_modules/x/index.js', 'module.exports = 1;\n');
    const m = await scanned();
    expect(m.ignored('node_modules/x/index.js')).toBe(true);
    expect(m.ignored('secret', true)).toBe(true);
    expect(m.get('node_modules/x/index.js')).toBeUndefined();
    expect(await m.update('node_modules/x/index.js', 'change')).toBeNull();
  });

  it('handles binary and large files by size, storing no content', async () => {
    put('logo.png', Buffer.from([1, 2, 3]));
    const m = await scanned();
    expect(m.get('logo.png')!.flags.binary).toBe(true);
    expect(m.content('logo.png')).toBeNull();
    expect(await m.update('logo.png', 'change')).toBeNull();
    put('logo.png', Buffer.from([1, 2, 3, 4]));
    const r = await m.update('logo.png', 'change');
    expect(r!.kind).toBe('modified');
    expect(r!.afterText).toBeNull();
    put('big.txt', 'x'.repeat(1_048_577));
    const big = await m.update('big.txt', 'add');
    expect(big!.after!.flags.tooLarge).toBe(true);
    expect(m.content('big.txt')).toBeNull();
  });

  it('secret file updates expose only key names', async () => {
    const m = await scanned();
    put('.env', 'API_KEY=changed\nNEW_KEY=1\n');
    const r = await m.update('.env', 'change');
    expect(r!.after!.env).toEqual(['API_KEY', 'NEW_KEY']);
    expect(r!.beforeText).toBeNull();
    expect(r!.afterText).toBeNull();
    expect(JSON.stringify(r)).not.toContain('changed');
  });

  it('re-resolves imports when tsconfig aliases change', async () => {
    put('src/lib/util.ts', 'export const u = 1;\n');
    put('src/f.ts', "import { u } from '@lib/util';\n");
    const m = await scanned();
    expect(m.get('src/f.ts')!.imports.local).toEqual([]);
    put('tsconfig.json', '{ "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"] } } }');
    const r = await m.update('tsconfig.json', 'add');
    expect(r!.touched.map(f => f.path)).toEqual(['src/f.ts']);
    expect(m.get('src/f.ts')!.imports.local).toEqual(['src/lib/util.ts']);
  });

  it('uses the go module path from go.mod', async () => {
    put('go.mod', 'module example.com/app\n\ngo 1.22\n');
    put('pkg/util/util.go', 'package util\n\nfunc U() {}\n');
    put('main.go', 'package main\n\nimport "example.com/app/pkg/util"\n\nfunc main() { util.U() }\n');
    const m = await scanned();
    expect(m.get('main.go')!.imports.local).toEqual(['pkg/util/util.go']);
  });

  it('serializes concurrent updates', async () => {
    const m = await scanned();
    put('src/x.ts', "import { y } from './y';\n");
    put('src/y.ts', 'export const y = 1;\n');
    const [rx, ry] = await Promise.all([m.update('src/x.ts', 'add'), m.update('src/y.ts', 'add')]);
    expect(rx!.kind).toBe('created');
    expect(ry!.kind).toBe('created');
    expect(m.get('src/x.ts')!.imports.local).toEqual(['src/y.ts']);
  });

  it('counts lines without the trailing newline', async () => {
    put('n.txt', 'a\nb\nc');
    put('e.txt', '');
    const m = await scanned();
    expect(m.get('n.txt')!.lines).toBe(3);
    expect(m.get('e.txt')!.lines).toBe(0);
    expect(m.get('src/a.ts')!.lines).toBe(2);
  });
});

describe('ProjectModel with buildUsedBy', () => {
  it('finds hello used by a.ts and nothing for unused', async () => {
    const { buildUsedBy } = await import('../../src/engine/usedby.js');
    const m = await scanned();
    expect(buildUsedBy(m.all(), p => m.content(p))).toEqual([{ file: 'src/b.ts', symbol: 'hello', usedIn: ['src/a.ts'] }]);
  });
});

describe('ProjectModel fix round 1', () => {
  it('all() is sorted by path', async () => {
    const m = await scanned();
    put('src/0first.ts', 'export const z = 1;\n');
    await m.update('src/0first.ts', 'add');
    const paths = m.all().map(f => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('refuses live creates at the file limit', async () => {
    const m = new ProjectModel(root, { limit: 4 });
    await m.scan();
    put('src/c.ts', 'export const c = 1;\n');
    expect(await m.update('src/c.ts', 'add')).toBeNull();
    expect(m.get('src/c.ts')).toBeUndefined();
    expect(m.truncated).toBe(true);
    put('src/b.ts', 'export function hello() {}\n');
    expect((await m.update('src/b.ts', 'change'))!.kind).toBe('modified');
  });

  it('removeDir puts combined touched on the last result, and a later unlink is null', async () => {
    put('lib/x.ts', 'export const x = 1;\n');
    put('lib/y.ts', 'export const y = 1;\n');
    put('app.ts', "import { x } from './lib/x';\nimport { y } from './lib/y';\n");
    const m = await scanned();
    expect(m.get('app.ts')!.imports.local).toEqual(['lib/x.ts', 'lib/y.ts']);
    fs.rmSync(path.join(root, 'lib'), { recursive: true });
    const rs = await m.removeDir('lib');
    expect(rs.map(r => r.path)).toEqual(['lib/x.ts', 'lib/y.ts']);
    expect(rs[0].touched).toEqual([]);
    expect(rs[1].touched.map(f => f.path)).toEqual(['app.ts']);
    expect(m.get('app.ts')!.imports.local).toEqual([]);
    expect(await m.update('lib/x.ts', 'unlink')).toBeNull();
  });

  it('a deferred update skips the import re-resolution until flushRelink', async () => {
    put('app.ts', "import { x } from './lib/x';\n");
    const m = await scanned();
    expect(m.get('app.ts')!.imports.local).toEqual([]);
    put('lib/x.ts', 'export const x = 1;\n');
    const r = await m.update('lib/x.ts', 'add', { deferRelink: true });
    expect(r!.kind).toBe('created');
    expect(r!.touched).toEqual([]);
    expect(m.get('app.ts')!.imports.local).toEqual([]);
    const touched = await m.flushRelink();
    expect(touched.map(f => [f.path, f.imports.local])).toEqual([['app.ts', ['lib/x.ts']]]);
    expect(m.get('app.ts')!.imports.local).toEqual(['lib/x.ts']);
    expect(await m.flushRelink()).toEqual([]);
  });

  it('deferred updates in a burst resolve against the files the burst already added or removed', async () => {
    put('lib/old.ts', 'export const old = 1;\n');
    const m = await scanned();
    put('lib/b.ts', 'export const b = 1;\n');
    await m.update('lib/b.ts', 'add', { deferRelink: true });
    fs.rmSync(path.join(root, 'lib/old.ts'));
    await m.update('lib/old.ts', 'unlink', { deferRelink: true });
    put('lib/a.ts', "import { b } from './b';\nimport { old } from './old';\n");
    const a = await m.update('lib/a.ts', 'add', { deferRelink: true });
    expect(a!.after!.imports.local).toEqual(['lib/b.ts']);
  });

  it('reloadIgnores drops newly ignored files and indexes newly included ones', async () => {
    put('.gitignore', 'gen/\n');
    put('gen/out.ts', "import { hello } from '../src/b';\nexport const out = hello;\n");
    put('secrets.json', '{"k":"v"}\n');
    const m = await scanned();
    expect(m.get('gen/out.ts')).toBeUndefined();
    put('.gitignore', 'secrets.json\n');
    const r = await m.reloadIgnores(['.gitignore']);
    expect(r.removed).toEqual(['secrets.json']);
    expect(r.files.map(f => f.path)).toEqual(['gen/out.ts']);
    expect(r.files[0].imports.local).toEqual(['src/b.ts']);
    expect(m.get('secrets.json')).toBeUndefined();
    expect(m.content('secrets.json')).toBeNull();
    expect(m.get('gen/out.ts')!.imports.local).toEqual(['src/b.ts']);
    expect(await m.reloadIgnores(['.gitignore'])).toEqual({ files: [], removed: [], created: [] });
  });

  it('reloadIgnores reads nested .gitignore files created after their directory was seen', async () => {
    const m = await scanned();
    put('pkg/keep.ts', 'export const k = 1;\n');
    expect(m.ignored('pkg/generated/x.ts')).toBe(false);
    put('pkg/.gitignore', 'generated/\n');
    await m.reloadIgnores(['pkg/.gitignore']);
    expect(m.ignored('pkg/generated/x.ts')).toBe(true);
  });

  it('deferred Go and JVM imports see directories the burst already created', async () => {
    put('go.mod', 'module shop\n');
    const m = await scanned();
    put('src/com/acme/util/Strings.java', 'package com.acme.util;\npublic class Strings {}\n');
    await m.update('src/com/acme/util/Strings.java', 'add', { deferRelink: true });
    put('src/com/acme/App.java', 'package com.acme;\nimport com.acme.util.*;\npublic class App {}\n');
    const app = await m.update('src/com/acme/App.java', 'add', { deferRelink: true });
    expect(app!.after!.imports).toEqual({ local: ['src/com/acme/util/Strings.java'], external: [] });
    put('internal/db/db.go', 'package db\n');
    await m.update('internal/db/db.go', 'add', { deferRelink: true });
    put('cmd/main.go', 'package main\nimport "shop/internal/db"\n');
    const main = await m.update('cmd/main.go', 'add', { deferRelink: true });
    expect(main!.after!.imports.local).toEqual(['internal/db/db.go']);
  });

  it('forgets a deleted file\'s cached import specifiers', async () => {
    const m = await scanned();
    const cache = (m as unknown as { specCache: Map<string, unknown> }).specCache;
    expect(cache.has('src/a.ts')).toBe(true);
    fs.rmSync(path.join(root, 'src/a.ts'));
    await m.update('src/a.ts', 'unlink');
    expect(cache.has('src/a.ts')).toBe(false);
  });

  it('removeDir checks files on disk concurrently', async () => {
    for (let i = 0; i < 50; i++) put(`gen/g${i}.ts`, `export const g${i} = 1;\n`);
    const m = await scanned();
    fs.rmSync(path.join(root, 'gen'), { recursive: true });
    let inFlight = 0;
    let max = 0;
    const real = fsp.lstat.bind(fsp);
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(async p => {
      inFlight++; max = Math.max(max, inFlight);
      try { await new Promise(r => setTimeout(r, 2)); return await real(p); } finally { inFlight--; }
    });
    try {
      const rs = await m.removeDir('gen');
      expect(rs).toHaveLength(50);
      expect(max).toBeGreaterThan(1);
    } finally {
      lstat.mockRestore();
    }
  });

  it('a config change is never deferred, so the rest of a burst uses the new aliases', async () => {
    put('lib/x.ts', 'export const x = 1;\n');
    const m = await scanned();
    put('tsconfig.json', '{ "compilerOptions": { "paths": { "~lib/*": ["lib/*"] } } }');
    await m.update('tsconfig.json', 'add', { deferRelink: true });
    put('a.ts', "import { x } from '~lib/x';\n");
    const a = await m.update('a.ts', 'add', { deferRelink: true });
    expect(a!.after!.imports.local).toEqual(['lib/x.ts']);
  });

  it('a Go burst builds the directory index once and keeps it current', async () => {
    put('go.mod', 'module shop\n');
    const m = await scanned();
    const before = indexStats.builds;
    for (let i = 0; i < 20; i++) {
      put(`pkg${i}/p.go`, `package pkg${i}\n`);
      await m.update(`pkg${i}/p.go`, 'add', { deferRelink: true });
      put(`cmd${i}/main.go`, `package main\nimport "shop/pkg${i}"\n`);
      const r = await m.update(`cmd${i}/main.go`, 'add', { deferRelink: true });
      expect(r!.after!.imports.local).toEqual([`pkg${i}/p.go`]);
    }
    fs.rmSync(path.join(root, 'pkg0'), { recursive: true });
    await m.update('pkg0/p.go', 'unlink', { deferRelink: true });
    put('cmd0/main.go', 'package main\nimport "shop/pkg0"\n// edited\n');
    expect((await m.update('cmd0/main.go', 'change', { deferRelink: true }))!.after!.imports.local).toEqual([]);
    expect(indexStats.builds - before).toBe(1);
  });

  it('drops a file\'s cached specifiers when it stops being text', async () => {
    const m = await scanned();
    const cache = (m as unknown as { specCache: Map<string, unknown> }).specCache;
    expect(cache.has('src/a.ts')).toBe(true);
    put('src/a.ts', 'x'.repeat(1_048_577));
    await m.update('src/a.ts', 'change');
    expect(m.get('src/a.ts')!.flags.tooLarge).toBe(true);
    expect(cache.has('src/a.ts')).toBe(false);
  });

  it('reloadIgnores leaves new, never-ignored files to their own events', async () => {
    const m = await scanned();
    put('fresh.ts', 'export const fresh = 1;\n'); // its add event is still queued
    put('.gitignore', 'nothing/\n');
    const r = await m.reloadIgnores(['.gitignore']);
    expect(r.files.map(f => f.path)).not.toContain('fresh.ts');
    expect((await m.update('fresh.ts', 'add'))!.kind).toBe('created');
  });

  it('reloadIgnores reports the topmost newly included directories, empty ones too', async () => {
    put('.gitignore', 'gen/\nlogs/\n');
    put('gen/a/x.ts', 'export const x = 1;\n');
    fs.mkdirSync(path.join(root, 'logs/empty'), { recursive: true });
    const m = await scanned();
    put('.gitignore', '# nothing\n');
    let dirs: string[] = [];
    await m.reloadIgnores(['.gitignore'], { onIncluded: d => { dirs = d; } });
    expect(dirs).toEqual(['gen', 'logs']);
  });

  it('a directory un-ignored by a reload uses its current .gitignore, not rules cached while it was ignored', async () => {
    put('sub/.gitignore', '*.log\n');
    put('sub/a.txt', 'a\n');
    const m = await scanned();
    put('.gitignore', 'sub/\n');
    await m.reloadIgnores(['.gitignore']);
    put('sub/.gitignore', '*.txt\n'); // no event: sub is ignored
    put('.gitignore', '# nothing\n');
    await m.reloadIgnores(['.gitignore']);
    expect(m.ignored('sub/a.txt')).toBe(true);
    expect(m.get('sub/a.txt')).toBeUndefined();
  });

  it('a nested .gitignore change walks only its own subtree', async () => {
    put('pkg/.gitignore', 'gen/\n');
    put('pkg/gen/x.ts', 'export const x = 1;\n');
    put('other/deep/y.ts', 'export const y = 1;\n');
    const m = await scanned();
    put('pkg/.gitignore', '# nothing\n');
    const readdir = vi.spyOn(fsp, 'readdir');
    try {
      const r = await m.reloadIgnores(['pkg/.gitignore']);
      expect(r.files.map(f => f.path)).toEqual(['pkg/gen/x.ts']);
      const visited = readdir.mock.calls.map(c => path.relative(root, String(c[0])).split(path.sep).join('/'));
      expect(visited.some(d => d.startsWith('other'))).toBe(false);
      expect(visited).toContain('pkg');
    } finally {
      readdir.mockRestore();
    }
  });

  it('removeDir can defer its relink to flushRelink', async () => {
    put('lib/x.ts', 'export const x = 1;\n');
    put('app.ts', "import { x } from './lib/x';\n");
    const m = await scanned();
    fs.rmSync(path.join(root, 'lib'), { recursive: true });
    const rs = await m.removeDir('lib', { deferRelink: true });
    expect(rs.map(r => r.path)).toEqual(['lib/x.ts']);
    expect(rs[0].touched).toEqual([]);
    expect(m.get('app.ts')!.imports.local).toEqual(['lib/x.ts']);
    expect((await m.flushRelink()).map(f => f.path)).toEqual(['app.ts']);
    expect(m.get('app.ts')!.imports.local).toEqual([]);
  });

  it('reloadIgnores hands included dirs to the watcher before reading them', async () => {
    put('.gitignore', 'gen/\n');
    put('gen/a.ts', 'export const a = 1;\n');
    const m = await scanned();
    put('.gitignore', '# nothing\n');
    let seenWhileUnread: boolean | null = null;
    const r = await m.reloadIgnores(['.gitignore'], { onIncluded: dirs => { seenWhileUnread = dirs.includes('gen') && !m.get('gen/a.ts'); } });
    expect(seenWhileUnread).toBe(true);
    expect(r.files.map(f => f.path)).toEqual(['gen/a.ts']);
  });

  it('after a truncated scan, newly reachable files come back as created changes, not silent updates', async () => {
    for (const n of ['a', 'b', 'c']) put(`gen/${n}.ts`, `export const ${n} = 1;\n`);
    put('zz/z.ts', 'export const z = 1;\n');
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.rmSync(path.join(root, 'README.md'));
    fs.rmSync(path.join(root, '.env'));
    const m = new ProjectModel(root, { limit: 3 });
    await m.scan();
    put('.gitignore', 'gen/\n');
    const r = await m.reloadIgnores(['.gitignore']);
    expect(r.created.map(c => [c.path, c.kind]).sort()).toEqual([['.gitignore', 'created'], ['zz/z.ts', 'created']]);
    expect(r.files.map(f => f.path)).not.toContain('zz/z.ts');
    expect(await m.update('zz/z.ts', 'add')).toBeNull();
  });


  it('a reload that frees room indexes files a truncated scan never reached', async () => {
    for (const n of ['a', 'b', 'c']) put(`gen/${n}.ts`, `export const ${n} = 1;\n`);
    put('zz/z.ts', 'export const z = 1;\n');
    fs.rmSync(path.join(root, 'src'), { recursive: true });
    fs.rmSync(path.join(root, 'README.md'));
    fs.rmSync(path.join(root, '.env'));
    const m = new ProjectModel(root, { limit: 3 });
    await m.scan();
    expect(m.truncated).toBe(true);
    expect(m.get('zz/z.ts')).toBeUndefined();
    put('.gitignore', 'gen/\n'); // the .gitignore itself takes one slot
    await m.reloadIgnores(['.gitignore']);
    expect(m.get('zz/z.ts')).toBeDefined();
    expect(m.truncated).toBe(false);
  });

  it('a directory replaced by a symlink to outside the project counts as gone', async () => {
    put('lib/a.ts', 'export const a = 1;\n');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'a.ts'), 'export const leaked = 1;\n');
      const m = await scanned();
      fs.rmSync(path.join(root, 'lib'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'lib'));
      expect((await m.removeDir('lib')).map(r => r.path)).toEqual(['lib/a.ts']);
      expect(m.get('lib/a.ts')).toBeUndefined();
      expect(m.content('lib/a.ts')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a transient failure resolving the root is not cached', async () => {
    put('lib/a.ts', 'export const a = 1;\n');
    const m = new ProjectModel(root); // not scanned: the root has not been resolved yet
    const real = fsp.realpath.bind(fsp);
    let fail = true;
    const spy = vi.spyOn(fsp, 'realpath').mockImplementation(async p => {
      if (fail && String(p) === root) { fail = false; throw Object.assign(new Error('gone for a moment'), { code: 'ENOENT' }); }
      return real(p);
    });
    const isGone = (rel: string) => (m as unknown as { isGone(rel: string): Promise<boolean> }).isGone(rel);
    try {
      expect(await isGone('lib/a.ts')).toBe(true); // the root was briefly missing
      expect(await isGone('lib/a.ts')).toBe(false); // it is back, and so is the file
    } finally {
      spy.mockRestore();
    }
  });
});
