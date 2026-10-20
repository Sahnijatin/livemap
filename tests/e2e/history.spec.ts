import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { projectDir } from '../../src/history/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const CLI = path.join(repo, 'dist/cli.js');
// Screenshots go to test-results/history unless LIVEMAP_SHOTS names another folder.
const SHOTS = process.env.LIVEMAP_SHOTS ?? path.join(repo, 'test-results/history');
const SESSION = 'e2e-history-session';

// The fullstack fixture. Edit 1 and 2 change existing files, edit 3 creates one, edit 4 lands while rewound.
const SERVICE = 'apps/api/src/services/orderService.ts';
const DB = 'apps/api/src/db.ts';
const CREATED = 'apps/api/src/services/refundService.ts';
const ROUTES = 'apps/api/src/routes/orders.ts';
const CHANGE_TEXT = 'Adds a helper that refunds every open order.';
const FILE_TEXT = 'Reads, creates, deletes and refunds orders through Prisma.';
// The fixture's .env value is too short to search for: the temp copy gets recognizable ones (never committed).
const SECRET_1 = `e2e-history-secret-${crypto.randomBytes(8).toString('hex')}`;
const SECRET_2 = `e2e-history-secret-${crypto.randomBytes(8).toString('hex')}`;

let tmp: string;
let home: string;
let claudeDir: string;
let transcript: string;
let env: NodeJS.ProcessEnv;
let proc: ChildProcess | undefined;
let fake: http.Server | undefined;
/** Request bodies the fake summary provider received, as sent. */
const bodies: string[] = [];

function startCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, tmp, '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function stopCli(): Promise<void> {
  const p = proc;
  proc = undefined;
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = new Promise<void>(r => p.once('exit', () => r()));
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killer);
}

