import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const CLI = path.join(root, 'dist/cli.js');
const SERVICE = 'apps/api/src/services/orderService.ts';
const PAGE_FILE = 'apps/web/app/page.tsx';
const SESSION = 'e2e-map-session';
/** Set LIVEMAP_PERF_STRICT=1 to assert the 60 fps budget (median 16.7 ms, p95 25 ms) on real hardware. */
const STRICT = process.env.LIVEMAP_PERF_STRICT === '1';

const procs: ChildProcess[] = [];
const dirs: string[] = [];
let env: NodeJS.ProcessEnv;
let tmp: string;
let claudeDir: string;
let url: string;

const tempDir = (prefix: string): string => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

function startCli(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, dir, '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p); // registered up front so afterAll can always kill it
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

/** `files` small TypeScript files spread over `folders` folders, each importing the previous file in its folder. */
function generate(dir: string, folders: number, files: number): void {
  for (let i = 0; i < files; i++) {
    const d = i % folders, n = Math.floor(i / folders);
    const folder = path.join(dir, 'pkg', `mod${d}`);
    fs.mkdirSync(folder, { recursive: true });
    const prev = n > 0 ? `import { v${n - 1} } from './mod${d}_file${n - 1}';\n` : '';
    fs.writeFileSync(path.join(folder, `mod${d}_file${n}.ts`), `${prev}export const v${n} = ${i};\nexport function f${n}() { return v${n}; }\n`);
  }
}

test.beforeAll(async () => {
  tmp = tempDir('livemap-map-e2e-');
  const home = tempDir('livemap-map-home-');
  claudeDir = tempDir('livemap-map-claude-');
  // `node` in hook commands must resolve to this Node.
  env = { ...process.env, LIVEMAP_HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
  fs.cpSync(path.join(root, 'tests/fixtures/fullstack'), tmp, { recursive: true });
  execFileSync(process.execPath, [CLI, 'init', tmp, '--agents', 'claude'], { env, stdio: 'pipe' });
  url = await startCli(tmp);
});

test.afterAll(async () => {
  await Promise.all(procs.map(async p => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    const exited = new Promise<void>(r => p.once('exit', () => r()));
    p.kill('SIGTERM');
    const killer = setTimeout(() => p.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const tab = (page: Page, t: string) => page.locator(`[role=tab][data-tab="${t}"]`);
const node = (page: Page, p: string) => page.locator(`.node[data-path="${p}"]`);
const canvas = (page: Page) => page.locator('.mv-canvas');

async function open(page: Page, at: string) {
  await page.goto(at);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 15_000 });
}

async function showMap(page: Page) {
  await tab(page, 'map').click();
  await expect(tab(page, 'map')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.react-flow__node').first().waitFor({ timeout: 10_000 });
}

/** Picks a detail level from the head (wide) or from the options menu (phone, 640 px or less). */
async function setLevel(page: Page, label: 'Folders' | 'Files' | 'Functions') {
  const seg = page.locator('.mini-seg');
  if (page.viewportSize()!.width > 640) {
    await seg.getByRole('button', { name: label, exact: true }).click();
    await expect(seg.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    return;
  }
  await page.getByRole('button', { name: 'Map options' }).click();
  await page.getByRole('menuitemradio', { name: label }).click();
  await expect(page.getByRole('menu', { name: 'Map options' })).toHaveCount(0);
}

type XY = { x: number; y: number };

/** Every file card's flow position (FileNode's data-x and data-y), by path. */
const flowPositions = (page: Page): Promise<Record<string, XY>> => page.evaluate(() => {
  const out: Record<string, { x: number; y: number }> = {};
  for (const el of document.querySelectorAll<HTMLElement>('.node[data-path]')) out[el.dataset.path!] = { x: Number(el.dataset.x), y: Number(el.dataset.y) };
  return out;
});

/** Flow positions once nothing has moved for 250 ms (layout moves are springs of about 0.45 s). */
async function settledPositions(page: Page, count?: number): Promise<Record<string, XY>> {
  let prev = JSON.stringify(await flowPositions(page));
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const next = await flowPositions(page);
    const s = JSON.stringify(next);
    if (s === prev && (count === undefined || Object.keys(next).length === count)) return next;
    prev = s;
  }
  throw new Error('map never settled');
}

/** The React Flow viewport transform: screen = flow * zoom + offset (relative to the canvas). */
const viewport = (page: Page) => page.evaluate(() => {
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
});

/** A folder region's flow rect, from its React Flow node wrapper. */
const folderRect = (page: Page, id: string) => page.evaluate(fid => {
  const el = [...document.querySelectorAll<HTMLElement>('.react-flow__node')].find(n => n.dataset.id === fid)!;
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(el.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
}, id);

/** Waits for camera moves (600 ms eases) to end: two equal viewport reads 200 ms apart. */
async function settledCamera(page: Page) {
  let prev = JSON.stringify(await viewport(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(200);
    const next = JSON.stringify(await viewport(page));
    if (next === prev) return;
    prev = next;
  }
  throw new Error('camera never settled');
}

/** True when any part of `inner` shows inside `outer`. */
const intersects = async (inner: Locator, outer: Locator) => {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
};

/** A point on the canvas with nothing on it (the bare pane), scanning a grid from the bottom right. */
const emptyCanvasPoint = (page: Page) => page.evaluate(() => {
  const r = document.querySelector('.mv-canvas')!.getBoundingClientRect();
  for (let fy = 0.9; fy > 0.1; fy -= 0.05) {
    for (let fx = 0.9; fx > 0.1; fx -= 0.05) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')) return { x, y };
    }
  }
  throw new Error('no empty canvas point');
});

const inside = async (inner: Locator, outer: Locator) => {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  return !!a && !!b && a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5;
};

test.use({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });

test('map: live glow and Follow, a 40-file burst, pins, levels, palette, screenshots', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, url);
  await showMap(page);

  // 1. File cards for code files (not the README), and labeled folder regions.
  for (const p of [SERVICE, 'apps/api/src/routes/orders.ts', 'apps/api/src/db.ts', PAGE_FILE, 'services/ml/routers/predict.py']) {
    await expect(node(page, p)).toBeVisible();
  }
  await expect(node(page, 'README.md')).toHaveCount(0);
  await expect(page.locator('.mglabel[data-folder="dir:apps/api/src/services"] .mg-head')).toContainText('apps/api/src/services/');
  await expect(page.locator('.mglabel .mg-head').first()).toContainText(/\S/);

  // 2. Live glow and Follow: a Claude session edits the service through the hook path.
  const transcript = path.join(claudeDir, 'projects', tmp.replace(/[^a-zA-Z0-9]/g, '-'), 's1.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const now = new Date().toISOString();
  const line = (o: object) => `${JSON.stringify({ timestamp: now, sessionId: SESSION, cwd: tmp, isSidechain: false, ...o })}\n`;
  fs.writeFileSync(transcript,
    line({ type: 'user', uuid: 'm-u1', message: { role: 'user', content: 'Add a refund to the order service' } })
    + line({ type: 'assistant', uuid: 'm-a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'm-tu1', name: 'Edit', input: { file_path: path.join(tmp, SERVICE), old_string: 'x', new_string: 'y' } }] } }));
  const followBtn = page.getByRole('button', { name: 'Follow', exact: true });
  await expect(followBtn).toHaveAttribute('aria-pressed', 'true');
  // Start with the service out of view, so Follow has to bring it in: pan away with Follow off, then turn it back on.
  await followBtn.click();
  await expect(followBtn).toHaveAttribute('aria-pressed', 'false');
  const cb0 = (await canvas(page).boundingBox())!;
  await page.mouse.move(cb0.x + cb0.width / 2, cb0.y + cb0.height / 2);
  for (let i = 0; i < 12 && await intersects(node(page, SERVICE), canvas(page)); i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await settledCamera(page);
  expect(await intersects(node(page, SERVICE), canvas(page)), 'the service card starts out of view').toBe(false);
  await followBtn.click();
  await expect(followBtn).toHaveAttribute('aria-pressed', 'true');
  // Turning Follow on clears the pause from that pan.
  await expect(followBtn).not.toHaveAttribute('aria-describedby');
  const t0 = Date.now();
  expect(await runHook('UserPromptSubmit', { session_id: SESSION, transcript_path: transcript, cwd: tmp, hook_event_name: 'UserPromptSubmit', prompt: 'Add a refund to the order service' })).toBe(0);
  await expect(node(page, SERVICE)).toHaveClass(/\blive\b/, { timeout: 3000 });
  expect(Date.now() - t0).toBeLessThanOrEqual(3000);
  await expect.poll(() => inside(node(page, SERVICE), canvas(page)), { timeout: 3000 }).toBe(true);
  await settledCamera(page);
  expect(await inside(node(page, SERVICE), canvas(page))).toBe(true);
  // A plain click on empty canvas does not move the camera, so it does not pause Follow.
  const empty = await emptyCanvasPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(300);
  await expect(followBtn).not.toHaveAttribute('aria-describedby');
  // A drag that pans does pause it ("Paused" is the toggle's description; its name stays "Follow").
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 40, empty.y + 30, { steps: 4 });
  await page.mouse.up();
  await expect(followBtn).toHaveAttribute('aria-describedby', /.+/);
  expect(await followBtn.evaluate(b => document.getElementById(b.getAttribute('aria-describedby')!)?.textContent)).toBe('Paused');
  // The rest of this test measures and drags: keep the camera still.
  await followBtn.click();
  await expect(followBtn).toHaveAttribute('aria-pressed', 'false');

  // 3. Burst (Review Focus 1): 40 new files in two existing folders within 3 s, each importing an existing file.
  const before = await settledPositions(page);
  const edgesBefore = await page.locator('.react-flow__edge').count();
  const burst: string[] = [];
  const tb = Date.now();
  for (let i = 0; i < 20; i++) {
    const svc = `apps/api/src/services/burst${i}.ts`;
    fs.writeFileSync(path.join(tmp, svc), `import { prisma } from '../db';\n\nexport function burstService${i}() {\n  return prisma;\n}\n`);
    const rt = `apps/api/src/routes/burst${i}.ts`;
    fs.writeFileSync(path.join(tmp, rt), `import { findOrders } from '../services/orderService';\n\nexport function burstRoute${i}() {\n  return findOrders();\n}\n`);
    burst.push(svc, rt);
    await new Promise(r => setTimeout(r, 50));
  }
  expect(Date.now() - tb).toBeLessThan(3000);
  await expect(page.locator('.node[data-path*="/burst"]')).toHaveCount(40, { timeout: 5000 });
  // New links draw in the fresh gradient (it lasts 4 s).
  await expect.poll(() => page.locator('.react-flow__edge.fresh').count(), { timeout: 3000 }).toBeGreaterThanOrEqual(40);
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThanOrEqual(edgesBefore + 40);
  const after = await settledPositions(page, Object.keys(before).length + 40);
  for (const [p, b] of Object.entries(before)) {
    const a = after[p];
    expect(a, `${p} is still drawn`).toBeTruthy();
    expect(a.x, `${p} keeps its x`).toBe(b.x);
    expect(a.y, `${p} only moves down`).toBeGreaterThanOrEqual(b.y);
  }

  // 4. Pins (Review Focus 2): drag a card 120 px, edit its file, reload: it stays where it was dropped.
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await settledCamera(page);
  const card = node(page, PAGE_FILE);
  const start = (await settledPositions(page))[PAGE_FILE];
  const box = (await card.boundingBox())!;
  const { zoom } = await viewport(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // React Flow starts a drag once the pointer passes its 3 px threshold; the 120 px are counted from there.
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2);
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width / 2 + 4 + i * 10, box.y + box.height / 2);
  await page.mouse.up();
  const dropped = (await settledPositions(page))[PAGE_FILE];
  expect(Math.abs(dropped.x - (start.x + 120 / zoom))).toBeLessThanOrEqual(2);
  expect(Math.abs(dropped.y - start.y)).toBeLessThanOrEqual(2);
  fs.appendFileSync(path.join(tmp, PAGE_FILE), '\nexport const pinned = true;\n');
  await expect(card.locator('.sub')).toContainText('2 symbols', { timeout: 3000 });
  await page.waitForTimeout(400); // pins are saved 300 ms after the drop
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 15_000 });
  await showMap(page);
  const reloaded = (await settledPositions(page))[PAGE_FILE];
  expect(Math.abs(reloaded.x - dropped.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(reloaded.y - dropped.y)).toBeLessThanOrEqual(2);
  // Reset layout puts it back in its computed slot: inside its folder, where a fresh layout without pins puts it.
  await page.getByRole('button', { name: 'Map options' }).click();
  await page.getByRole('menuitem', { name: 'Reset layout' }).click();
  await expect.poll(async () => (await flowPositions(page))[PAGE_FILE].x, { timeout: 3000 }).not.toBe(reloaded.x);
  const slot = (await settledPositions(page))[PAGE_FILE];
  const region = await folderRect(page, 'dir:apps/web/app');
  expect(slot.x).toBeGreaterThanOrEqual(region.x);
  expect(slot.y).toBeGreaterThanOrEqual(region.y);
  expect(slot.x + 220).toBeLessThanOrEqual(region.x + region.w);
  expect(slot.y + 64).toBeLessThanOrEqual(region.y + region.h);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('livemap:pins:')).length)).toBe(0);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached({ timeout: 15_000 });
  await showMap(page);
  expect((await settledPositions(page))[PAGE_FILE]).toEqual(slot);

  // 5. Levels: folder cards with counts; symbol rows, with a symbol added by an edit tinted new.
  await setLevel(page, 'Folders');
  const services = page.locator('.folder[data-folder="dir:apps/api/src/services"]');
  await expect(services).toBeVisible({ timeout: 5000 });
  await expect(services.locator('.fc')).toContainText('21 files');
  await expect(page.locator('.folder')).toHaveCount(10);
  await setLevel(page, 'Functions');
  const svcCard = node(page, SERVICE);
  await expect(svcCard.locator('.nsrow', { hasText: 'findOrders' })).toBeVisible({ timeout: 5000 });
  fs.appendFileSync(path.join(tmp, SERVICE), '\nexport async function refundOrder(id: string) {\n  return id;\n}\n');
  await expect(svcCard.locator('.nsrow.new', { hasText: 'refundOrder' })).toBeVisible({ timeout: 3000 });
  await expect(svcCard.locator('.nsrow', { hasText: 'findOrders' })).not.toHaveClass(/\bnew\b/);

  // 6. ⌘K: find the service file, open it; the inspector shows it and the camera centers it.
  await setLevel(page, 'Files');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('orders');
  // Results for the query (not the Recent list shown for an empty query).
  const results = palette.locator('[cmdk-group-heading]', { hasText: /^Files$/ });
  await expect(results).toBeVisible();
  const pick = palette.locator('[cmdk-item]').filter({ has: page.locator('.pl', { hasText: /^orderService\.ts$/ }) }).first();
  await expect(pick).toBeVisible();
  for (let i = 0; i < 12 && (await pick.getAttribute('data-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await expect(pick).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'orderService.ts' })).toBeVisible();
  await settledCamera(page);
  const [nb, cb] = [(await svcCard.boundingBox())!, (await canvas(page).boundingBox())!];
  expect(Math.abs(nb.x + nb.width / 2 - (cb.x + cb.width / 2))).toBeLessThanOrEqual(4);
  expect(Math.abs(nb.y + nb.height / 2 - (cb.y + cb.height / 2))).toBeLessThanOrEqual(4);

  // 9. Screenshots: Folders, Files, Functions and the palette at 1440 and 390, light and dark.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      // The head swaps between the level control and the phone's options menu after the resize.
      await expect(page.locator('.mini-seg')).toHaveCount(width > 640 ? 1 : 0);
      for (const level of ['Folders', 'Files', 'Functions'] as const) {
        await setLevel(page, level);
        await page.locator(level === 'Folders' ? '.folder' : '.node').first().waitFor();
        await page.waitForTimeout(700);
        await page.screenshot({ path: `test-results/map-${level.toLowerCase()}-${width}-${scheme}.png`, animations: 'disabled' });
      }
      await page.keyboard.press('Control+k');
      await expect(palette).toBeVisible();
      await page.keyboard.type('orders');
      await expect(results).toBeVisible();
      await expect(pick).toBeVisible();
      await page.screenshot({ path: `test-results/map-palette-${width}-${scheme}.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(palette).toHaveCount(0);
    }
  }
});

test('map: a large project opens at folders; one folder expands; the palette reaches the rest', async ({ page }) => {
  test.setTimeout(45_000);
  const big = tempDir('livemap-map-large-');
  generate(big, 12, 600);
  const bigUrl = await startCli(big);
  await open(page, bigUrl);
  await tab(page, 'map').click();
  await expect(page.locator('.folder')).toHaveCount(12, { timeout: 15_000 });
  await expect(page.locator('.mini-seg').getByRole('button', { name: 'Folders', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Large project: showing folders. Open one to see its files.' })).toBeVisible();

  await page.locator('.folder[data-folder="dir:pkg/mod3"]').dblclick();
  await expect(page.locator('.mini-seg').getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.node[data-path]')).toHaveCount(50, { timeout: 5000 });
  const paths = await page.locator('.node[data-path]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.path!));
  expect(paths.every(p => p.startsWith('pkg/mod3/'))).toBe(true);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('mod7_file12');
  await expect(palette.locator('[cmdk-item] .pl', { hasText: /^mod7_file12\.ts$/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('map: a large project stays legible zoomed out; docs folders are Docs; notes fit each level without overlapping', async ({ page }) => {
  test.setTimeout(60_000);
  const big = tempDir('livemap-map-scale-');
  generate(big, 40, 800);
  // A skill folder full of markdown, with one script.
  const skill = path.join(big, '.agents/skills/supabase-row-level-security-policies');
  fs.mkdirSync(skill, { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(skill, `reference-${i}.md`), `# Reference ${i}\n\n## Part\n`);
  fs.writeFileSync(path.join(skill, 'validate.sh'), 'check() {\n  echo ok\n}\n');
  const bigUrl = await startCli(big);
  await open(page, bigUrl);
  await tab(page, 'map').click();
  await expect(page.locator('.folder')).toHaveCount(41, { timeout: 15_000 });

  const skillCard = page.locator('.folder[data-folder="dir:.agents/skills/supabase-row-level-security-policies"]');
  await expect(skillCard.locator('.fly')).toHaveText('Docs');
  // Cut in the middle: the end of the name shows; the full path is the title.
  await expect(skillCard.locator('.fl')).toHaveAttribute('title', '.agents/skills/supabase-row-level-security-policies');
  await expect(skillCard.locator('.fl .fn > span').last()).toHaveText('policies/');

  // No two of the notes, the hint, the zoom buttons and the Map tools overlap, at desktop and phone widths.
  const parts = ['.map-note', '.cv-hint', '.zoomctl', '.c-tools'];
  const noOverlap = async (label: string) => {
    const shown = [];
    for (const s of parts) if (await page.locator(s).isVisible()) shown.push(page.locator(s));
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) expect(await intersects(shown[i], shown[j]), `${label}: ${parts[i]} / ${parts[j]}`).toBe(false);
    }
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
    await setLevel(page, 'Folders');
    await expect(page.locator('.map-note')).toHaveText('Large project: showing folders. Open one to see its files.');
    await noOverlap(`folders ${width}`);
    await setLevel(page, 'Files');
    await expect(page.locator('.map-note')).toHaveText('Large project: open a folder to see its files.');
    await noOverlap(`files ${width}`);
    await setLevel(page, 'Functions');
    await expect(page.locator('.map-note')).toHaveText('Large project: open a folder to see its functions.');
    // The note sits in a bar below the canvas: it never covers a card.
    expect(await intersects(page.locator('.mv-foot'), canvas(page)), `bar ${width}`).toBe(false);
    expect(await inside(page.locator('.map-note'), page.locator('.mv-foot')), `note ${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setLevel(page, 'Folders');
  await settledCamera(page);

  // Zoomed far out, folders carry overview labels at a readable size on screen.
  for (let k = 0; k < 8; k++) await page.getByRole('button', { name: 'Zoom out' }).click();
  await settledCamera(page);
  expect((await viewport(page)).zoom).toBeLessThan(0.3);
  const labels = page.locator('.ovl-t');
  await expect(labels.first()).toBeVisible();
  expect(await labels.count()).toBeGreaterThanOrEqual(8);
  const h = (await labels.first().boundingBox())!.height;
  expect(h).toBeGreaterThan(24);
  expect(h).toBeLessThan(36);
  // Every label is wholly on the canvas and says more than "a…".
  for (const l of await labels.all()) {
    expect(await inside(l, canvas(page))).toBe(true);
    expect(((await l.textContent()) ?? '').length).toBeGreaterThanOrEqual(8);
  }
});

test('map: frame budget while panning 500 files at the files level', async ({ page }) => {
  test.setTimeout(45_000);
  const perf = tempDir('livemap-map-perf-');
  generate(perf, 25, 500);
  const perfUrl = await startCli(perf);
  await open(page, perfUrl);
  await tab(page, 'map').click();
  await expect(page.locator('.mini-seg').getByRole('button', { name: 'Files', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.node[data-path]').first().waitFor({ timeout: 15_000 });
  await expect(page.locator('.map-note')).toHaveCount(0);
  await settledCamera(page);
  // A fixed, dense view: from the first view (0.85, top-left cluster) four zoom-out steps of 1.2 reach
  // FIT_MIN_ZOOM (0.4), the zoom the map uses for a fitted folder; many cards are on screen while panning.
  expect((await viewport(page)).zoom).toBeCloseTo(0.85, 2);
  for (let k = 0; k < 4; k++) {
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await settledCamera(page);
  }
  expect((await viewport(page)).zoom).toBeCloseTo(0.85 / 1.2 ** 4, 2);
  await page.waitForTimeout(500);
  const rendered = await page.locator('.react-flow__node').count();
  expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes.includes('longtask')), 'long tasks are observable').toBe(true);

  // For context in the log: this machine's idle frame time (headless software rendering can be far from 60 fps).
  const idle = await page.evaluate(() => new Promise<number>(resolve => {
    const d: number[] = [];
    let last = 0;
    const tick = (t: number) => {
      if (last) d.push(t - last);
      last = t;
      if (d.length < 30) requestAnimationFrame(tick);
      else resolve(d.sort((a, b) => a - b)[15]);
    };
    requestAnimationFrame(tick);
  }));

  // Sample requestAnimationFrame deltas and long tasks for the duration of the pan.
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { deltas: number[]; long: number[]; on: boolean } };
    w.__perf = { deltas: [], long: [], on: true };
    new PerformanceObserver(list => { for (const e of list.getEntries()) if (w.__perf.on) w.__perf.long.push(e.duration); }).observe({ type: 'longtask' });
    let last = performance.now();
    const tick = (t: number) => {
      if (!w.__perf.on) return;
      w.__perf.deltas.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(t => { last = t; requestAnimationFrame(tick); });
  });

  // A 2 s scripted pan: press on empty canvas and sweep.
  const v0 = await viewport(page);
  const { x: ox, y: oy } = await emptyCanvasPoint(page);
  await page.mouse.move(ox, oy);
  await page.mouse.down();
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 2000) {
    i++;
    const t = (Date.now() - start) / 2000;
    await page.mouse.move(ox + 300 * Math.sin(t * Math.PI * 2) + 300 * t, oy + 200 * t, { steps: 2 });
  }
  await page.mouse.up();
  expect((await viewport(page)).x).not.toBe(v0.x);
  const { deltas, long } = await page.evaluate(() => {
    const w = window as unknown as { __perf: { deltas: number[]; long: number[]; on: boolean } };
    w.__perf.on = false;
    return w.__perf;
  });
  const sorted = deltas.slice(1).sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const median = pct(0.5), p95 = pct(0.95);
  const longest = long.length ? Math.max(...long) : 0;
  console.log(`map pan, 500 files (${rendered} nodes rendered, zoom ${v0.zoom.toFixed(2)}): idle median ${idle.toFixed(1)} ms; ${sorted.length} frames, ${i} pointer moves, median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, long tasks ${long.length} (longest ${longest.toFixed(0)} ms)${STRICT ? ' [strict]' : ''}`);
  // At least a quarter of the frames this machine paints in 2 s when idle.
  expect(sorted.length).toBeGreaterThanOrEqual(Math.floor((2000 / idle) / 4));
  const nodes = await page.locator('.node[data-path]').count();
  expect(nodes).toBeGreaterThan(0);
  if (STRICT) {
    expect(median).toBeLessThanOrEqual(16.7);
    expect(p95).toBeLessThanOrEqual(25);
  } else {
    expect(longest).toBeLessThanOrEqual(100);
  }
});
