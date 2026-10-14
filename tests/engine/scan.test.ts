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
});