/** Runs the UserPromptSubmit hook `livemap init` configured, as Claude Code would, after the prompt reaches the transcript. */
let promptNo = 0;
function prompt(text: string): void {
  promptNo++;
  const line = { type: 'user', uuid: `e2e-hist-u${promptNo}`, timestamp: new Date().toISOString(), sessionId: SESSION, cwd: tmp, isSidechain: false, message: { role: 'user', content: text } };
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`);
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.claude/settings.local.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const command = cfg.hooks.UserPromptSubmit.flatMap(g => g.hooks.map(h => h.command)).find(c => c.includes('livemap-hook.mjs'))!;
  const payload = { session_id: SESSION, transcript_path: transcript, cwd: tmp, hook_event_name: 'UserPromptSubmit', prompt: text };
  const r = spawnSync(command, { shell: true, cwd: tmp, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 10_000 });
  expect(r.status).toBe(0);
}

interface Rec { seq: number; at: number; run: string; msg: { type: string; change?: { path: string; kind: string } } }

/** Every recorded event on disk, oldest first. */
function records(): Rec[] {
  const dir = projectDir(tmp, home);
  const out: Rec[] = [];
  for (const f of fs.readdirSync(dir).filter(n => /^events-.*\.jsonl$/.test(n))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Rec); } catch { /* a line being written */ }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The seq of the newest recorded change to `p` (waits for the buffered write to reach disk). */
async function changeSeq(p: string): Promise<number> {
  let seq = 0;
  await expect.poll(() => {
    seq = records().filter(r => r.msg.type === 'change' && r.msg.change?.path === p).at(-1)?.seq ?? 0;
    return seq;
  }, { timeout: 5000 }).toBeGreaterThan(0);
  return seq;
}

/** `/api/history/info` from the running CLI (the token from its URL). */
async function historyInfo(url: string): Promise<{ first: number; last: number }> {
  const u = new URL(url);
  const res = await fetch(`${u.origin}/api/history/info?t=${u.searchParams.get('t')}`);
  return (await res.json()) as { first: number; last: number };
}

/** Waits until recording is quiet (the newest seq unchanged over three reads 200 ms apart). */
async function settle(url: string): Promise<void> {
  let prev = -1;
  let same = 0;
  for (let i = 0; i < 50 && same < 3; i++) {
    const { last } = await historyInfo(url);
    same = last === prev ? same + 1 : 0;
    prev = last;
    await new Promise(r => setTimeout(r, 200));
  }
}

const edit = (p: string, fn: (s: string) => string) => fs.writeFileSync(path.join(tmp, p), fn(fs.readFileSync(path.join(tmp, p), 'utf8')));

const feed = (page: Page) => page.getByRole('main', { name: 'Activity' });
const card = (page: Page, p: string) => feed(page).locator('.f-chg').filter({ has: page.locator('.p', { hasText: new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const timeline = (page: Page) => page.getByRole('group', { name: 'Session timeline' });
const slider = (page: Page) => timeline(page).getByRole('slider', { name: 'Time' });
const track = (page: Page) => timeline(page).locator('.track');
const tlState = (page: Page) => timeline(page).locator('.tl-state');
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const tree = (page: Page) => page.getByRole('tree', { name: 'Files' });
const fileRow = (page: Page, p: string) => tree(page).locator(`[data-file="${p}"]`);
const tab = (page: Page, t: string) => page.locator(`[role=tab][data-tab="${t}"]`);
const banner = (page: Page) => page.locator('.rw-banner');
const num = async (page: Page, attr: string) => Number(await slider(page).getAttribute(attr));

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('.statuschip')).toContainText('Live', { timeout: 15_000 });
  await expect(tlState(page)).toHaveText('LIVE');
}

/**
 * Drags the thumb from live to the middle of [lo, hi] in one gesture (the track is linear in seq over the
 * ticks range, which a fresh load fetches up to the newest seq) and returns the seq it rewound to.
 */
async function dragInto(page: Page, lo: number, hi: number): Promise<number> {
  const [min, max] = [await num(page, 'aria-valuemin'), await num(page, 'aria-valuemax')];
  const box = (await track(page).boundingBox())!;
  const thumb = (await slider(page).boundingBox())!;
  const y = thumb.y + thumb.height / 2;
  const x = box.x + (((lo + hi) / 2 - min) / Math.max(1, max - min)) * box.width;
  await page.mouse.move(thumb.x + thumb.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
  await expect(tlState(page)).toHaveText('REWOUND');
  await expect(banner(page)).toBeVisible();
  // The track kept its size while the side switched from LIVE to REWOUND.
  expect(await track(page).boundingBox()).toEqual(box);
  return num(page, 'aria-valuenow');
}

/** Keyboard scrubbing: Home, then ArrowRight one bucket at a time until the slider reaches `seq` or later. */
async function stepTo(page: Page, seq: number): Promise<number> {
  await slider(page).focus();
  await page.keyboard.press('Home');
  await expect(slider(page)).toHaveAttribute('aria-valuenow', String(await num(page, 'aria-valuemin')));
  for (let i = 0; i < 1000; i++) {
    const now = await num(page, 'aria-valuenow');
    if (now >= seq) return now;
    await page.keyboard.press('ArrowRight');
  }
  throw new Error(`the slider never reached ${seq}`);
}

/**
 * Screenshots of the current state at 1440 and 390, light and dark; ends at 1440 dark. `prepare` runs
 * before each shot; `phone` runs before each 390 shot and returns its undo; `measure` runs after each shot.
 */
async function shots(page: Page, name: string, opts: { prepare?: () => Promise<void>; phone?: () => Promise<() => Promise<void>>; measure?: (key: string) => Promise<void> } = {}): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 640 ? 900 : 844 });
      await page.emulateMedia({ colorScheme: scheme });
      await opts.prepare?.();
      const undo = width < 640 ? await opts.phone?.() : undefined;
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${width}-${scheme}.png`) });
      await opts.measure?.(`${width}-${scheme}`);
      await undo?.();
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
}

