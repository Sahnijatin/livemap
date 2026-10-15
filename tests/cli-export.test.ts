import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnce } from './build.js';
import { HistoryStore } from '../src/history/store.js';
import { emptyState } from '../src/shared/state.js';
import type { ChangeSummary, FileModel } from '../src/shared/types.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli.js');

let root: string;
let lmHome: string;
let cwd: string;

beforeAll(buildOnce, 180_000);

beforeEach(() => {
  const mk = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  root = mk('lm-cliexp-root-');
  lmHome = mk('lm-cliexp-home-');
  cwd = mk('lm-cliexp-cwd-');
});
afterEach(() => {
  for (const d of [root, lmHome, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

const file = (p: string): FileModel => ({
  path: p, lang: 'typescript', size: 10, lines: 1, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
const change = (id: number, p: string): ChangeSummary => ({
  id, path: p, kind: 'modified', at: id, lang: 'typescript',
  symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
  entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 1, removed: 0 }, hunks: [], truncated: false,
});

async function seed(names = ['a.ts', 'b.ts']): Promise<void> {
  for (const f of names) fs.writeFileSync(path.join(root, f), `export const ${f[0]} = 1;\n`);
  const store = await HistoryStore.open(root, { home: lmHome });
  await store.startRun({ ...emptyState(root, path.basename(root)), files: names.map(file) });
  names.forEach((n, i) => store.append({ type: 'change', change: change(i + 1, n), files: [file(n)], removed: [] }));
  await store.close();
}

const run = (args: string[]) =>
  spawnSync(process.execPath, [cli, 'export', ...args], { cwd, env: { ...process.env, LIVEMAP_HOME: lmHome }, encoding: 'utf8' });

describe('livemap export', () => {
  it('writes the replay to --out and prints the code warning, the path and the size', async () => {
    await seed();
    const out = path.join(cwd, 'replay.html');
    const r = run([root, '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('This export contains source code for 2 files. Share it only with people who may see this code.');
    expect(r.stdout).toContain(out);
    expect(r.stdout).toMatch(/\d+(\.\d+)? (KB|MB)/);
    const html = fs.readFileSync(out, 'utf8');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('id="livemap-data"');
    expect(html).not.toContain(root);
  });

  it('says "1 file" for one file', async () => {
    await seed(['a.ts']);
    const r = run([root, '--out', path.join(cwd, 'one.html')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('source code for 1 file.');
    expect(r.stdout).not.toContain('1 files');
  });

  it('names the file livemap-<name>-<YYYYMMDD-HHmm>.html in the current directory by default; --no-code drops the warning', async () => {
    await seed();
    const r = run([root, '--no-code']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('This export contains source code');
    const made = fs.readdirSync(cwd);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(new RegExp(`^livemap-${path.basename(root)}-\\d{8}-\\d{4}\\.html$`));
  });

  it('exits 1 with the exact message when nothing is recorded', () => {
    const r = run([root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No history recorded for this project yet. Run livemap here first.');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });
});
