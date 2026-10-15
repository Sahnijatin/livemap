import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { HistoryStore } from '../../src/history/store.js';
import { emptyState } from '../../src/shared/state.js';
import type { ChangeSummary, FileModel } from '../../src/shared/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const APP = 'src/app.ts';
const MARKER = 'embedded-code-marker';
const T0 = Date.UTC(2026, 9, 15, 9, 0);

let root: string;
let home: string;
let out: string;

const file = (p: string, lines = 3): FileModel => ({
  path: p, lang: 'typescript', size: 60, lines, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
const change = (id: number, p: string, at: number): ChangeSummary => ({
  id, path: p, kind: 'modified', at, lang: 'typescript',
  symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
  entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 1, removed: 0 }, hunks: [], truncated: false,
});

test.beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-e2e-export-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-e2e-export-home-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, APP), `export function hello() {\n  return '${MARKER}';\n}\n`);
  fs.writeFileSync(path.join(root, 'src/util.ts'), 'export const util = 1;\n');

  let clock = T0;
  const store = await HistoryStore.open(root, { home, now: () => clock });
  await store.startRun({ ...emptyState(root, path.basename(root)), files: [file(APP), file('src/util.ts')] });
  store.append({ type: 'session', session: { id: 's1', agent: 'claude-code', title: 'Say hello', cwd: root, startedAt: T0, lastAt: T0, status: 'working', hooks: true } }, (clock += 1000));
  for (let i = 1; i <= 24; i++) {
    clock += 1000;
    if (i % 6 === 0) store.append({ type: 'change', change: change(i, APP, clock), files: [file(APP, 3 + i)], removed: [] }, clock);
    else store.append({ type: 'agentEvent', event: { id: i, agent: 'claude-code', sessionId: 's1', at: clock, type: i === 1 ? 'prompt' : 'message', text: `step ${i}` } }, clock);
  }
  await store.close();

  out = path.join(root, 'replay.html');
  const r = spawnSync(process.execPath, [path.join(repo, 'dist/cli.js'), 'export', root, '--out', out], { env: { ...process.env, LIVEMAP_HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`export failed: ${r.stdout}${r.stderr}`);
});

test.afterAll(() => {
  for (const d of [root, home]) fs.rmSync(d, { recursive: true, force: true });
});

test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });

test('export: opens offline from file://, rewound at the end, plays, and shows embedded code', async ({ page, context }) => {
  const requests: string[] = [];
  context.on('request', req => requests.push(req.url()));
  page.on('websocket', ws => requests.push(ws.url()));
  // Anything that would leave the machine fails instead.
  await context.route(/^(https?|wss?):/, r => r.abort());
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(pathToFileURL(out).href);

  const timeline = page.getByRole('group', { name: 'Session timeline' });
  await expect(timeline.locator('.tl-state')).toHaveText('REWOUND');
  await expect(page.locator('.statuschip')).toHaveText('Replay');
  await expect(page.getByRole('button', { name: 'Back to live' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pause agent|Resume agent/ })).toHaveCount(0);
  const slider = timeline.getByRole('slider', { name: 'Time' });
  const last = Number(await slider.getAttribute('aria-valuemax'));
  await expect(slider).toHaveAttribute('aria-valuenow', String(last));

  // Play starts over from the first record and moves forward.
  await timeline.getByRole('button', { name: 'Play history' }).click();
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeLessThan(last);
  const early = Number(await slider.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')), { timeout: 15_000 }).toBeGreaterThan(early);
  await expect(timeline.locator('.tl-state')).toHaveText('REWOUND');

  // The code view reads the embedded text.
  await page.getByRole('tree', { name: 'Files' }).locator(`[data-file="${APP}"]`).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).locator('pre.code')).toContainText(MARKER);

  // The Map lays out with the inlined ELK worker.
  const workers: string[] = [];
  page.on('worker', w => workers.push(w.url()));
  await page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: /^Map\b/ }).click();
  await page.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
  await expect.poll(() => workers.length).toBeGreaterThan(0);
  expect(workers.every(u => /^(data|blob):/.test(u))).toBe(true);

  expect(errors).toEqual([]);
  const offending = requests.filter(u => !/^(file|data|blob):/.test(u));
  expect(offending).toEqual([]);
  console.log(`[export e2e] ${fs.statSync(out).size} bytes; requests: ${[...new Set(requests.map(u => u.split(':')[0]))].join(', ')}`);
});
