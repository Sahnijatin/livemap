import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { loadFixture, startMockNexus, type MockNexus } from '../helpers/mock-nexus';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const shots = process.env.LIVEMAP_SHOTS ?? path.join(root, 'test-results', 'servicenow');

let tmp: string;
let home: string;
let nexus: MockNexus;
let proc: ChildProcess | undefined;
let out = '';
let url: string;

function startSn(dir: string, nexusUrl: string, logFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [
      path.join(root, 'dist/cli.js'), 'sn', dir, '--scope', 'x_snc_cc_offering', '--instance', 'inmorphisdemo3',
      '--nexus', nexusUrl, '--skyforge-log', logFile, '--no-open', '--port', '0',
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
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-sn-e2e-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-sn-home-')));
  nexus = await startMockNexus();
  // The fixture's SkyForge log lines after a connect line, so the run never reads a real ~/.skyforge log.
  const log = path.join(home, 'skyforge-mcp.log');
  const connect = '[2026-05-29T00:00:00.000Z] [INFO] [Auth] ✅ Connected to inmorphisdemo3.service-now.com';
  fs.writeFileSync(log, `${[connect, ...loadFixture().mcpLogExcerpt.lines].join('\n')}\n`);
  url = await startSn(tmp, nexus.url, log);
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

const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: new RegExp(`^${name}\\b`, 'i') });
async function badge(page: Page, name: string): Promise<number> {
  const label = (await tab(page, name).getAttribute('aria-label')) ?? '';
  const m = /, ([\d,]+)$/.exec(label);
  expect(m, `no count in "${label}"`).toBeTruthy();
  return Number(m![1].replace(/,/g, ''));
}

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

test('livemap sn: mirrors the BharatBank scope and shows it in the Map and Schema views', async ({ page }) => {
  // The CLI says what it pulls before pulling, and only reads.
  expect(out).toContain('Instance: inmorphisdemo3 (brazil patch1)');
  expect(out).toMatch(/Scope: Credit Card Offering \(x_snc_cc_offering, sys_id 5f0+1\)/);
  expect(out).toMatch(/Pulled 1,683 records in \d+ classes/);
  expect(out).toMatch(/Versions imported: 112 \(0 from sys_update_version, 112 from sys_update_xml, plus 167 recaptures\) for 111 records/);
  expect(out).toMatch(/SkyForge log: 401 lines parsed \(146 write calls\) from /);
  expect(out).toContain('Attribution: 18 matched, 3 ambiguous (3 on table and time only, 0 on an unknown instance), 91 unmatched (16% matched; window 60 s).');
  expect(out).not.toContain('warning: history');
  expect(out).toContain('LiveMap is watching x_snc_cc_offering on inmorphisdemo3');
  await page.goto(url);
  await expect(page.getByText('x_snc_cc_offering on inmorphisdemo3').first()).toBeVisible();
  expect(new Set(nexus.calls.map(c => c.inner ?? c.tool))).toEqual(new Set(['sn_query_table', 'sn_get_instance_info']));
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, '.livemap', 'sn', 'x_snc_cc_offering.manifest.json'), 'utf8'));
  expect(Object.keys(manifest.records)).toHaveLength(1683);

  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 30_000 });
  // 11 portal pages and 5 workspace routes; 7 scope tables plus the platform tables the scope extends.
  expect(await badge(page, 'API')).toBeGreaterThanOrEqual(16);
  expect(await badge(page, 'Schema')).toBeGreaterThanOrEqual(7);

  fs.mkdirSync(shots, { recursive: true });
  await tab(page, 'map').click();
  await expect(tab(page, 'map')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.react-flow__node').first().waitFor({ timeout: 20_000 });
  // The home page's layout is used by the page (portal -> page) and uses the widgets it places, the card
  // carousel among them (Uses, in the inspector).
  const filter = page.getByPlaceholder('Filter files and functions');
  await filter.fill('cc_home');
  await page.getByRole('treeitem', { name: /layout\.json/ }).or(page.getByText('layout.json')).first().click();
  await expect(page.getByText('USES', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Nothing uses this yet')).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'servicenow-map-page.png'), animations: 'disabled' });
  // The card carousel widget's server.js calls new x_snc_cc_offering.BBPortalFormatUtils() and reads the
  // card catalogue table through a string; the widget's meta.json, placed by a page, uses it.
  await filter.fill('bb-card-carousel');
  await page.getByText('server.js').first().click();
  await expect(page.getByText(/BBPortalFormatUtils/).first()).toBeVisible();
  await expect(page.getByText(/x_snc_cc_offering_card_catalogue/).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(shots, 'servicenow-map-widget.png'), animations: 'disabled' });
  await filter.fill('');

  await tab(page, 'Schema').click();
  await expect(tab(page, 'Schema')).toHaveAttribute('aria-selected', 'true');
  const app = page.locator('.react-flow__node[data-id="x_snc_cc_offering_credit_card_application"]');
  await expect(app).toBeVisible({ timeout: 20_000 });
  await expect(app.locator('.rules .col.rule').first()).toBeVisible();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, 'servicenow-schema.png'), animations: 'disabled' });
});
