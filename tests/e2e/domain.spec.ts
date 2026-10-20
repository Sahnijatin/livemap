import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const ROUTES = 'apps/api/src/routes/orders.ts';
const SCHEMA = 'prisma/schema.prisma';
const API_PKG = 'apps/api/package.json';
const SECRET = 'xyz';
const SECRET_LINE = 'SECRET_VALUE_SHOULD_NOT_APPEAR=';

let tmp: string;
let proc: ChildProcess | undefined;
let url: string;

function startCli(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'dist/cli.js'), dir, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p; // assigned up front so afterAll can always kill it
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`CLI did not print a URL:\n${out}`)); }, 20_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited early (${code}):\n${out}`)); });
  });
}

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-domain-e2e-')));
  fs.cpSync(path.join(root, 'tests/fixtures/fullstack'), tmp, { recursive: true });
  expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).toContain(`${SECRET_LINE}${SECRET}`);
  url = await startCli(tmp);
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
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Views' }).getByRole('tab', { name: new RegExp(`^${name}\\b`) });
/** The number in a tab's count badge, read from its accessible name ("API, 5"). */
async function badge(page: Page, name: string): Promise<number> {
  const label = (await tab(page, name).getAttribute('aria-label')) ?? '';
  const m = /, ([\d,]+)$/.exec(label);
  expect(m, `no count in "${label}"`).toBeTruthy();
  return Number(m![1].replace(/,/g, ''));
}
const routeCard = (page: Page, method: string, fullPath: string) =>
  page.locator('.ap-route')
    .filter({ has: page.locator('.mth', { hasText: new RegExp(`^${method}$`) }) })
    .filter({ has: page.locator('.ap-t', { hasText: new RegExp(`^${fullPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }) });
const laneCard = (page: Page, kind: 'handler' | 'service' | 'table', text: string) =>
  page.locator(`.ap-${kind}`).filter({ has: page.locator('.ap-t', { hasText: new RegExp(`^${text}$`) }) });
const changeCard = (page: Page, file: string) =>
  page.getByRole('main', { name: 'Activity' }).locator('.f-chg').filter({ has: page.locator('.p', { hasText: new RegExp(`^${file}$`) }) }).first();
const ordersNode = (page: Page) => page.locator('.react-flow__node[data-id="orders"]');

/**
 * A card's box relative to the schema canvas, once it has stopped moving (two equal reads 150 ms apart).
 * Relative to the canvas, so the view's own entrance slide (translateY on a tab switch) does not count as the card moving.
 */
async function settledBox(page: Page, l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const read = async () => {
    const [b, c] = await Promise.all([l.boundingBox(), page.locator('.sv-canvas').boundingBox()]);
    return b && c ? { x: b.x - c.x, y: b.y - c.y, width: b.width, height: b.height } : null;
  };
  let prev = await read();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 150));
    const next = await read();
    if (prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5 && Math.abs(prev.height - next.height) < 0.5) return next;
    prev = next;
  }
  throw new Error('card never settled');
}

test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });

