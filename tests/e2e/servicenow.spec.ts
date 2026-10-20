import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { loadFixture, startMockNexus, type MockNexus } from '../helpers/mock-nexus';
import { runtimeFor } from '../../src/agents/runtime';

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
      '--nexus', nexusUrl, '--skyforge-log', logFile, '--no-open', '--port', '0', '--poll', '2',
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
  expect(out).toContain('SkyForge user: admin (from the nexus session). Saves by other users match only calls that name them.');
  expect(out).toContain('Attribution: 18 matched, 3 ambiguous (3 on table and time only, 0 of them with the author not checked, 0 on an unknown instance), 91 unmatched (16% matched; window 60 s).');
  expect(out).not.toContain('warning: history');
  expect(out).toContain('LiveMap is watching x_snc_cc_offering on inmorphisdemo3');
  await page.goto(url);
  await expect(page.getByText('x_snc_cc_offering on inmorphisdemo3').first()).toBeVisible();
  expect(new Set(nexus.calls.map(c => c.inner ?? c.tool))).toEqual(new Set(['sn_query_table', 'sn_get_instance_info', 'sn_session_context']));
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

test('livemap sn: a record saved on the instance shows within 8 s, a SkyForge change is exact, and an outage shows offline', async ({ page }) => {
  await expect.poll(() => out, { timeout: 30_000 }).toContain('Live polling every 2 s (read-only).');
  await page.goto(url);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 30_000 });
  const fx = loadFixture();
  const rule = fx.tables.sys_script[0] as Record<string, string>;
  // A business rule saved in the platform UI: a new update_xml row, its record and its inventory row.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  nexus.live.rows.sys_update_set = [{ sys_id: '5f0000000000000000000000000fe001', name: 'Card refresh' }];
  nexus.live.rows.sys_update_xml = [{
    sys_id: '5e0000000000000000000000000000e1', name: `sys_script_${rule.sys_id}`, type: 'Business Rule', target_name: rule.name, action: 'INSERT_OR_UPDATE',
    update_set: '5f0000000000000000000000000fe001', sys_created_by: 'dev.one', sys_updated_by: 'dev.one', sys_updated_on: now, payload: '',
  }];
  nexus.live.rows.sys_script = [{ ...rule, script: '// saved in the platform UI\n', sys_updated_on: now, sys_updated_by: 'dev.one' }];
  nexus.live.rows.sys_metadata = [{ sys_id: rule.sys_id, sys_class_name: 'sys_script', sys_name: rule.sys_name, sys_updated_on: now, sys_updated_by: 'dev.one', sys_scope: fx.scope.sys_id }];
  const card = page.locator('article.f-chg .p').filter({ hasText: rule.sys_id });
  await expect(card.first()).toBeVisible({ timeout: 8000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, '.livemap', 'sn', 'x_snc_cc_offering.manifest.json'), 'utf8'));
  expect(manifest.records[rule.sys_id]).toMatchObject({ updateSet: '5f0000000000000000000000000fe001', updateSetName: 'Card refresh', updatedBy: 'dev.one', updatedOn: now });
  // Polls only read.
  expect(new Set(nexus.calls.map(c => c.inner ?? c.tool))).toEqual(new Set(['sn_query_table', 'sn_get_instance_info', 'sn_session_context']));

  // A change made through SkyForge: its plugin reports the call to LiveMap's /hook, then the poll sees the save.
  process.env.LIVEMAP_HOME = home;
  const run = runtimeFor(path.join(tmp, '.livemap', 'sn'));
  expect(run, 'the runtime entry of livemap sn').toBeTruthy();
  const widget = fx.tables.sp_widget[0] as Record<string, string>;
  const t = Date.now();
  const capture = {
    source: 'skyforge-plugin', sessionId: 'e2e-skyforge', callId: 'e2e-call-1', tool: 'tool_execute', innerTool: 'sn_record_manage',
    args: { tool: 'sn_record_manage', args: { table: 'sp_widget', sys_id: widget.sys_id, action: 'update' } },
    targets: [{ kind: 'record', instance: 'inmorphisdemo3', table: 'sp_widget', sysId: widget.sys_id }], resultSysIds: [],
    instance: 'inmorphisdemo3', user: 'admin', start: t - 1500, end: t - 500, ok: true,
  };
  const posted = await fetch(`http://127.0.0.1:${run!.port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-livemap-token': run!.token }, body: JSON.stringify(capture) });
  expect(posted.status).toBe(200);
  const at = new Date(t).toISOString().slice(0, 19).replace('T', ' ');
  nexus.live.rows.sys_update_xml.push({
    sys_id: '5e0000000000000000000000000000e2', name: `sp_widget_${widget.sys_id}`, type: 'Widget', target_name: widget.name, action: 'INSERT_OR_UPDATE',
    update_set: '5f0000000000000000000000000fe001', sys_created_by: 'admin', sys_updated_by: 'admin', sys_updated_on: at, payload: '',
  });
  nexus.live.rows.sp_widget = [{ ...widget, css: '.changed-through-skyforge { color: red; }', sys_updated_on: at, sys_updated_by: 'admin' }];
  nexus.live.rows.sys_metadata.push({ sys_id: widget.sys_id, sys_class_name: 'sp_widget', sys_name: widget.sys_name, sys_updated_on: at, sys_updated_by: 'admin', sys_scope: fx.scope.sys_id });
  const viaSkyForge = page.locator('article.f-chg').filter({ has: page.locator('.p', { hasText: widget.sys_id }) });
  await expect(viaSkyForge.locator('.ag-badge.exact').first()).toBeVisible({ timeout: 8000 });

  // nexus goes down: the chip says so, and the map stays.
  nexus.live.down = true;
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeAttached({ timeout: 15_000 });
  await expect(page.getByText('instance offline')).toBeVisible();
  await expect(card.first()).toBeVisible();
  nexus.live.down = false;
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 30_000 });
  await expect.poll(() => out, { timeout: 5000 }).toContain('Instance back online; catching up.');
});
