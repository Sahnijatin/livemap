import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Wrap the real reader so tests can observe and steer reads during a scan.
const hooks = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  readsDone: 0,
  fail: new Set<string>(),
  reads: new Map<string, number>(),
}));
vi.mock('../../src/engine/files.js', async orig => {
  const real = await orig<typeof import('../../src/engine/files.js')>();
  return {
    ...real,
    readForModel: async (root: string, rel: string) => {
      hooks.inFlight++;
      hooks.reads.set(rel, (hooks.reads.get(rel) ?? 0) + 1);
      hooks.maxInFlight = Math.max(hooks.maxInFlight, hooks.inFlight);
      try {
        await new Promise(r => setTimeout(r, 1));
        return hooks.fail.has(rel) ? null : await real.readForModel(root, rel);
      } finally {
        hooks.inFlight--;
        hooks.readsDone++;
      }
    },
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-scan-'));
  Object.assign(hooks, { inFlight: 0, maxInFlight: 0, readsDone: 0, fail: new Set<string>(), reads: new Map<string, number>() });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('ProjectModel.scan', () => {
  it('reads files concurrently and reports progress while still reading', async () => {
    for (let i = 0; i < 200; i++) put(`src/f${i}.ts`, `export const f${i} = ${i};\n`);
    const m = new ProjectModel(root);
    let readsAtFirstProgress = -1;
    const progress: number[] = [];
    await m.scan((done, total) => {
      if (readsAtFirstProgress < 0) readsAtFirstProgress = hooks.readsDone;
      progress.push(done);
      expect(total).toBe(200);
    });
    expect(m.all()).toHaveLength(200);
    expect(hooks.maxInFlight).toBeGreaterThan(1);
    expect(readsAtFirstProgress).toBeLessThan(200);
    expect(progress).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('a file that cannot be read is left out and never resolves as an import', async () => {
    put('src/a.ts', "import { b } from './b';\nimport { c } from './c';\n");
    put('src/b.ts', 'export const b = 1;\n');
    put('src/c.ts', 'export const c = 1;\n');
    hooks.fail.add('src/c.ts');
    const m = new ProjectModel(root);
    await m.scan();
    expect(m.get('src/c.ts')).toBeUndefined();
    expect(m.get('src/a.ts')!.imports.local).toEqual(['src/b.ts']);
  });

  it('applies tsconfig aliases from the start of the scan', async () => {
    put('tsconfig.json', '{ "compilerOptions": { "paths": { "~lib/*": ["lib/*"] } } }');
    put('a.ts', "import { x } from '~lib/x';\n");
    put('lib/x.ts', 'export const x = 1;\n');
    const m = new ProjectModel(root);
    await m.scan();
    expect(m.get('a.ts')!.imports.local).toEqual(['lib/x.ts']);
    expect(hooks.reads.get('tsconfig.json')).toBe(1);
  });

  it('a reload in a truncated project stops reading once the file limit is reached', async () => {
    for (let i = 0; i < 40; i++) put(`more/f${i}.ts`, `export const f${i} = ${i};\n`);
    put('aa/gen.ts', 'export const g = 1;\n');
    const m = new ProjectModel(root, { limit: 5 });
    await m.scan();
    expect(m.truncated).toBe(true);
    put('.gitignore', 'aa/\n');
    hooks.reads.clear();
    await m.reloadIgnores(['.gitignore']);
    const reads = [...hooks.reads.values()].reduce((a, b) => a + b, 0);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it('a nested reload in a full, truncated project reads no more files than there is room for', async () => {
    for (let i = 0; i < 5; i++) put(`aa/f${i}.ts`, `export const f${i} = ${i};\n`);
    for (let i = 0; i < 40; i++) put(`pkg/g${i}.ts`, `export const g${i} = ${i};\n`);
    put('pkg/.gitignore', 'nothing/\n');
    const m = new ProjectModel(root, { limit: 5 });
    await m.scan();
    expect(m.truncated).toBe(true);
    put('pkg/.gitignore', 'still-nothing/\n');
    hooks.reads.clear();
    await m.reloadIgnores(['pkg/.gitignore']);
    expect([...hooks.reads.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('a nested reload that runs out of room marks the model truncated', async () => {
    put('a/.gitignore', '*.gen.ts\n');
    for (let i = 0; i < 10; i++) put(`a/l${i}.gen.ts`, `export const l${i} = ${i};\n`);
    put('b.ts', 'export const b = 1;\n');
    const m = new ProjectModel(root, { limit: 5 });
    await m.scan();
    expect(m.truncated).toBe(false);
    put('a/.gitignore', '# keep generated\n');
    await m.reloadIgnores(['a/.gitignore']);
    expect(m.all()).toHaveLength(5);
    expect(m.truncated).toBe(true);
  });
});
