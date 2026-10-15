import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const CLI = path.join(root, 'dist/cli.js');
const TABS = ['activity', 'map', 'schema', 'api', 'stack'] as const;

let tmp: string;
let home: string;
let claudeDir: string;
let env: NodeJS.ProcessEnv;
let proc: ChildProcess;
let url: string;

function startCli(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, dir, '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-e2e-resp-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-resp-home-')));
  claudeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-resp-claude-')));
  // `node` in hook commands must resolve to this Node.
  env = { ...process.env, LIVEMAP_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  fs.cpSync(path.join(root, 'tests/fixtures/shop'), tmp, { recursive: true });
  execFileSync(process.execPath, [CLI, 'init', tmp, '--agents', 'claude'], { env, stdio: 'pipe' });
  url = await startCli(tmp);
});

test.afterAll(async () => {
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>(r => proc.once('exit', () => r()));
    proc.kill('SIGTERM');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }
  for (const d of [tmp, home, claudeDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

/** Runs the Claude hook command `livemap init` configured for an event, with the payload on stdin. */
function runHook(event: string, payload: object): Promise<number | null> {
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.local.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const command = cfg.hooks[event].flatMap(g => g.hooks.map(h => h.command)).find(c => c.includes('livemap-hook.mjs'))!;
  return new Promise((resolve, reject) => {
    const p = spawn(command, { shell: true, cwd: tmp, env, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`hook ${event} did not exit`)); }, 10_000);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); resolve(code); });
    p.stdin!.end(JSON.stringify(payload));
  });
}

async function open(page: Page) {
  await page.goto(url);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 15_000 });
}

const tab = (page: Page, t: string) => page.locator(`[role=tab][data-tab="${t}"]`);

async function showTab(page: Page, t: string) {
  await tab(page, t).click();
  await expect(tab(page, t)).toHaveAttribute('aria-selected', 'true');
  // Lazy views (Map, Schema, API) load and lay out; the tab switch animation ends.
  if (t === 'map') await page.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(t === 'map' || t === 'schema' ? 900 : 400);
}

const pageScroll = (page: Page) => page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth }));

/**
 * The page cannot scroll sideways (body is overflow:hidden and .app fixed), so also look inside: nothing in the
 * toolbar, center pane, Map menu or palette reaches past the viewport's right edge, and no scroller in them
 * (each view's scroll box, the open menu, the palette list) is wider than its box. Map and Schema canvases pan
 * by design, so their React Flow content is skipped.
 */
