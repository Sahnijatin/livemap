import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IGNORES, createIgnore, walk, readForModel, envKeys, isTempName, ignoreStats } from '../../src/engine/files.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-files-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function put(rel: string, data: string | Buffer = 'x'): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

describe('walk', () => {
  it('honors .gitignore and defaults, keeps odd names, skips symlinks', async () => {
    put('.gitignore', 'secret/\n*.tmp\n');
    put('secret/k.ts'); put('a.tmp'); put('src/b.tmp');
    put('node_modules/x.js'); put('dist/a.js'); put('src/a b/ü.ts'); put('keep.ts'); put('app.log');
    fs.symlinkSync(path.join(root, 'keep.ts'), path.join(root, 'link.ts'));
    const { files, truncated } = await walk(root, createIgnore(root));
    expect(truncated).toBe(false);
    expect(files).toEqual(['.gitignore', 'keep.ts', 'src/a b/ü.ts']);
    expect(DEFAULT_IGNORES).toContain('node_modules');
  });
  it('skips the editor temp names the watcher skips', async () => {
    const temps = ['a.ts~', 'b.ts.swp', 'c.ts.swx', 'd.ts.tmp', '.#e.ts', 'src/4913', '.env~'];
    for (const t of temps) put(t);
    put('keep.ts'); put('src/real.ts');
    for (const t of temps) expect(isTempName(t)).toBe(true);
    expect(isTempName('src/real.ts')).toBe(false);
    const { files } = await walk(root, createIgnore(root));
    expect(files).toEqual(['keep.ts', 'src/real.ts']);
  });
  it('truncates at limit', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) put(`${n}.ts`);
    const r = await walk(root, createIgnore(root), 3);
    expect(r.files).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });
  it('honors nested .gitignore files, scoped to their directory, with deeper rules winning', async () => {
    put('.gitignore', '*.secret\n');
    put('pkg/.gitignore', 'gen/\n*.local.ts\n!ok.secret\n');
    put('pkg/gen/x.ts'); put('pkg/a.local.ts'); put('pkg/keep.ts'); put('pkg/ok.secret'); put('pkg/no.secret');
    put('other/a.local.ts'); put('other/ok.secret');
    const ig = createIgnore(root);
    const { files } = await walk(root, ig);
    expect(files).toEqual(['.gitignore', 'other/a.local.ts', 'pkg/.gitignore', 'pkg/keep.ts', 'pkg/ok.secret']);
    // Single-path checks (the watcher's view) agree, including files inside an ignored directory.
    expect(ig('pkg/gen/y.ts', false)).toBe(true);
    expect(ig('pkg/gen', true)).toBe(true);
    expect(ig('pkg/b.local.ts', false)).toBe(true);
    expect(ig('other/b.local.ts', false)).toBe(false);
  });
  it('the walk tells the matcher which directories have no .gitignore, so it never probes them', async () => {
    for (let i = 0; i < 30; i++) put(`d${i}/sub/f.ts`);
    put('d3/.gitignore', 'x/\n');
    const before = ignoreStats.reads;
    await walk(root, createIgnore(root));
    expect(ignoreStats.reads - before).toBeLessThanOrEqual(2); // the root's and d3's
  });
  it('a rebuilt matcher reuses the rules of directories whose .gitignore did not change', () => {
    put('a/.gitignore', 'x/\n'); put('b/.gitignore', 'y/\n');
    const first = createIgnore(root);
    expect(first('a/x/1.ts', false)).toBe(true);
    expect(first('b/y/1.ts', false)).toBe(true);
    put('b/.gitignore', 'z/\n');
    const before = ignoreStats.reads;
    const next = createIgnore(root, { previous: first, changed: ['b'] });
    expect(next('a/x', true)).toBe(true);
    expect(next('b/y', true)).toBe(false);
    expect(next('b/z', true)).toBe(true);
    expect(ignoreStats.reads - before).toBe(2); // the root's and b's; a's rules are reused
  });
  it('a nested .gitignore cannot un-ignore the built-in ignores (only the root one can)', async () => {
    put('sub/.gitignore', '*\n!*/\n!*.js\n');
    put('sub/node_modules/p/i.js'); put('sub/.git/HEAD.js'); put('sub/app.js');
    const ig = createIgnore(root);
    expect(ig('sub/node_modules', true)).toBe(true);
    expect(ig('sub/.git', true)).toBe(true);
    expect((await walk(root, ig)).files).toEqual(['sub/.gitignore', 'sub/app.js'].filter(f => !ig(f, false)));
    expect(ig('sub/app.js', false)).toBe(false);
    put('.gitignore', '!dist/\n');
    expect(createIgnore(root)('dist', true)).toBe(false);
  });
  it('a nested negation works under a default directory the root .gitignore re-included', () => {
    put('.gitignore', '!vendor/\n');
    put('src/.gitignore', '*.gen.ts\n');
    put('src/vendor/.gitignore', '!keep.gen.ts\n');
    const ig = createIgnore(root);
    expect(ig('src/vendor/keep.gen.ts', false)).toBe(false);
    expect(ig('src/vendor/other.gen.ts', false)).toBe(true);
  });
  it('a symlinked .gitignore is not followed, as in git', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-gi-'));
    try {
      fs.writeFileSync(path.join(outside, 'rules'), 'secret.ts\n');
      put('pkg/secret.ts');
      fs.symlinkSync(path.join(outside, 'rules'), path.join(root, 'pkg/.gitignore'));
      expect(createIgnore(root)('pkg/secret.ts', false)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('a walk from a subtree root that is a symlink does not follow it', async () => {
    put('src/a.ts');
    fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link'));
    expect((await walk(root, createIgnore(root), 100, ['link'])).files).toEqual([]);
  });
  it('directory patterns need isDir', () => {
    put('.gitignore', 'secret/\n');
    const ig = createIgnore(root);
    expect(ig('secret', true)).toBe(true);
    expect(ig('secret', false)).toBe(false);
  });
});

describe('readForModel', () => {
  it('strips a leading UTF-8 BOM from text and env files (#25)', async () => {
    put('a.json', '\uFEFF{"a":1}');
    put('.env', '\uFEFFFOO=1\n');
    expect(await readForModel(root, 'a.json')).toEqual({ kind: 'text', text: '{"a":1}', size: 10 });
    expect(await readForModel(root, '.env')).toMatchObject({ kind: 'secret', envKeys: ['FOO'] });
    put('.gitignore', '\uFEFFsecret.ts\n');
    expect(createIgnore(root)('secret.ts', false)).toBe(true);
  });
  it('sizes its read buffer to the file, not the 1 MB cap', async () => {
    put('small.ts', 'export const a = 1;\n');
    const alloc = vi.spyOn(Buffer, 'alloc');
    const unsafe = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      expect(await readForModel(root, 'small.ts')).toEqual({ kind: 'text', text: 'export const a = 1;\n', size: 20 });
      const sizes = [...alloc.mock.calls, ...unsafe.mock.calls].map(c => c[0] as number);
      expect(Math.max(0, ...sizes)).toBeLessThan(4096);
    } finally {
      alloc.mockRestore(); unsafe.mockRestore();
    }
  });
  it('reads all of a file that grew after it was stat-ed, and still caps at 1 MB', async () => {
    put('grow.ts', 'x'.repeat(5000));
    const real = fsp.lstat.bind(fsp);
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(async p => ({ ...(await real(p)), size: 10, isFile: () => true, isSymbolicLink: () => false }) as never);
    try {
      const r = await readForModel(root, 'grow.ts');
      expect(r && r.kind === 'text' && r.text.length).toBe(5000);
      put('huge.ts', 'x'.repeat(1_048_577));
      expect((await readForModel(root, 'huge.ts'))?.kind).toBe('tooLarge');
    } finally {
      lstat.mockRestore();
    }
  });
  it('a file stat-ed while still empty is read without many grow-and-copy rounds', async () => {
    put('late.ts', 'y'.repeat(800_000));
    const real = fsp.lstat.bind(fsp);
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(async p => ({ ...(await real(p)), size: 0, isFile: () => true, isSymbolicLink: () => false }) as never);
    const unsafe = vi.spyOn(Buffer, 'allocUnsafe');
    try {
      const r = await readForModel(root, 'late.ts');
      expect(r && r.kind === 'text' && r.text.length).toBe(800_000);
      expect(unsafe.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      lstat.mockRestore(); unsafe.mockRestore();
    }
  });
  it('a top-level name starting with two dots is inside the root', async () => {
    put('..cache/x.ts', 'export const x = 1;\n');
    expect((await readForModel(root, '..cache/x.ts'))?.kind).toBe('text');
  });
  it('a file of exactly 1 MB is text; one byte more is tooLarge', async () => {
    put('max.ts', 'x'.repeat(1_048_576));
    put('over.ts', 'x'.repeat(1_048_577));
    expect((await readForModel(root, 'max.ts'))?.kind).toBe('text');
    expect((await readForModel(root, 'over.ts'))?.kind).toBe('tooLarge');
  });
  it('hides env values, returns key names', async () => {
    put('.envrc', 'export AWS_SECRET_ACCESS_KEY=leak\n');
    put('prod.env', 'DB_PASSWORD=leak\n');
    expect(await readForModel(root, '.envrc')).toEqual({ kind: 'secret', size: 34, envKeys: ['AWS_SECRET_ACCESS_KEY'] });
    expect(await readForModel(root, 'prod.env')).toEqual({ kind: 'secret', size: 17, envKeys: ['DB_PASSWORD'] });
    put('.env', 'SECRET=abc\nexport API_KEY="x"\n# C=1\n');
    const r = await readForModel(root, '.env');
    expect(r).toMatchObject({ kind: 'secret', envKeys: ['SECRET', 'API_KEY'] });
    expect(JSON.stringify(r)).not.toContain('abc');
  });
  it('treats uppercase env names as secret', async () => {
    put('.ENV', 'TOKEN=zzz');
    const r = await readForModel(root, '.ENV');
    expect(r?.kind).toBe('secret');
    expect(JSON.stringify(r)).not.toContain('zzz');
  });
  it('reads text', async () => {
    put('a.js', 'const a = 1;');
    expect(await readForModel(root, 'a.js')).toEqual({ kind: 'text', text: 'const a = 1;', size: 12 });
  });
  it('NUL byte is binary', async () => {
    put('a.js', Buffer.from([0x61, 0, 0x62]));
    expect((await readForModel(root, 'a.js'))?.kind).toBe('binary');
  });
  it('size limit boundary', async () => {
    put('ok.js', Buffer.alloc(1048576, 0x61));
    put('big.js', Buffer.alloc(1048577, 0x61));
    expect((await readForModel(root, 'ok.js'))?.kind).toBe('text');
    expect(await readForModel(root, 'big.js')).toEqual({ kind: 'tooLarge', size: 1048577 });
  });
  it('binary extension is not read', async () => {
    const p = path.join(root, 'huge.png');
    const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, 50 * 1024 * 1024); fs.closeSync(fd);
    const open = vi.spyOn(fsp, 'open');
    const rf = vi.spyOn(fsp, 'readFile');
    try {
      expect(await readForModel(root, 'huge.png')).toEqual({ kind: 'binary', size: 50 * 1024 * 1024 });
      expect(open).not.toHaveBeenCalled();
      expect(rf).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it('refuses symlinks, including to secrets', async () => {
    put('.env', 'SECRET=abc');
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'link.ts'));
    expect(await readForModel(root, 'link.ts')).toBeNull();
  });
  it('refuses symlinked directories leading outside root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'k.ts'), 'secret');
      fs.symlinkSync(outside, path.join(root, 'd'));
      expect(await readForModel(root, 'd/k.ts')).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('rejects paths outside root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'k.ts'), 'secret');
      const rel = path.relative(root, path.join(outside, 'k.ts')).split(path.sep).join('/');
      expect(rel.startsWith('..')).toBe(true);
      expect(await readForModel(root, rel)).toBeNull();
      expect(await readForModel(root, '../x.ts')).toBeNull();
      expect(await readForModel(root, path.join(outside, 'k.ts'))).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
  it('caps the read at limit + 1 bytes', async () => {
    put('big.js', Buffer.alloc(1048577, 0x61));
    const origLstat = fsp.lstat.bind(fsp);
    // Simulate a file that was small at stat time but grew: size check passes via lstat spy.
    const lstat = vi.spyOn(fsp, 'lstat').mockImplementation(async (...a: any[]) => {
      const st = await (origLstat as any)(...a);
      Object.defineProperty(st, 'size', { value: 10 });
      return st;
    });
    try {
      expect(await readForModel(root, 'big.js')).toEqual({ kind: 'tooLarge', size: 1048577 });
    } finally { lstat.mockRestore(); }
  });
  it('missing is null', async () => {
    expect(await readForModel(root, 'nope.ts')).toBeNull();
  });
});

describe('ignore predicate edge cases', () => {
  it('does not throw on odd paths', () => {
    const ig = createIgnore(root);
    expect(ig('...', false)).toBe(false);
    expect(ig('../x', false)).toBe(true);
    expect(ig('/abs/x', false)).toBe(true);
  });
});

describe('envKeys', () => {
  it('skips continuation lines of multi-line quoted values', () => {
    const src = 'A=1\nPRIVATE_KEY="-----BEGIN KEY-----\nabcd1234EFGH==\nxy=z\n-----END KEY-----"\nB=\'one\ntwo=3\'\nC=2\n';
    expect(envKeys(src)).toEqual(['A', 'PRIVATE_KEY', 'B', 'C']);
  });

  it('extracts names only', () => {
    expect(envKeys('A=1\n  export B = 2\n#C=3\n\nbad line\nD_1=\n')).toEqual(['A', 'B', 'D_1']);
  });

  it('does not let an unterminated quote swallow the following keys (#29)', () => {
    expect(envKeys('A="x\nB="y"\nC=1\n')).toEqual(['A', 'B', 'C']);
    expect(envKeys("A='x\nexport B=2\n")).toEqual(['A', 'B']);
    expect(envKeys('A="x\nB="y\nmore"\nC=1\n')).toEqual(['A', 'B', 'C']);
  });

  it('keeps a valid multi-line value, comment after the close included (#29)', () => {
    const src = 'CERT="-----BEGIN-----\nMIIBabc=\nkey=value\n-----END-----" # pem\nNEXT=1\n';
    expect(envKeys(src)).toEqual(['CERT', 'NEXT']);
  });
});
