import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import type { ChangeSummary, FileModel } from '../../src/shared/types.js';

let root: string;
let model: ProjectModel;
let watcher: Watcher | null;
let changes: { change: ChangeSummary; touched: FileModel[]; t: number }[];
let errors: Error[];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
function put(rel: string, data: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}
async function startWatcher(): Promise<Watcher> {
  model = new ProjectModel(root);
  await model.scan();
  const w = new Watcher(model);
  w.on('change', (change: ChangeSummary, touched: FileModel[]) => changes.push({ change, touched, t: Date.now() }));
  w.on('error', (e: Error) => errors.push(e));
  await w.start();
  watcher = w;
  return w;
}
const names = (c: ChangeSummary) => c.symbols.added.map(s => s.name);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-watch-')));
  put('src/keep.ts', 'export const keep = 1;\n');
  changes = [];
  errors = [];
  watcher = null;
});
afterEach(async () => {
  await watcher?.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Watcher', () => {
  it('emits one created change with the new symbol', async () => {
    await startWatcher();
    put('src/x.ts', 'export function x() { return 1; }\n');
    await waitFor(() => changes.length >= 1);
    await sleep(400);
    expect(changes).toHaveLength(1);
    const c = changes[0].change;
    expect(c.kind).toBe('created');
    expect(c.path).toBe('src/x.ts');
    expect(c.id).toBe(1);
    expect(names(c)).toContain('x');
    expect(model.get('src/x.ts')).toBeDefined();
  });

  it('coalesces five rapid writes into one modified change reflecting the last write', async () => {
    put('src/x.ts', 'export function x() {}\n');
    await startWatcher();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(root, 'src/x.ts'), `export function x() {}\nexport function v${i}() {}\n`);
      await sleep(15);
    }
    await waitFor(() => changes.length >= 1);
    await sleep(400);
    expect(changes).toHaveLength(1);
    const c = changes[0].change;
    expect(c.kind).toBe('modified');
    expect(names(c)).toEqual(['v5']);
  });

  it('treats an atomic save as one modified change and never indexes the tmp file', async () => {
    put('src/x.ts', 'export function x() {}\n');
    await startWatcher();
    let sawTmp = false;
    watcher!.on('change', () => { if (model.all().some(f => f.path.endsWith('.tmp'))) sawTmp = true; });
    const tmp = path.join(root, 'src/.x.ts.tmp');
    await fsp.writeFile(tmp, 'export function x() {}\nexport function y() {}\n');
    await fsp.rename(tmp, path.join(root, 'src/x.ts'));
    await waitFor(() => changes.length >= 1);
    await sleep(400);
    expect(changes.map(c => [c.change.kind, c.change.path])).toEqual([['modified', 'src/x.ts']]);
    expect(names(changes[0].change)).toEqual(['y']);
    expect(sawTmp).toBe(false);
    expect(model.all().some(f => f.path.endsWith('.tmp'))).toBe(false);
  });

  it('ignores writes under node_modules and .git', async () => {
    put('node_modules/p/i.js', 'module.exports = 1;\n');
    put('.git/HEAD', 'ref: refs/heads/main\n');
    await startWatcher();
    put('node_modules/p/i.js', 'module.exports = 2;\n');
    put('.git/HEAD', 'ref: refs/heads/other\n');
    await sleep(600);
    expect(changes).toHaveLength(0);
  });

  it('emits a deleted change per file when a directory is removed', async () => {
    put('src/sub/a.ts', 'export const a = 1;\n');
    put('src/sub/b.ts', 'export const b = 2;\n');
    await startWatcher();
    fs.rmSync(path.join(root, 'src/sub'), { recursive: true, force: true });
    await waitFor(() => changes.length >= 2);
    await sleep(400);
    expect(changes.map(c => c.change.kind)).toEqual(['deleted', 'deleted']);
    expect(changes.map(c => c.change.path).sort()).toEqual(['src/sub/a.ts', 'src/sub/b.ts']);
    expect(model.get('src/sub/a.ts')).toBeUndefined();
    expect(model.get('src/sub/b.ts')).toBeUndefined();
  });

  it('delivers a change for a 1,000-line file within 500 ms of the write', async () => {
    await startWatcher();
    const body = Array.from({ length: 1000 }, (_, i) => `export function f${i}(a: number) { return a + ${i}; }`).join('\n') + '\n';
    const t0 = Date.now();
    await fsp.writeFile(path.join(root, 'src/big.ts'), body);
    await waitFor(() => changes.length >= 1);
    const latency = changes[0].t - t0;
    expect(changes[0].change.path).toBe('src/big.ts');
    expect(latency).toBeLessThan(500);
  });

  it('assigns monotonically increasing ids', async () => {
    await startWatcher();
    put('src/a.ts', 'export const a = 1;\n');
    await waitFor(() => changes.length >= 1);
    put('src/b.ts', 'export const b = 1;\n');
    await waitFor(() => changes.length >= 2);
    expect(changes.map(c => c.change.id)).toEqual([1, 2]);
  });

  it('emits error and keeps processing when an update throws', async () => {
    await startWatcher();
    const orig = model.update.bind(model);
    let thrown = false;
    model.update = async (rel, ev) => {
      if (!thrown && rel === 'src/bad.ts') { thrown = true; throw new Error('boom'); }
      return orig(rel, ev);
    };
    put('src/bad.ts', 'export const bad = 1;\n');
    await waitFor(() => errors.length >= 1);
    expect(errors[0].message).toBe('boom');
    put('src/good.ts', 'export const good = 1;\n');
    await waitFor(() => changes.some(c => c.change.path === 'src/good.ts'));
  });

  it('a throwing error listener does not stop later changes', async () => {
    await startWatcher();
    watcher!.on('error', () => { throw new Error('listener blew up'); });
    const orig = model.update.bind(model);
    let thrown = false;
    model.update = async (rel, ev) => {
      if (!thrown && rel === 'src/bad.ts') { thrown = true; throw new Error('boom'); }
      return orig(rel, ev);
    };
    put('src/bad.ts', 'export const bad = 1;\n');
    await waitFor(() => errors.length >= 1);
    put('src/good.ts', 'export const good = 1;\n');
    await waitFor(() => changes.some(c => c.change.path === 'src/good.ts'));
  });

  it('stop() waits for the in-flight job to finish', async () => {
    await startWatcher();
    const orig = model.update.bind(model);
    let started = false, finished = false;
    model.update = async (rel, ev) => {
      started = true;
      await sleep(300);
      const r = await orig(rel, ev);
      finished = true;
      return r;
    };
    put('src/slow.ts', 'export const slow = 1;\n');
    await waitFor(() => started);
    await watcher!.stop();
    expect(finished).toBe(true);
    expect(changes).toHaveLength(0); // stopped: results are not emitted
  });

  it('stop() cancels pending work', async () => {
    await startWatcher();
    put('src/late.ts', 'export const late = 1;\n');
    await sleep(30);
    await watcher!.stop();
    await sleep(400);
    expect(changes).toHaveLength(0);
  });

  it('re-resolves imports once per burst, not once per file, and reports the result', async () => {
    const N = 40;
    put('src/app.ts', Array.from({ length: N }, (_, i) => `import { n${i} } from './n${i}';`).join('\n') + '\n');
    const w = await startWatcher();
    const touched: FileModel[] = [];
    w.on('touched', (files: FileModel[]) => touched.push(...files));
    const relink = vi.spyOn(model as unknown as { relink: (skip: string[]) => FileModel[] }, 'relink');
    for (let i = 0; i < N; i++) put(`src/n${i}.ts`, `export const n${i} = ${i};\n`);
    await waitFor(() => changes.length >= N, 5000);
    await waitFor(() => model.get('src/app.ts')!.imports.local.length === N, 5000);
    expect(relink.mock.calls.length).toBeLessThan(N / 4);
    const reported = [...changes.flatMap(c => c.touched), ...touched].filter(f => f.path === 'src/app.ts');
    expect(reported.at(-1)!.imports.local).toHaveLength(N);
  });

  it('does not defer the re-resolution forever while events keep coming', async () => {
    model = new ProjectModel(root);
    await model.scan();
    const w = new Watcher(model, { maxDeferMs: 100 });
    w.on('change', (change: ChangeSummary, touched: FileModel[]) => changes.push({ change, touched, t: Date.now() }));
    await w.start();
    watcher = w;
    // Slow updates plus a steady stream of new files keep the queue non-empty throughout.
    const update = model.update.bind(model);
    vi.spyOn(model, 'update').mockImplementation(async (...a) => { await sleep(60); return update(...a); });
    const relinkAt: number[] = [];
    const relink = (model as unknown as { relink: (skip: string[]) => FileModel[] }).relink.bind(model);
    vi.spyOn(model as unknown as { relink: (skip: string[]) => FileModel[] }, 'relink').mockImplementation(skip => { relinkAt.push(Date.now()); return relink(skip); });
    for (let i = 0; i < 30; i++) { put(`src/s${i}.ts`, `export const s${i} = 1;\n`); await sleep(5); }
    // 30 slow jobs (~1.8 s of backlog): without a cap, only the first job and the final drain relink.
    await waitFor(() => changes.length >= 30, 8000);
    await sleep(100);
    expect(relinkAt.length).toBeGreaterThanOrEqual(5);
    const gaps = relinkAt.slice(1).map((t, i) => t - relinkAt[i]);
    expect(Math.max(...gaps)).toBeLessThan(400);
  });

  it('reloads rules when a self-ignoring nested .gitignore is edited', async () => {
    put('tools/.gitignore', '*\n');
    await startWatcher();
    put('tools/.gitignore', '*.tmp\n');
    await waitFor(() => changes.some(c => c.change.path === 'tools/.gitignore'));
    put('tools/run.ts', 'export const run = 1;\n');
    await waitFor(() => model.get('tools/run.ts') !== undefined);
  });
});
