import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = vi.hoisted(() => ({ read: false, symbols: false }));
vi.mock('../../src/engine/files.js', async orig => {
  const real = await orig<typeof import('../../src/engine/files.js')>();
  return { ...real, readForModel: (root: string, rel: string) => (fail.read ? Promise.resolve(null) : real.readForModel(root, rel)) };
});
vi.mock('../../src/engine/symbols/index.js', async orig => {
  const real = await orig<typeof import('../../src/engine/symbols/index.js')>();
  return {
    ...real,
    fileSymbols: (...a: Parameters<typeof real.fileSymbols>) => (fail.symbols ? Promise.reject(new Error('boom')) : real.fileSymbols(...a)),
  };
});
const { ProjectModel } = await import('../../src/engine/project.js');

let root: string;
function put(rel: string, data: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
beforeEach(() => {
  fail.read = false; fail.symbols = false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-projfail-'));
  put('src/a.ts', "import { hello } from './b';\nhello();\n");
  put('src/b.ts', 'export function hello() {}\n');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('ProjectModel failure handling', () => {
  it('a transient read failure on an existing file keeps state and returns null', async () => {
    const m = new ProjectModel(root);
    await m.scan();
    fail.read = true;
    expect(await m.update('src/b.ts', 'change')).toBeNull();
    expect(m.get('src/b.ts')).toBeDefined();
    expect(m.content('src/b.ts')).toContain('hello');
    expect(m.get('src/a.ts')!.imports.local).toEqual(['src/b.ts']);
    fail.read = false;
    put('src/b.ts', 'export function hello( {\n');
    const r = await m.update('src/b.ts', 'change');
    expect(r!.kind).toBe('modified');
    expect(r!.after!.flags.parseError).toBe(true); // R7 tracking survived
  });

  it('a read failure on a file that is really gone still deletes it', async () => {
    const m = new ProjectModel(root);
    await m.scan();
    fs.rmSync(path.join(root, 'src/b.ts'));
    fail.read = true;
    expect((await m.update('src/b.ts', 'unlink'))!.kind).toBe('deleted');
  });

  it('a throwing build leaves stored text unchanged so the next update retries', async () => {
    const m = new ProjectModel(root);
    await m.scan();
    put('src/b.ts', 'export function bye() {}\n');
    fail.symbols = true;
    await expect(m.update('src/b.ts', 'change')).rejects.toThrow('boom');
    expect(m.content('src/b.ts')).toBe('export function hello() {}\n');
    fail.symbols = false;
    const r = await m.update('src/b.ts', 'change');
    expect(r!.after!.symbols.map(s => s.name)).toEqual(['bye']);
  });
});
