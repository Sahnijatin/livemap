import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// A large schema: the table list, search and focus on the canvas, at desktop and phone widths.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

let tmp: string;
let proc: ChildProcess | undefined;
let url: string;

/** 64 Prisma models: a User hub, eight families of five, and loose tables. */
function schema(): string {
  const models: string[] = [];
  const back: string[] = [];
  for (let f = 0; f < 8; f++) {
    for (let i = 0; i < 5; i++) {
      const name = `Fam${f}Item${i}`;
      const lines = ['  id String @id', '  title String', `  userId String`, `  user User @relation("${name}User", fields: [userId], references: [id])`];
      back.push(`  ${name.toLowerCase()}s ${name}[] @relation("${name}User")`);
      if (i > 0) {
        const parent = `Fam${f}Item${i - 1}`;
        lines.push('  parentId String', `  parent ${parent} @relation("${name}Parent", fields: [parentId], references: [id])`);
      }
      const child = i < 4 ? `  children Fam${f}Item${i + 1}[] @relation("Fam${f}Item${i + 1}Parent")` : '';
      models.push(`model ${name} {\n${lines.join('\n')}\n${child}\n}`);
    }
  }
  for (let i = 0; i < 23; i++) models.push(`model Loose${i} {\n  id String @id\n  ${i === 7 ? 'invoiceNumber' : 'label'} String\n}`);
  models.push(`model User {\n  id String @id\n  email String @unique\n${back.join('\n')}\n}`);
  return `datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\n${models.join('\n\n')}\n`;
}

function startCli(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, 'dist/cli.js'), dir, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc = p;
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
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-schema-e2e-')));
  fs.mkdirSync(path.join(tmp, 'prisma'));
  fs.writeFileSync(path.join(tmp, 'prisma/schema.prisma'), schema());
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

async function openSchema(page: Page) {
  await page.goto(url);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 15_000 });
  await page.locator('[role=tab][data-tab="schema"]').click();
  await expect(page.locator('.sv-list')).toBeVisible({ timeout: 10_000 });
}

const row = (page: Page, key: string) => page.locator(`.sv-row[data-table="${key}"]`);
const node = (page: Page, key: string) => page.locator(`.react-flow__node[data-id="${key}"]`);

test('desktop: the list sits beside the canvas; search and pick focus a table', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSchema(page);
  await expect(page.locator('.sv-count')).toHaveText('64 tables');
  await expect(row(page, 'user')).toHaveAttribute('aria-label', 'User, 42 columns, 40 relations');

  const search = page.getByRole('searchbox', { name: 'Search tables and columns' });
  await search.fill('invoicenum');
  await expect(page.locator('.sv-row')).toHaveCount(1);
  await expect(row(page, 'loose7').locator('.sv-hit')).toHaveText('invoiceNumber');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.locator('.sv-row')).toHaveCount(64);

  await row(page, 'fam3item2').click();
  await expect(node(page, 'fam3item2')).toHaveClass(/\bfocus\b/);
  await expect(node(page, 'fam3item1')).toHaveClass(/\bhl\b/);
  await expect(node(page, 'loose0')).toHaveClass(/\bdim\b/);
  // In view, right of the list.
  await expect.poll(async () => {
    const [b, l, c] = await Promise.all([node(page, 'fam3item2').boundingBox(), page.locator('.sv-list').boundingBox(), page.locator('.sv-canvas').boundingBox()]);
    return !!b && !!l && !!c && b.x > l.x + l.width && b.x + b.width < c.x + c.width && b.y > c.y && b.y + b.height < c.y + c.height;
  }, { timeout: 3000 }).toBe(true);
  // Links inside the families always show.
  await expect(page.locator('.react-flow__edge')).not.toHaveCount(0);
  await search.press('Escape');
  await expect(node(page, 'fam3item2')).not.toHaveClass(/\bfocus\b/);
  await expect(node(page, 'loose0')).not.toHaveClass(/\bdim\b/);
});

test('phone: the list is the main view; a pick shows the table on the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSchema(page);
  await expect(page.locator('.sv-list')).toHaveClass(/\bover\b/);
  await row(page, 'fam5item0').click();
  await expect(page.locator('.sv-list')).toHaveCount(0);
  await expect(node(page, 'fam5item0')).toHaveClass(/\bfocus\b/);
  await expect(node(page, 'fam5item0')).toBeInViewport();
  await page.getByRole('button', { name: 'Tables', exact: true }).click();
  await expect(row(page, 'fam5item0')).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: 'Diagram' }).click();
  await expect(page.locator('.sv-list')).toHaveCount(0);
});

test('phone: a pick framed while the pane is still settling is framed again at its final size', async ({ page }) => {
  // A tall page that shrinks right after the pick, as the pane does when the page is still settling.
  await page.setViewportSize({ width: 390, height: 2400 });
  await openSchema(page);
  await expect(page.locator('.sv-list')).toHaveClass(/\bover\b/);
  await row(page, 'fam5item0').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(node(page, 'fam5item0')).toHaveClass(/\bfocus\b/);
  await expect(node(page, 'fam5item0')).toBeInViewport();
});