/** On a phone the inspector is a slide-over: opens it for a shot; the undo closes it. */
const openInspector = (page: Page) => async () => {
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(page.locator('aside.insp')).toHaveClass(/\bopen\b/);
  return async () => {
    await page.keyboard.press('Escape');
    await expect(page.locator('aside.insp')).not.toHaveClass(/\bopen\b/);
  };
};

test.beforeAll(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-history-e2e-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-history-home-')));
  claudeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-history-claude-')));
  env = {
    ...process.env,
    LIVEMAP_HOME: home,
    CLAUDE_CONFIG_DIR: claudeDir,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  fs.cpSync(path.join(repo, 'tests/fixtures/fullstack'), tmp, { recursive: true });
  fs.appendFileSync(path.join(tmp, '.env'), `\nLIVEMAP_E2E_SECRET=${SECRET_1}\n`);
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.execPath, [CLI, 'init', tmp, '--agents', 'claude'], { env, stdio: 'pipe' });
  transcript = path.join(claudeDir, 'projects', tmp.replace(/[^a-zA-Z0-9]/g, '-'), 'history.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
});

test.afterAll(async () => {
  await stopCli();
  await new Promise<void>(r => (fake ? fake.close(() => r()) : r()));
  for (const d of [tmp, home, claudeDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

test.use({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });

test('history: timeline, rewind, read-only past, play, restarts, summaries and export', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  let url = await startCli();
  await open(page, url);

  const seqs: Record<string, number> = {};
  const trackBoxes: Record<string, { x: number; y: number; width: number; height: number }> = {};

  await test.step('1. three edits with an agent prompt between them', async () => {
    prompt('Add a refund helper');
    await expect(feed(page).locator('.f-prompt').filter({ hasText: 'Add a refund helper' })).toBeVisible({ timeout: 5000 });
    edit(SERVICE, s => `${s}\nexport async function refundOrder(id: string) {\n  return prisma.order.update({ where: { id }, data: { status: 'refunded' } });\n}\n`);
    await expect(card(page, SERVICE)).toBeVisible({ timeout: 5000 });
    seqs.edit1 = await changeSeq(SERVICE);

    // Real-time gaps between the edits: at 8x, Play then shows each change at least 150 ms after the
    // previous one, so step 5 sees every card appear in its own render.
    await page.waitForTimeout(1200);
    prompt('Log every database call');
    await expect(feed(page).locator('.f-prompt').filter({ hasText: 'Log every database call' })).toBeVisible({ timeout: 5000 });
    edit(DB, s => `${s}\nexport function auditLog(op: string) {\n  console.log(op);\n}\n`);
    await expect(card(page, DB)).toBeVisible({ timeout: 5000 });
    seqs.edit2 = await changeSeq(DB);

    await page.waitForTimeout(1200);
    prompt('Move refunds into their own service');
    await expect(feed(page).locator('.f-prompt').filter({ hasText: 'Move refunds into their own service' })).toBeVisible({ timeout: 5000 });
    fs.writeFileSync(path.join(tmp, CREATED), "import { prisma } from '../db';\n\nexport async function refundAll() {\n  return prisma.order.updateMany({ data: { status: 'refunded' } });\n}\n");
    await expect(card(page, CREATED)).toBeVisible({ timeout: 5000 });
    seqs.edit3 = await changeSeq(CREATED);
    expect(seqs.edit1).toBeLessThan(seqs.edit2);
    expect(seqs.edit2).toBeLessThan(seqs.edit3);
    // Edit 2's prompt sits between edit 1 and edit 2.
    expect(seqs.edit2 - seqs.edit1).toBeGreaterThan(1);
  });

  await test.step('2. the timeline shows ticks and is LIVE', async () => {
    // A fresh load, once recording is quiet, fetches ticks for the whole range at once.
    await settle(url);
    await open(page, url);
    await expect(timeline(page).locator('.tl-ticks .tick').first()).toBeVisible({ timeout: 5000 });
    expect(await timeline(page).locator('.tl-ticks .tick[data-kind="change"]').count()).toBeGreaterThan(0);
    expect(await timeline(page).locator('.tl-ticks .tick[data-kind="prompt"]').count()).toBeGreaterThan(0);
    await expect(tlState(page)).toHaveText('LIVE');
    await expect(slider(page)).toHaveAttribute('aria-valuenow', String(await num(page, 'aria-valuemax')));
    await expect(page.getByRole('button', { name: 'Back to live' })).toHaveCount(0);
    await shots(page, 'timeline-live', { measure: async k => { trackBoxes[`live-${k}`] = (await track(page).boundingBox())!; } });
  });

  await test.step('3. drag before edit 2: the feed, Map, banner and Flag box show the past', async () => {
    // One drag aimed at the middle of the gap lands there (within a seq), and the track keeps its size.
    const at = await dragInto(page, seqs.edit1, seqs.edit2 - 1);
    expect(Math.abs(at - Math.round((seqs.edit1 + seqs.edit2 - 1) / 2))).toBeLessThanOrEqual(1);
    expect(at).toBeGreaterThanOrEqual(seqs.edit1);
    expect(at).toBeLessThan(seqs.edit2);
    await expect(card(page, SERVICE)).toBeVisible();
    await expect(card(page, DB)).toHaveCount(0);
    await expect(card(page, CREATED)).toHaveCount(0);
    await expect(banner(page).locator('> span')).toHaveText(/^Viewing \S.*\. Changes made since then are hidden\.$/);

    // The Flag box is read-only.
    await fileRow(page, SERVICE).click();
    await expect(inspector(page).getByRole('textbox', { name: 'Flag note for this file' })).toBeDisabled();
    await expect(inspector(page).locator('.flagbox').first()).toHaveAttribute('title', 'Back to live to make changes');

    await tab(page, 'map').click();
    await page.locator(`.node[data-path="${SERVICE}"]`).waitFor({ timeout: 10_000 });
    await expect(page.locator(`.node[data-path="${CREATED}"]`)).toHaveCount(0);
    await expect(banner(page)).toBeVisible();
    await shots(page, 'timeline-rewound', { measure: async k => { trackBoxes[`rewound-${k}`] = (await track(page).boundingBox())!; } });
    // At every size and theme the track is where it was at live.
    for (const k of ['1440-light', '390-light', '1440-dark', '390-dark']) expect(trackBoxes[`rewound-${k}`], k).toEqual(trackBoxes[`live-${k}`]);
    await tab(page, 'activity').click();
  });

  await test.step('4. an edit made while rewound leaves the past alone until Back to live', async () => {
    const before = await num(page, 'aria-valuenow');
    edit(ROUTES, s => `${s}\nexport function refundRoute() {\n  return 'refund';\n}\n`);
    seqs.edit4 = await changeSeq(ROUTES);
    // The server recorded it, and this client has its newer history status: the change came before it.
    await expect.poll(async () => (await historyInfo(url)).last).toBeGreaterThanOrEqual(seqs.edit4);
    await expect.poll(() => num(page, 'aria-valuemax')).toBeGreaterThanOrEqual(seqs.edit4);
    await expect(tlState(page)).toHaveText('REWOUND');
    await expect(slider(page)).toHaveAttribute('aria-valuenow', String(before));
    await expect(card(page, ROUTES)).toHaveCount(0);
    await expect(card(page, DB)).toHaveCount(0);
    await expect(banner(page)).toBeVisible();

    await banner(page).getByRole('button', { name: 'Back to live' }).click();
    await expect(tlState(page)).toHaveText('LIVE');
    await expect(banner(page)).toHaveCount(0);
    for (const p of [SERVICE, DB, CREATED, ROUTES]) await expect(card(page, p)).toBeVisible();
    await expect(inspector(page).getByRole('textbox', { name: 'Flag note for this file' })).toBeEnabled();
  });

  await test.step('5. Play from the start: cards come back in order and play stops at live', async () => {
    // Record each card's (re)appearance in the feed, in order.
    await feed(page).evaluate(el => {
      const w = window as unknown as { __seen: string[]; __live: number };
      w.__seen = [];
      let present = new Set<string>();
      const scan = () => {
        const now = new Set([...el.querySelectorAll('.f-chg .p')].map(p => p.textContent ?? ''));
        for (const p of now) if (!present.has(p)) w.__seen.push(p);
        present = now;
      };
      scan();
      w.__live = w.__seen.length;
      new MutationObserver(scan).observe(el, { childList: true, subtree: true, characterData: true });
    });
    await timeline(page).getByRole('button', { name: 'Play history' }).click();
    await expect(tlState(page)).toHaveText('REWOUND');
    await expect(timeline(page).getByRole('button', { name: 'Pause playback' })).toBeVisible();
    await expect(tlState(page)).toHaveText('LIVE', { timeout: 30_000 });
    await expect(timeline(page).getByRole('button', { name: 'Play history' })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    const { seen, live } = await page.evaluate(() => {
      const w = window as unknown as { __seen: string[]; __live: number };
      return { seen: w.__seen, live: w.__live };
    });
    // The live cards first, then each again as playback reaches it.
    expect(live).toBe(4);
    const replayed = seen.slice(live);
    expect(replayed).toEqual([SERVICE, DB, CREATED, ROUTES]);
  });

  await test.step('6. a restart: run separator, old symbols in the old run, new ones from the new run', async () => {
    await stopCli();
    edit(SERVICE, s => s.replace('refundOrder', 'issueRefund'));
    url = await startCli();
    await open(page, url);
    // Something happens in the new run.
    edit(ROUTES, s => `${s}\nexport function listRefunds() {\n  return [];\n}\n`);
    await expect(card(page, ROUTES)).toBeVisible({ timeout: 5000 });
    const recs = await expect.poll(() => new Set(records().map(r => r.run)).size).toBe(2).then(() => records());
    const newRun = recs.at(-1)!.run;
    const runStart = recs.find(r => r.run === newRun)!.seq;
    await settle(url);
    await open(page, url);
    await expect(timeline(page).locator('.tl-run')).toHaveCount(1, { timeout: 5000 });
    expect(runStart).toBeGreaterThan(seqs.edit4);

    const expand = async () => {
      const row = fileRow(page, SERVICE);
      await row.waitFor();
      if ((await row.getAttribute('aria-expanded')) !== 'true') await row.locator('.chev').click();
    };
    // The keyboard steps one bucket at a time: deterministic, no pixel aiming.
    const old = await stepTo(page, seqs.edit3);
    expect(old).toBeLessThan(runStart);
    await expand();
    await expect(tree(page).getByRole('treeitem', { name: /refundOrder/ })).toBeVisible();
    await expect(tree(page).getByRole('treeitem', { name: /issueRefund/ })).toHaveCount(0);

    // The first bucket at or after the new run's first seq.
    const start = await stepTo(page, runStart);
    expect(start - runStart).toBeLessThanOrEqual(2);
    await expand();
    await expect(tree(page).getByRole('treeitem', { name: /issueRefund/ })).toBeVisible();
    await expect(tree(page).getByRole('treeitem', { name: /refundOrder/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to live' }).first().click();
    await expect(tlState(page)).toHaveText('LIVE');
  });

  await test.step('7. summaries from a configured provider; no secret file contents sent', async () => {
    fake = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', d => { body += d; });
      req.on('end', () => {
        bodies.push(body);
        if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return; }
        const j = JSON.parse(body) as { system: string };
        const text = j.system.startsWith('You describe a code change') ? CHANGE_TEXT : FILE_TEXT;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 } }));
      });
    });
    await new Promise<void>(r => fake!.listen(0, '127.0.0.1', () => r()));
    const port = (fake.address() as { port: number }).port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ summaries: { enabled: true, provider: 'anthropic', apiKey: 'test', url: `http://127.0.0.1:${port}` } }));

    await stopCli();
    url = await startCli();
    await open(page, url);

    // A secret file changes and is opened: neither reaches the provider.
    fs.appendFileSync(path.join(tmp, '.env'), `SECOND_SECRET=${SECRET_2}\n`);
    await expect(card(page, '.env')).toBeVisible({ timeout: 5000 });
    await fileRow(page, '.env').click();
    await expect(inspector(page).getByRole('heading', { name: '.env' })).toBeVisible();

    edit(SERVICE, s => `${s}\nexport async function refundAllOrders() {\n  return prisma.order.updateMany({ data: { status: 'refunded' } });\n}\n`);
    await expect(card(page, SERVICE).locator('.lead')).toHaveText(CHANGE_TEXT, { timeout: 10_000 });
    // Summaries are running, yet the secret file's card has none.
    await expect(card(page, '.env').locator('.lead')).toHaveCount(0);

    await card(page, SERVICE).locator('.ch').click();
    // The live pane only. For 180 ms after a selection the previous pane (.env here) stays on screen, inert and
    // aria-hidden, and it can hold its own "In plain English" block with the agent's words. A strict locator that
    // matches both fails at once instead of retrying.
    const ai = inspector(page).locator('.ins-scroll:not([aria-hidden]) .ai');
    await expect(ai).toContainText('In plain English');
    await expect(ai.locator('p')).toHaveText(FILE_TEXT, { timeout: 10_000 });
    await shots(page, 'summaries-inspector', { phone: openInspector(page) });

    await tab(page, 'stack').click();
    const box = page.locator('.b-ai');
    await expect(box.getByRole('heading', { name: 'AI summaries' })).toBeVisible();
    await expect(box.locator('.ai-prov')).toHaveText('Anthropic');
    await expect(box.locator('code')).toHaveText('claude-haiku-5-5');
    await expect(box.locator('.ai-use')).toHaveText(/^[1-9][\d,]* of 2,000,000 tokens this month$/);
    await box.scrollIntoViewIfNeeded();
    await shots(page, 'summaries-stack', { prepare: () => box.scrollIntoViewIfNeeded() });
    await tab(page, 'activity').click();

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const dotenv = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(dotenv.includes(SECRET_1) && dotenv.includes(SECRET_2)).toBe(true);
    const leaked = bodies.filter(b => b.includes(SECRET_1) || b.includes(SECRET_2) || b.includes('Path: .env'));
    // Count only: never print secret values.
    expect(leaked.length, 'summary requests carrying secret file contents').toBe(0);
  });

  await test.step('8. export: one offline file with the warning', async () => {
    const out = path.join(home, 'replay.html');
    const r = spawnSync(process.execPath, [CLI, 'export', tmp, '--out', out], { env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/This export contains source code for \d+ files\. Share it only with people who may see this code\./);
    const html = fs.readFileSync(out, 'utf8');
    expect(html.includes(SECRET_1) || html.includes(SECRET_2), 'export carries a secret value').toBe(false);

    const replay = await page.context().newPage();
    const offending: string[] = [];
    replay.on('request', q => { if (!/^(file|data|blob):/.test(q.url())) offending.push(q.url()); });
    await replay.route(/^(https?|wss?):/, rt => rt.abort());
    await replay.setViewportSize({ width: 1440, height: 900 });
    await replay.goto(pathToFileURL(out).href);
    await expect(timeline(replay).locator('.tl-state')).toHaveText('REWOUND');
    await expect(replay.locator('.statuschip')).toHaveText('Replay');
    await expect(card(replay, SERVICE).first()).toBeVisible();
    await expect(timeline(replay).locator('.tl-run')).toHaveCount(2);
    await shots(replay, 'export');
    expect(offending).toEqual([]);
    await replay.close();
  });

  expect(errors).toEqual([]);
});
