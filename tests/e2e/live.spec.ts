import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const SERVICE = 'server/services/orderService.ts';

let tmp: string;
let proc: ChildProcess;
let url: string;

function startCli(dir: string): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'dist/cli.js'), dir, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p; // assigned up front so afterAll can always kill it
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`CLI did not print a URL:\n${out}`)); }, 20_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(timer); resolve({ proc: p, url: m[0] }); }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('exit', code => { clearTimeout(timer); p.kill('SIGKILL'); reject(new Error(`CLI exited early (${code}):\n${out}`)); });
  });
}

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-e2e-'));
  fs.cpSync(path.join(root, 'tests/fixtures/shop'), tmp, { recursive: true });
  ({ url } = await startCli(tmp));
});

test.afterAll(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>(r => proc.once('exit', () => r()));
    proc.kill('SIGTERM');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Files' });
const fileRow = (page: Page, p: string) => tree(page).locator(`[data-file="${p}"]`);
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });

test('live update flow: browse, inspect, edit, break, delete', async ({ page }) => {
  // A code project never asks for ServiceNow records or loads the ServiceNow chunk.
  const snRequests: string[] = [];
  page.on('request', r => { if (/\/api\/sn\b|\/SnHost-[\w-]+\.js|\/SnRecord-[\w-]+\.js/.test(r.url())) snRequests.push(r.url()); });
  await page.goto(url);
  // R11: the token is stripped from the address bar after load.
  await expect(page).not.toHaveURL(/[?&]t=/);

  await expect(fileRow(page, SERVICE)).toBeVisible({ timeout: 15_000 });
  // A reload (no ?t= any more) still connects: the tab keeps its key in sessionStorage, not a cookie.
  await page.reload();
  expect(await page.context().cookies()).toEqual([]);
  const row = fileRow(page, SERVICE);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.locator('.fn')).toHaveText('orderService.ts');
  // Every project's Live session links the third-party notices.
  await expect(page.getByRole('link', { name: 'Third-party notices' })).toHaveAttribute('href', '/THIRD_PARTY_NOTICES.md');

  // Expanding the file shows its symbols.
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.locator('.chev').click();
  await expect(tree(page).getByRole('treeitem', { name: /createOrder/ })).toBeVisible();
  await expect(tree(page).getByRole('treeitem', { name: /listOrders/ })).toBeVisible();

  // Selecting it fills the inspector.
  await row.click();
  await expect(page.getByRole('link', { name: 'Third-party notices' })).toHaveCount(0);
  const insp = inspector(page);
  await expect(insp.getByRole('heading', { name: 'orderService.ts' })).toBeVisible();
  const uses = insp.locator('.sec', { has: page.getByRole('heading', { name: 'Uses', exact: true }) });
  await expect(uses.getByRole('button', { name: 'db.ts' })).toBeVisible();
  await expect(insp.locator('pre.code')).toContainText('export async function listOrders');
  await page.screenshot({ path: 'test-results/dark-1-initial.png' });

  const file = path.join(tmp, SERVICE);

  // Append a function: NEW tag in the tree within 1.5 s, new lines highlighted.
  const t1 = Date.now();
  fs.appendFileSync(file, 'export function refund(id: string) {}\n');
  const refund = tree(page).getByRole('treeitem', { name: /refund/ });
  await expect(refund).toBeVisible({ timeout: 1500 });
  await expect(refund).toHaveClass(/\bnew\b/, { timeout: 1500 });
  await expect(insp.locator('pre.code')).toContainText('export function refund', { timeout: 1500 });
  await expect(insp.locator('pre.code .hl').first()).toBeVisible({ timeout: 1500 });
  await expect(insp.locator('pre.code .hl').last()).toContainText('refund');
  expect(Date.now() - t1).toBeLessThanOrEqual(1500);
  await expect(row.locator('.badge')).toHaveText('Edited');
  await page.screenshot({ path: 'test-results/dark-2-new-symbol.png' });
  await tree(page).screenshot({ path: 'test-results/dark-tree.png' });
  await insp.screenshot({ path: 'test-results/dark-inspector.png' });

  // Break the syntax: parse error badge, last good symbols still listed.
  fs.writeFileSync(file, 'export function broken( {\n');
  const parseErr = row.locator('.b-err');
  await expect(parseErr).toBeVisible({ timeout: 1500 });
  await expect(tree(page).getByRole('treeitem', { name: /refund/ })).toBeVisible();
  // The half-written-save moment: selected row with PARSE ERROR and EDITED at the 272 px sidebar.
  await expect(row.locator('.b-edit')).toBeVisible();
  await expect(row).toHaveClass(/\bsel\b/);
  const name = row.locator('.fn');
  await expect(name).toHaveText('orderService.ts');
  const fit = await name.evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fit.scroll, `name clipped: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.client);
  await row.screenshot({ path: 'test-results/dark-row-parse-error-edited.png' });
  await expect(parseErr).toHaveAccessibleName(/parse error/i);
  await page.screenshot({ path: 'test-results/dark-3-parse-error.png' });

  // Delete: gone from the tree within 1.5 s.
  const t2 = Date.now();
  fs.rmSync(file);
  await expect(fileRow(page, SERVICE)).toHaveCount(0, { timeout: 1500 });
  expect(Date.now() - t2).toBeLessThanOrEqual(1500);
  await page.screenshot({ path: 'test-results/dark-4-deleted.png' });
  expect(snRequests).toEqual([]);
});
