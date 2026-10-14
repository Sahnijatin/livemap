import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectModel } from '../../src/engine/project.js';

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
});