test('domain views on a polyglot repo: stack, schema, api, live edits', async ({ page }) => {
  // Review Focus 2: no frame from the server carries the .env value.
  const frames: string[] = [];
  page.on('websocket', ws => ws.on('framereceived', f => { frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8')); }));

  await page.goto(url);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({ timeout: 15_000 });

  // 2. Stack: detected technologies and env var names, never the .env value.
  await tab(page, 'Stack').click();
  const stack = page.locator('.b-stack');
  for (const name of ['Next.js', 'Express', 'FastAPI', 'Prisma', 'Docker']) {
    await expect(stack.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 10_000 });
  }
  const env = page.locator('.b-env');
  for (const name of ['DATABASE_URL', 'MODEL_PATH', 'SECRET_VALUE_SHOULD_NOT_APPEAR']) {
    await expect(env.locator('.erow').filter({ has: page.locator('.en', { hasText: new RegExp(`^${name}$`) }) }).locator('.echip.ok')).toHaveText('In .env.example');
  }
  await expect(env.locator('.erow').filter({ has: page.locator('.en', { hasText: /^SECRET_VALUE_SHOULD_NOT_APPEAR$/ }) }).locator('.echip.def')).toHaveText('Defined in .env');
  const text = await page.evaluate(() => document.body.innerText + '\n' + document.body.textContent);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET_LINE);

  // 3. Schema: three merged tables, orders carries status from the SQL migration, relation edges drawn.
  const tables = await badge(page, 'Schema');
  expect(tables).toBe(3);
  await tab(page, 'Schema').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(tables, { timeout: 10_000 });
  const orders = page.locator('.tbl[data-table="orders"]');
  await expect(orders.locator('.col .cn', { hasText: /^status$/ })).toBeVisible();
  await expect.poll(() => page.locator('.react-flow__edge').count(), { timeout: 5000 }).toBeGreaterThan(0);

  // 4. API: GET /api/orders traced through handler, service and table; hovering lights that flow.
  await tab(page, 'API').click();
  const getOrders = routeCard(page, 'GET', '/api/orders');
  await expect(getOrders).toBeVisible({ timeout: 10_000 });
  const handler = laneCard(page, 'handler', 'listOrders');
  const service = laneCard(page, 'service', 'orderService.ts');
  const table = laneCard(page, 'table', 'orders');
  await expect(handler).toBeVisible();
  await expect(service).toBeVisible();
  await expect(table).toBeVisible();
  const predict = routeCard(page, 'POST', '/v1/ml/predict');
  await expect(predict).toBeVisible();
  await getOrders.hover();
  for (const c of [getOrders, handler, service, table]) await expect(c).toHaveClass(/\bon\b/);
  await expect(predict).toHaveClass(/\bdim\b/);
  // A flat connector has a zero-height box, so count the lit paths rather than test visibility.
  await expect.poll(() => page.locator('.ap-edges path.flow').count()).toBeGreaterThanOrEqual(3);
  await page.mouse.move(0, 0);
  await expect(getOrders).not.toHaveClass(/\bon\b/);
  // Lines only for a traced route: none at rest, and a picked route keeps its flow drawn until Esc.
  await expect(page.locator('.ap-edges path')).toHaveCount(0);
  await getOrders.locator('.ap-pick').click();
  await page.mouse.move(0, 0);
  await expect(getOrders).toHaveClass(/\bpicked\b/);
  await expect(table).toHaveClass(/\bon\b/);
  await expect.poll(() => page.locator('.ap-edges path.flow').count()).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('Escape');
  await expect(getOrders).not.toHaveClass(/\bpicked\b/);
  await expect(page.locator('.ap-edges path')).toHaveCount(0);
  // The route's file opens in the inspector.
  await getOrders.locator('.ap-file').click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'orders.ts' })).toBeVisible();
  await expect(getOrders).not.toHaveClass(/\bpicked\b/);
  await expect(page.locator('.ap-gh').filter({ hasText: '/api/orders' })).toHaveAttribute('aria-expanded', 'true');
  const pages = page.locator('.ap-sec').filter({ has: page.getByRole('heading', { name: /^Pages · / }) });
  await expect(pages.locator('.pg-p')).toHaveText(['/', '/orders']);

  // 5a. Live: a new Express route reaches the API view and the Activity feed within 3 s.
  const routesBefore = await badge(page, 'API');
  const t0 = Date.now();
  fs.appendFileSync(path.join(tmp, ROUTES), "router.delete('/orders/:id', removeOrder);\n");
  const del = routeCard(page, 'DELETE', '/api/orders/:id');
  await expect(del).toBeVisible({ timeout: 3000 });
  await expect(del).toHaveClass(/\benter\b/);
  await expect(tab(page, 'API')).toHaveAttribute('aria-label', `API, ${routesBefore + 1}`, { timeout: 3000 });
  await tab(page, 'Activity').click();
  const routeFact = changeCard(page, ROUTES).locator('.fact').filter({ has: page.locator('.tg', { hasText: /^Route$/ }) });
  await expect(routeFact.locator('code')).toHaveText('DELETE /api/orders/:id', { timeout: 3000 });
  expect(Date.now() - t0).toBeLessThanOrEqual(3000);

  // 5b. Live: a Prisma field shows as a highlighted row, and the orders card does not move.
  await tab(page, 'Schema').click();
  await expect(ordersNode(page)).toBeVisible();
  const before = await settledBox(page, ordersNode(page));
  const schemaFile = path.join(tmp, SCHEMA);
  const schema = fs.readFileSync(schemaFile, 'utf8');
  const anchor = '  createdAt DateTime    @default(now())\n';
  expect(schema).toContain(anchor);
  fs.writeFileSync(schemaFile, schema.replace(anchor, `${anchor}  notes     String?\n`));
  await expect(orders.locator('.col.new .cn', { hasText: /^notes$/ })).toBeVisible({ timeout: 3000 });
  const after = await settledBox(page, ordersNode(page));
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
  expect(after.height).toBeGreaterThan(before.height);

  // 5c. Live: a dependency version bump shows as a Dependency fact.
  const pkgFile = path.join(tmp, API_PKG);
  fs.writeFileSync(pkgFile, fs.readFileSync(pkgFile, 'utf8').replace('"express": "^4.19.2"', '"express": "^4.21.0"'));
  await tab(page, 'Activity').click();
  const depFact = changeCard(page, API_PKG).locator('.fact').filter({ has: page.locator('.tg', { hasText: /^Dependency$/ }) });
  await expect(depFact.locator('code')).toHaveText('express', { timeout: 3000 });
  await expect(depFact.locator('small')).toHaveText('^4.19.2 to ^4.21.0');

  // Still no secret anywhere after the live updates.
  const later = await page.evaluate(() => document.body.innerText + '\n' + document.body.textContent);
  expect(later).not.toContain(SECRET);
  expect(later).not.toContain(SECRET_LINE);
  expect(frames.length).toBeGreaterThan(0);
  for (const f of frames) {
    expect(f).not.toContain(`${SECRET_LINE}${SECRET}`);
    expect(f).not.toMatch(/"xyz"|=xyz\b/);
  }

  // 6. Screenshots: Schema, API and Stack at desktop and phone widths, light and dark.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      for (const name of ['Schema', 'API', 'Stack']) {
        await tab(page, name).click();
        await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
        if (name === 'Schema') await expect(ordersNode(page)).toBeVisible();
        if (name === 'API') {
          await expect(page.locator('.ap-route').first()).toBeVisible();
          // The hint sits in the head and never overlaps a route row.
          const hint = (await page.locator('.ap-hint').boundingBox())!;
          for (const b of await page.locator('.ap-route').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()))) {
            expect(hint.y + hint.height <= b.y || b.y + b.height <= hint.y || hint.x + hint.width <= b.x || b.x + b.width <= hint.x).toBe(true);
          }
        }
        if (name === 'Stack') await expect(stack).toBeVisible();
        await page.screenshot({ path: `test-results/domain-${name.toLowerCase()}-${width}-${scheme}.png`, animations: 'disabled' });
      }
    }
  }
});
