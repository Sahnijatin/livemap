import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startMockNexus, type MockNexus } from '../helpers/mock-nexus';

/*
 * The ServiceNow inspector, filters, unattributed badge and diagnostics, on the BharatBank fixture served by the mock
 * nexus. The mirror has no update sets yet, so the test gives the card carousel widget one (as `livemap sn` will
 * write it into meta.json) and posts one call of a tool the classifier does not know.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const shots = process.env.LIVEMAP_SHOTS ?? path.join(root, 'test-results', 'servicenow-ui');

const SCOPE = 'x_snc_cc_offering';
const CAROUSEL = `${SCOPE}/widget/bb-card-carousel__5f0000000000000000000000000000c2`;
const SET = 'Card refresh';
const UNKNOWN = 'sn_frobnicate_widget';

let tmp: string;
let home: string;
let nexus: MockNexus;
let proc: ChildProcess | undefined;
let out = '';
let url: string;

function startSn(dir: string, nexusUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [
      path.join(root, 'dist/cli.js'), 'sn', dir, '--scope', SCOPE, '--instance', 'inmorphisdemo3',
      '--nexus', nexusUrl, '--no-open', '--port', '0',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIVEMAP_HOME: home } });
    proc = p;
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`livemap sn did not print a URL:\n${out}`)); }, 60_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('exit', code => { clearTimeout(timer); reject(new Error(`livemap sn exited early (${code}):\n${out}`)); });
  });
}

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-snui-e2e-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-snui-home-')));
  nexus = await startMockNexus();
  url = await startSn(tmp, nexus.url);
});

test.afterAll(async () => {
  const p = proc;
  if (p && p.exitCode === null && p.signalCode === null) {
    const exited = new Promise<void>(r => p.once('exit', () => r()));
    p.kill('SIGTERM');
    const killer = setTimeout(() => p.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }
  await nexus?.close();
  for (const d of [tmp, home]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

const token = () => new URL(url).searchParams.get('t')!;
const api = (p: string) => new URL(p, url).toString();
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: new RegExp(`^${name}\\b`, 'i') });
const mirror = () => path.join(tmp, '.livemap', 'sn');

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

test('servicenow: filters, the record inspector, the unattributed badge and diagnostics', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(url);
  const bar = page.getByRole('group', { name: 'Filters' });
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // With LiveMap watching, the carousel widget gets an update set, as the mirror will record it: one unattributed change.
  const metaFile = path.join(mirror(), CAROUSEL, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, `${JSON.stringify({ ...meta, sys_update_set: { value: '5f00000000000000000000000000fe01', display_value: SET } }, null, 2)}\n`);
  const changes = async () => (await (await fetch(api(`/api/state?t=${token()}`))).json() as { changes: { path: string; attribution?: unknown }[] }).changes;
  await expect.poll(async () => (await changes()).some(c => c.path.startsWith(CAROUSEL)), { timeout: 20_000 }).toBe(true);

  // The unattributed badge counts the changes with no attribution.
  const badge = page.locator('#sn-badge button');
  await expect(badge).toContainText('unattributed');
  await expect.poll(async () => {
    const n = (await changes()).filter(c => !c.attribution).length;
    const shown = Number((await badge.locator('b').innerText()).replace(/,/g, ''));
    return n > 0 && n === shown;
  }, { timeout: 20_000 }).toBe(true);

  // Filter by scope, then by update set: the Map keeps only the carousel widget's files, and the URL keeps both.
  await tab(page, 'map').click();
  await page.locator('.react-flow__node').first().waitFor({ timeout: 20_000 });
  await bar.getByLabel('Scope').selectOption(SCOPE);
  await expect(bar.getByLabel('Update set')).toContainText(SET, { timeout: 20_000 });
  await bar.getByLabel('Update set').selectOption(SET);
  await expect.poll(() => new URL(page.url()).searchParams.get('set')).toBe(SET);
  expect(new URL(page.url()).searchParams.get('scope')).toBe(SCOPE);
  await expect(bar.getByRole('button', { name: 'Clear 2 filters' })).toBeVisible();
  const folders = page.locator('.react-flow__node.react-flow__node-folder, .react-flow__node.react-flow__node-folderLabel');
  await expect.poll(async () => {
    const ids = await folders.evaluateAll(els => els.map(e => e.getAttribute('data-id') ?? ''));
    return ids.length > 0 && ids.every(id => id.includes('bb-card-carousel'));
  }, { timeout: 20_000 }).toBe(true);
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, 'servicenow-filters-map.png'), animations: 'disabled' });

  // A reload keeps the filters.
  await page.reload();
  await expect(page.getByRole('group', { name: 'Filters' }).getByLabel('Update set')).toHaveValue(SET, { timeout: 30_000 });
  await page.getByRole('group', { name: 'Filters' }).getByRole('button', { name: 'Clear 2 filters' }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('set')).toBeNull();

  // Select the widget: the inspector shows the record, what it uses, and a link to it on the instance.
  const filter = page.getByPlaceholder('Filter files and functions');
  await filter.fill('bb-card-carousel');
  await page.getByRole('treeitem', { name: /meta\.json/ }).first().click();
  const card = page.getByLabel('ServiceNow record');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('BB Card Carousel');
  await expect(card).toContainText('Widget');
  await expect(card).toContainText(SET);
  await expect(card).toContainText('admin');
  const uses = card.locator('.sn-uses');
  await expect(uses).toContainText('BBPortalFormatUtils');
  await expect(uses).toContainText('x_snc_cc_offering_card_catalogue');
  const open = card.getByRole('link', { name: 'Open in ServiceNow' });
  await expect(open).toHaveAttribute('href', 'https://inmorphisdemo3.service-now.com/sp_widget.do?sys_id=5f0000000000000000000000000000c2');
  await expect(open).toHaveAttribute('target', '_blank');
  // The change came from no agent: unattributed, with the meaning on hover.
  await expect(card.locator('.sn-conf')).toHaveText('Unattributed');
  await page.waitForTimeout(800);
  await page.locator('#inspector').screenshot({ path: path.join(shots, 'servicenow-inspector.png'), animations: 'disabled' });

  // Clicking the badge filters to the unattributed changes; clicking again clears it.
  await badge.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('conf')).toBe('none');
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  await badge.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('conf')).toBeNull();

  // One call of a tool the classifier does not know, from an agent session.
  const hook = await fetch(api('/hook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-livemap-token': token() },
    body: JSON.stringify({ agent: 'codex', event: 'PreToolUse', payload: {
      session_id: 'e2e-sn-codex', transcript_path: null, cwd: mirror(), hook_event_name: 'PreToolUse', model: 'm', turn_id: 't1',
      tool_name: `mcp__skyforge-nexus__${UNKNOWN}`, tool_input: { id: 'x' },
    } }),
  });
  expect(hook.status).toBe(200);
  // Diagnostics list the tool the classifier could not place, with its call count.
  await page.getByRole('button', { name: /Unknown tools/ }).click();
  const diag = page.getByRole('dialog', { name: 'Diagnostics' });
  await expect(diag).toBeVisible();
  await expect(diag.getByRole('row', { name: new RegExp(UNKNOWN) })).toContainText('1', { timeout: 10_000 });
  await page.screenshot({ path: path.join(shots, 'servicenow-diagnostics.png'), animations: 'disabled' });
});