const clipped = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  const name = (e: Element) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className)}`;
  for (const e of document.querySelectorAll('.toolbar, .toolbar *, .center, .center *, .mt-menu, .mt-menu *, .palette, .palette *')) {
    if (e.closest('.react-flow__viewport, .react-flow__renderer, [inert], [hidden]')) continue;
    const b = e.getBoundingClientRect();
    if (!(b.width > 0 && getComputedStyle(e).visibility !== 'hidden' && b.right > window.innerWidth + 0.5)) continue;
    // Content clipped by an on-screen ancestor (a progress sheen, an ellipsized row) is not visible past the edge.
    // The walk stops at the shell: body is overflow:hidden at exactly the viewport width, so counting it (or
    // anything above the toolbar, center, menu and palette) would excuse everything.
    let clip = false;
    for (let p = e.parentElement; p && !clip && !p.matches('.app, body, html'); p = p.parentElement) {
      clip = getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= window.innerWidth + 0.5;
    }
    if (!clip) out.push(`past edge: ${name(e)} right=${Math.round(b.right)}`);
  }
  for (const e of document.querySelectorAll('.center, .center *, .mt-menu, .palette, .palette *')) {
    if (e.closest('.react-flow, [inert], [hidden]') || e.closest('pre')) continue;
    const ox = getComputedStyle(e).overflowX;
    if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + 1) out.push(`scrolls sideways: ${name(e)} ${e.scrollWidth}>${e.clientWidth}`);
  }
  return out;
});

for (const width of [360, 390, 768, 1180, 1440]) {
  test(`no horizontal page scroll at ${width} px in any tab`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    for (const t of TABS) {
      await showTab(page, t);
      const s = await pageScroll(page);
      expect(s.scrollWidth, `${t} at ${width}`).toBeLessThanOrEqual(s.innerWidth);
      expect(await clipped(page), `${t} at ${width}`).toEqual([]);
    }
    // With the Map options menu open, and with the palette open.
    await showTab(page, 'map');
    await page.getByRole('button', { name: 'Map options' }).click();
    await expect(page.getByRole('menu', { name: 'Map options' })).toBeVisible();
    expect((await pageScroll(page)).scrollWidth).toBeLessThanOrEqual(width);
    expect(await clipped(page), `menu at ${width}`).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search everything' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.type('order');
    await expect(page.locator('.pit').first()).toBeVisible();
    expect((await pageScroll(page)).scrollWidth).toBeLessThanOrEqual(width);
    expect(await clipped(page), `palette at ${width}`).toEqual([]);
  });
}

test('at 900 px the Files and Inspector buttons open and close their slide-overs; Esc closes them', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await open(page);
  const files = page.getByRole('button', { name: 'Files', exact: true });
  const insp = page.getByRole('button', { name: 'Inspector', exact: true });
  const sidebar = page.locator('aside.sidebar');
  const inspector = page.locator('aside.insp');
  const scrim = page.locator('.scrim.open');

  await expect(files).toBeVisible();
  await expect(insp).toBeVisible();
  await expect(sidebar).not.toBeInViewport();

  await files.click();
  await expect(sidebar).toHaveClass(/\bopen\b/);
  await expect(sidebar).toBeInViewport();
  await expect(scrim).toHaveCount(1);
  await files.click();
  await expect(sidebar).not.toHaveClass(/\bopen\b/);
  await expect(scrim).toHaveCount(0);

  await insp.click();
  await expect(inspector).toHaveClass(/\bopen\b/);
  await expect(scrim).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(inspector).not.toHaveClass(/\bopen\b/);
  await expect(scrim).toHaveCount(0);
  await expect(insp).toBeFocused();

  await files.click();
  await expect(sidebar).toHaveClass(/\bopen\b/);
  await page.keyboard.press('Escape');
  await expect(sidebar).not.toHaveClass(/\bopen\b/);

  // A scrim click closes; selecting a file closes the sidebar (the inspector stays closed above phone width).
  await files.click();
  await page.mouse.click(880, 500);
  await expect(sidebar).not.toHaveClass(/\bopen\b/);
  await files.click();
  await sidebar.locator('[data-file="server/services/orderService.ts"]').click();
  await expect(sidebar).not.toHaveClass(/\bopen\b/);
  await expect(inspector).not.toHaveClass(/\bopen\b/);
  await expect(scrim).toHaveCount(0);
});

test('on a phone, selecting a file in the sidebar opens the inspector', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  // Opening the slide-over moves focus into it; a keyboard pick hands focus on to the inspector, never to <body>.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside.sidebar'))).toBe(true);
  const row = page.locator('aside.sidebar [data-file="server/services/orderService.ts"]');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('aside.sidebar')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('aside.insp')).toHaveClass(/\bopen\b/);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside.insp'))).toBe(true);
  await expect(page.locator('aside.insp').getByRole('heading', { name: 'orderService.ts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scrim.open')).toHaveCount(0);

  // A palette pick opens the inspector, and focus ends inside it (the closing dialog does not pull it back).
  await page.getByRole('button', { name: 'Search everything' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.type('orderService');
  await expect(page.locator('.pit').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('aside.insp')).toHaveClass(/\bopen\b/);
  await expect(page.locator('.palette')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => !!document.activeElement?.closest('aside.insp'))).toBe(true);
});

test('resizing from 900 to 1300 px with the sidebar open leaves no open scrim and docks the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await open(page);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.locator('.scrim.open')).toHaveCount(1);
  await expect(page.locator('main.center')).toHaveAttribute('inert', '');
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect(page.locator('.scrim.open')).toHaveCount(0);
  await expect(page.locator('main.center')).not.toHaveAttribute('inert', '');
  // The Files button is hidden at this width: focus stays in the now-docked sidebar, never on <body>.
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('aside.sidebar'))).toBe(true);
  await expect(page.locator('aside.sidebar')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('aside.sidebar')).toBeInViewport();
  // The page is usable: a click in the center reaches it.
  await tab(page, 'stack').click();
  await expect(tab(page, 'stack')).toHaveAttribute('aria-selected', 'true');
});

test('phone toolbar: condensed, and the Map tools live in the options menu', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page);
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toBeVisible();
  await expect(page.locator('.toolbar .mark')).toBeVisible();
  await expect(page.locator('.toolbar .brand span')).toBeHidden();
  await expect(page.locator('.projsel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Search everything' })).toBeVisible();
  await expect(page.locator('.pillbtn.search .sl')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Pause agent' })).toBeVisible();
  await showTab(page, 'map');
  await expect(page.locator('.c-tools .mini-seg')).toHaveCount(0);
  await page.getByRole('button', { name: 'Map options' }).click();
  const menu = page.getByRole('menu', { name: 'Map options' });
  await expect(menu.getByRole('menuitemradio', { name: 'Folders' })).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: /Follow/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reset layout' })).toBeVisible();
  await menu.getByRole('menuitemradio', { name: 'Folders' }).click();
  await expect(page.locator('.react-flow__node-folder').first()).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [390, 1440]) {
    test(`screenshots of every tab at ${width} px, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await open(page);
      for (const t of TABS) {
        await showTab(page, t);
        await page.screenshot({ path: `test-results/responsive-${t}-${scheme}-${width}.png` });
      }
    });
  }
}

// Runs last: it leaves a working agent session behind.
test('at 768 px with a live agent the toolbar fits: Pause is fully on screen', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await open(page);
  const SESSION = 'e2e-resp-session';
  const transcript = path.join(claudeDir, 'projects', tmp.replace(/[^a-zA-Z0-9]/g, '-'), 's1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const at = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify({ timestamp: at, sessionId: SESSION, cwd: tmp, isSidechain: false, ...o })}\n`;
  const file = path.join(tmp, 'server/services/orderService.ts');
  fs.writeFileSync(transcript,
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Add a refunds report to the admin dashboard' } }) +
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] } }));
  const base = { session_id: SESSION, transcript_path: transcript, cwd: tmp };
  expect(await runHook('UserPromptSubmit', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Add a refunds report to the admin dashboard' })).toBe(0);
  expect(await runHook('PreToolUse', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'tu1', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } })).toBe(0);
  await expect(page.locator('.agentchip').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.toolbar .now')).toBeAttached();
  const pause = page.getByRole('button', { name: 'Pause agent' });
  await expect(pause).toBeInViewport({ ratio: 1 });
  const box = (await pause.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(768);
  for (const t of TABS) {
    await showTab(page, t);
    expect(await clipped(page), `${t} at 768 with an agent`).toEqual([]);
  }
  await page.screenshot({ path: 'test-results/responsive-agent-768.png' });
});
