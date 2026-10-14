import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IGNORES, createIgnore, walk, readForModel, envKeys, isTempName } from '../../src/engine/files.js';

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
  it('directory patterns need isDir', () => {
    put('.gitignore', 'secret/\n');
    const ig = createIgnore(root);
    expect(ig('secret', true)).toBe(true);
    expect(ig('secret', false)).toBe(false);
  });
});

describe('readForModel', () => {
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
});
