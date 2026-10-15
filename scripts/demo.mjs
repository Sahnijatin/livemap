#!/usr/bin/env node
// The scripted demo: copies a sample project to a temp dir named `shop`, runs the real LiveMap CLI on it,
// drives one Claude Code session through the same hooks and transcript the e2e tests use, and exports the
// history as an offline HTML replay. With --shots it also captures the README screenshots.
//
// Usage: npm run demo [-- --shots] [-- --out <file>]   (needs `npm run build` first)
//
// The AI summaries come from a canned fake provider on 127.0.0.1, so no key is needed and every run tells
// the same story. They are sample text, not model output.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repo, 'dist/cli.js');
const FIXTURE = path.join(repo, 'tests/fixtures/fullstack');
const IMAGES = path.join(repo, 'docs/images');
const STEP_TIMEOUT = 20_000;
const SESSION = '5b0c9e1d-7a42-4f8e-9d36-2c4f1a8e6b70';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const shots = argv.includes('--shots');
const outIdx = argv.indexOf('--out');
if (outIdx !== -1 && !argv[outIdx + 1]) fail('--out needs a file path.');
const OUT = path.resolve(outIdx !== -1 ? argv[outIdx + 1] : path.join(repo, 'docs/demo/livemap-demo.html'));

if (!fs.existsSync(CLI)) {
  console.error('Run npm run build first.');
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

function fail(msg) {
  console.error(`demo: ${msg}`);
  process.exit(1);
}

const log = (msg) => console.log(`demo: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value; throws after 20 s naming the step. */
async function until(label, fn, ms = STEP_TIMEOUT) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`step timed out after ${ms / 1000} s: ${label}`);
    await sleep(100);
  }
}

/** Child processes still running, killed on a timeout, a failure or Ctrl-C. */
const children = new Set();

function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/** Rejects after 20 s naming the step, and kills `child` (when given) so nothing is left running. */
function within(label, p, child, ms = STEP_TIMEOUT) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        rej(new Error(`step timed out after ${ms / 1000} s: ${label}`));
      }, ms);
    }),
  ]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------- the sample project

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'livemap-demo-')));
const root = path.join(base, 'shop');
const home = path.join(base, 'home');
const claudeDir = path.join(base, 'claude');
const env = {
  ...process.env,
  LIVEMAP_HOME: home,
  CLAUDE_CONFIG_DIR: claudeDir,
  // `node` in the hook commands must resolve to this Node.
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
};
delete env.ANTHROPIC_API_KEY;
delete env.OPENAI_API_KEY;

function git(...args) {
  return execFileSync('git', ['-c', 'user.name=Sam Rivera', '-c', 'user.email=sam@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function prepareProject() {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.cpSync(FIXTURE, root, { recursive: true });
  // The fixture's README and .env describe the test suite; the demo gets a plain shop.
  fs.writeFileSync(path.join(root, 'README.md'), '# shop\n\nA small online shop: a Next.js storefront, an Express API backed by Prisma, SQL migrations, and a FastAPI\nservice that ranks products.\n');
  fs.writeFileSync(path.join(root, '.env.example'), '# Copy to .env and fill in.\nDATABASE_URL=postgres://localhost:5432/shop\nAPI_URL=http://localhost:4000\nMODEL_PATH=./models/ranker.bin\n');
  fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://localhost:5432/shop\nAPI_URL=http://localhost:4000\nMODEL_PATH=./models/ranker.bin\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.env\n');
  execFileSync(process.execPath, [CLI, 'init', root, '--agents', 'claude'], { env, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial shop');
}

// ---------------------------------------------------------------- canned summaries (a fake provider)

/** File summaries ("In plain English"), by path. */
const FILE_SUMMARIES = {
  'apps/api/src/services/orderService.ts': 'The order service. It lists, creates, deletes and cancels orders through Prisma, and only lets an order be canceled while it is still pending.',
  'apps/api/src/routes/orders.ts': 'Express routes for orders: list, create and cancel. Each handler calls the order service and turns its result into an HTTP response.',
  'apps/api/src/db.ts': 'Creates the single Prisma client that the rest of the API uses to reach the database.',
  'apps/api/src/index.ts': 'Starts the Express API and mounts the order routes under /api.',
  'apps/api/src/services/orderService.test.ts': 'Tests for cancelOrder: a pending order is canceled, a shipped order is refused, and an unknown order returns null.',
  'apps/web/app/orders/page.tsx': 'The storefront orders page. It loads orders from the API on every request and lists them, with canceled orders grayed out and dated.',
  'apps/web/app/orders/CancelledBadge.tsx': 'A small badge that marks an order as canceled and shows the date it happened.',
  'apps/web/app/page.tsx': 'The storefront home page, with a link to the orders page.',
  'db/migrations/003_order_cancellation.sql': 'Adds a nullable cancelledAt timestamp to the orders table, set when an order is canceled.',
  'prisma/schema.prisma': 'The Prisma schema for users, orders and order items, including each order\'s status and when it was canceled.',
  'services/ml/routers/predict.py': 'A FastAPI route that scores a shopper\'s basket with the ranking model.',
};

/** Change summaries, by path; the first entry whose `has` text appears in the diff wins. */
const CHANGE_SUMMARIES = [
  ['apps/api/src/services/orderService.ts', '', 'Adds cancelOrder, which cancels a pending order and records when it was canceled.'],
  ['apps/api/src/routes/orders.ts', 'status(404)', 'The cancel route now returns 404 when the order does not exist.'],
  ['apps/api/src/routes/orders.ts', '', 'Adds POST /orders/:id/cancel, which returns 409 when the order can no longer be canceled.'],
  ['db/migrations/003_order_cancellation.sql', '', 'Adds a cancelledAt column to the orders table.'],
  ['prisma/schema.prisma', '', 'Adds status and cancelledAt to the Order model.'],
  ['apps/web/app/orders/CancelledBadge.tsx', '', 'Adds a CancelledBadge component that shows when an order was canceled.'],
  ['apps/web/app/orders/page.tsx', '', 'Shows canceled orders grayed out, with a badge giving the cancel date.'],
  ['apps/api/src/services/orderService.test.ts', '', 'Adds tests for cancelling a pending order, a shipped order and a missing one.'],
  ['apps/api/package.json', '', 'Adds a test script and Vitest as a dev dependency.'],
];

function cannedSummary(system, user) {
  const p = /^Path: (.+)$/m.exec(user)?.[1]?.trim() ?? '';
  if (system.startsWith('You describe a code change')) {
    const hit = CHANGE_SUMMARIES.find(([cp, has]) => cp === p && user.includes(has));
    return hit ? hit[2] : `Updates ${path.basename(p)}.`;
  }
  return FILE_SUMMARIES[p] ?? `Part of the shop project: ${path.basename(p)}.`;
}

function startFakeProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') { res.writeHead(404).end(); return; }
      let text = '';
      try {
        const j = JSON.parse(body);
        text = cannedSummary(String(j.system ?? ''), String(j.messages?.[0]?.content ?? ''));
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 180, output_tokens: 24 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------- the CLI

let cli;

function startCli(port) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(process.execPath, [CLI, root, '--no-open', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
    cli = p;
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`step timed out after 20 s: the CLI did not print its URL\n${out}`)); }, STEP_TIMEOUT);
    const onData = (b) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the CLI exited early (${code}):\n${out}`)); });
  });
}

async function stopCli() {
  const p = cli;
  cli = undefined;
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  p.removeAllListeners('exit');
  const exited = new Promise((r) => p.once('exit', () => r()));
  p.kill('SIGTERM');
  const killer = setTimeout(() => p.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killer);
}

let url;
const api = (p) => {
  const u = new URL(url);
  return `${u.origin}${p}${p.includes('?') ? '&' : '?'}t=${u.searchParams.get('t')}`;
};

async function historyLast() {
  const res = await fetch(api('/api/history/info'));
  if (!res.ok) throw new Error(`/api/history/info answered ${res.status}`);
  return (await res.json()).last ?? 0;
}

/** Waits until recording is quiet: the newest seq unchanged over three reads 200 ms apart. */
async function settleHistory() {
  let prev = -1;
  let same = 0;
  await until('history to go quiet', async () => {
    const last = await historyLast();
    same = last === prev ? same + 1 : 0;
    prev = last;
    if (same >= 3) return true;
    await sleep(200);
    return false;
  });
}

/** Every recorded event on disk (the history store writes them as JSON lines). */
function records() {
  const dir = path.join(home, 'projects', crypto.createHash('sha1').update(fs.realpathSync(root)).digest('hex'));
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/.test(n))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a line being written */ }
    }
  }
  return out;
}

const changeSeq = (rel, after) => records().filter((r) => r.msg?.type === 'change' && r.msg.change?.path === rel && r.seq > after).at(-1)?.seq ?? 0;

/** The seq of the newest agent event recorded after `after` that `match` accepts (0 while there is none). */
const eventsOf = (msg) => (msg?.type === 'agentEvent' && msg.event ? [msg.event] : msg?.type === 'agentEvents' ? msg.events ?? [] : []);
const eventSeq = (after, match) => records().filter((r) => r.seq > after && eventsOf(r.msg).some(match)).at(-1)?.seq ?? 0;

// ---------------------------------------------------------------- the fake Claude Code session

let transcript;
let lineNo = 0;
const marks = {};

function hookCommand(event) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8'));
  const cmd = (cfg.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command)).find((c) => c.includes('livemap-hook.mjs'));
  if (!cmd) throw new Error(`livemap init configured no ${event} hook`);
  return cmd;
}

/** Runs the hook `livemap init` configured for `event`, through a shell, as Claude Code does. */
function runHook(event, extra = {}) {
  const payload = { session_id: SESSION, transcript_path: transcript, cwd: root, hook_event_name: event, ...extra };
  const p = track(spawn(hookCommand(event), { shell: true, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] }));
  return within(`${event} hook`, new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => { stdout += b; });
    p.stderr.on('data', (b) => { stderr += b; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(JSON.stringify(payload));
  }), p);
}

/**
 * Appends one transcript line and waits until the history holds the event parsed from it (`match`), so
 * the next hook can never be recorded ahead of its line. Unrelated records (summaries, attribution) that
 * advance the history meanwhile do not count.
 */
async function transcriptLine(type, content, label, match) {
  const before = await historyLast();
  lineNo++;
  const line = { type, uuid: `demo-${type}-${lineNo}`, timestamp: new Date().toISOString(), sessionId: SESSION, cwd: root, isSidechain: false, message: { role: type, content } };
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`);
  return until(label, () => eventSeq(before, (e) => e.sessionId === SESSION && match(e)));
}

const GAP = 700;

async function prompt(text) {
  await transcriptLine('user', text, `prompt "${text}"`, (e) => e.type === 'prompt' && e.text === text);
  const r = await runHook('UserPromptSubmit', { prompt: text });
  if (r.code !== 0) throw new Error(`UserPromptSubmit hook exited ${r.code}`);
  await sleep(GAP);
}

async function say(text) {
  await transcriptLine('assistant', [{ type: 'text', text }], 'agent message', (e) => e.type === 'message' && e.text === text);
  await sleep(GAP + Math.min(1200, text.length * 6));
}

let toolNo = 0;

/**
 * One tool call: the tool_use reaches the transcript, PreToolUse runs (and may block it with a flag), the
 * tool's effect happens, then its result is written. Returns the PreToolUse result.
 */
async function tool(name, input, { effect, output = '', label = name, onStart } = {}) {
  const id = `toolu_demo_${String(++toolNo).padStart(2, '0')}`;
  await transcriptLine('assistant', [{ type: 'tool_use', id, name, input }], `${label} tool call`, (e) => e.type === 'tool_start' && e.tool?.id === id);
  const pre = await runHook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id });
  if (pre.code === 2) {
    const content = `PreToolUse:${name} hook error: ${pre.stderr.trim()}`;
    await transcriptLine('user', [{ type: 'tool_result', tool_use_id: id, is_error: true, content }], `${label} blocked result`, (e) => e.type === 'tool_end' && e.tool?.id === id);
    await sleep(GAP);
    return pre;
  }
  if (pre.code !== 0) throw new Error(`PreToolUse hook exited ${pre.code}`);
  if (effect) await effect();
  if (onStart) await onStart();
  await transcriptLine('user', [{ type: 'tool_result', tool_use_id: id, content: output }], `${label} result`, (e) => e.type === 'tool_end' && e.tool?.id === id);
  await sleep(GAP);
  return pre;
}

const abs = (rel) => path.join(root, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
const numbered = (text) => text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n');

/** Writes a file and waits until LiveMap recorded the change. */
async function writeAndWait(rel, text) {
  const before = await historyLast();
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
  const seq = await until(`the change to ${rel} to be recorded`, () => changeSeq(rel, before));
  marks[rel] = seq;
  return seq;
}

const readFile = (rel) => tool('Read', { file_path: abs(rel) }, { label: `Read ${rel}`, output: numbered(read(rel)) });

const writeFile = (rel, text, opts = {}) => tool('Write', { file_path: abs(rel), content: text }, {
  label: `Write ${rel}`, output: `File created successfully at: ${rel}`, effect: () => writeAndWait(rel, text), ...opts,
});

function editFile(rel, oldStr, newStr, opts = {}) {
  const now = read(rel);
  if (!now.includes(oldStr)) throw new Error(`demo edit does not apply to ${rel}`);
  return tool('Edit', { file_path: abs(rel), old_string: oldStr, new_string: newStr }, {
    label: `Edit ${rel}`, output: `The file ${rel} has been updated.`, effect: () => writeAndWait(rel, now.replace(oldStr, newStr)), ...opts,
  });
}

/** Claude Code's MultiEdit: several replacements in one file, one change. */
function multiEdit(rel, pairs, opts = {}) {
  let next = read(rel);
  for (const [oldStr, newStr] of pairs) {
    if (!next.includes(oldStr)) throw new Error(`demo edit does not apply to ${rel}`);
    next = next.replace(oldStr, newStr);
  }
  const edits = pairs.map(([old_string, new_string]) => ({ old_string, new_string }));
  return tool('MultiEdit', { file_path: abs(rel), edits }, {
    label: `MultiEdit ${rel}`, output: `Applied ${pairs.length} edits to ${rel}.`, effect: () => writeAndWait(rel, next), ...opts,
  });
}

const bash = (command, output, opts = {}) => tool('Bash', { command, description: opts.description ?? '' }, { label: `Bash ${command}`, output, ...opts });

async function stop(lastMessage) {
  await runHook('Stop', { stop_hook_active: false, last_assistant_message: lastMessage });
  await sleep(GAP * 2);
}

// The code the agent writes.

const SERVICE = 'apps/api/src/services/orderService.ts';
const ROUTES = 'apps/api/src/routes/orders.ts';
const MIGRATION = 'db/migrations/003_order_cancellation.sql';
const PRISMA = 'prisma/schema.prisma';
const PAGE = 'apps/web/app/orders/page.tsx';
const BADGE = 'apps/web/app/orders/CancelledBadge.tsx';
const TEST = 'apps/api/src/services/orderService.test.ts';
const API_PKG = 'apps/api/package.json';
const FLAG_NOTE = 'Return 404 when the order does not exist';

const CANCEL_FN = `

export class OrderNotCancellable extends Error {}

export async function cancelOrder(id: string) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return null;
  if (order.status !== 'pending') {
    throw new OrderNotCancellable(\`Order \${id} is already \${order.status}\`);
  }
  return prisma.order.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
}
`;

const CANCEL_HANDLER = `async function cancelOrderHandler(req: Request, res: Response) {
  try {
    res.json(await cancelOrder(req.params.id));
  } catch (err) {
    if (err instanceof OrderNotCancellable) return res.status(409).json({ error: err.message });
    throw err;
  }
}

`;

const CANCEL_HANDLER_404 = `async function cancelOrderHandler(req: Request, res: Response) {
  try {
    const order = await cancelOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    if (err instanceof OrderNotCancellable) return res.status(409).json({ error: err.message });
    throw err;
  }
}

`;

const BADGE_TSX = `export function CancelledBadge({ at }: { at: string }) {
  const date = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <span className="badge badge-muted" title={\`Cancelled on \${date}\`}>
      Cancelled {date}
    </span>
  );
}
`;

const TEST_TS = `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { cancelOrder, OrderNotCancellable } from './orderService';

vi.mock('../db', () => ({
  prisma: { order: { findUnique: vi.fn(), update: vi.fn() } },
}));

const order = (status: string) => ({ id: 'o1', userId: 'u1', total: 42, status, cancelledAt: null });

describe('cancelOrder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels a pending order and records when', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(order('pending'));
    vi.mocked(prisma.order.update).mockImplementation(async ({ data }) => ({ ...order('pending'), ...data }));
    const out = await cancelOrder('o1');
    expect(out?.status).toBe('cancelled');
    expect(out?.cancelledAt).toBeInstanceOf(Date);
  });

  it('refuses an order that already shipped', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(order('shipped'));
    await expect(cancelOrder('o1')).rejects.toBeInstanceOf(OrderNotCancellable);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('returns null for an unknown order', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null);
    expect(await cancelOrder('missing')).toBeNull();
  });
});
`;

const VITEST_OUT = (n) => ` RUN  v2.1.9 apps/api

 ✓ src/services/orderService.test.ts (${n} tests) 14ms

 Test Files  1 passed (1)
      Tests  ${n} passed (${n})
   Start at  10:42:17
   Duration  412ms`;

/** The story: one Claude Code session builds order cancellation across four prompts. */
async function story(hooks = {}) {
  transcript = path.join(claudeDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '');
  await runHook('SessionStart', { source: 'startup' });

  // 1. The API: service, route, migration, Prisma model.
  log('prompt 1: order cancellation in the API');
  await prompt('Add order cancellation. Customers should be able to cancel an order while it is still pending.');
  await say("I'll add a cancelOrder function to the order service that only cancels pending orders, expose it as POST /api/orders/:id/cancel, and add a cancelledAt column so we know when each order was cancelled. Let me look at the service and the migrations first.");
  await readFile(SERVICE);
  await readFile('db/migrations/002_add_status.sql');
  await editFile(SERVICE, "  await prisma.order.delete({ where: { id } });\n}\n", `  await prisma.order.delete({ where: { id } });\n}${CANCEL_FN}`);
  await multiEdit(ROUTES, [
    ["import { findOrders, insertOrder, deleteOrder } from '../services/orderService';", "import { findOrders, insertOrder, deleteOrder, cancelOrder, OrderNotCancellable } from '../services/orderService';"],
    ['async function removeOrder(', `${CANCEL_HANDLER}async function removeOrder(`],
    ["router.post('/orders', createOrder);\n", "router.post('/orders', createOrder);\nrouter.post('/orders/:id/cancel', cancelOrderHandler);\n"],
  ]);
  // The fixture's columns are camelCase ("userId", "createdAt"), so the new one is too.
  await writeFile(MIGRATION, 'ALTER TABLE orders ADD COLUMN "cancelledAt" TIMESTAMP;\n');
  await editFile(PRISMA, "  total     Float\n  createdAt DateTime    @default(now())\n", "  total       Float\n  status      String      @default(\"pending\")\n  createdAt   DateTime    @default(now())\n  cancelledAt DateTime?\n");
  marks.afterApi = marks[PRISMA];
  await say('Cancellation is in. POST /api/orders/:id/cancel cancels a pending order and returns 409 if it has already shipped or been cancelled. Migration 003 adds orders.cancelledAt, and the Prisma model now has status and cancelledAt.');
  await stop('Cancellation is in.');
  await sleep(1500);

  // 2. The storefront.
  log('prompt 2: the orders page');
  await prompt('Show canceled orders on the orders page, grayed out with the date they were canceled.');
  await say("I'll add a CancelledBadge component and use it on the orders page.");
  await readFile(PAGE);
  await writeFile(BADGE, BADGE_TSX);
  await editFile(PAGE, 'async function loadOrders(): Promise<{ id: string; total: number }[]> {', "import { CancelledBadge } from './CancelledBadge';\n\ntype Order = { id: string; total: number; status: string; cancelledAt: string | null };\n\nasync function loadOrders(): Promise<Order[]> {");
  await editFile(PAGE, '      {list.map(o => <li key={o.id}>{o.total}</li>)}', "      {list.map(o => (\n        <li key={o.id} className={o.status === 'cancelled' ? 'muted' : undefined}>\n          {o.total}\n          {o.cancelledAt && <CancelledBadge at={o.cancelledAt} />}\n        </li>\n      ))}", {
    onStart: hooks.whileWritingPage,
  });
  await say('Canceled orders now show grayed out on the orders page, with a badge giving the date they were canceled.');
  await stop('Canceled orders now show grayed out.');
  await sleep(1500);

  // 3. Tests.
  log('prompt 3: tests');
  await prompt('Add tests for cancel.');
  await say("I'll add Vitest to the API package and cover the three cases: a pending order is canceled, a shipped order is refused, and an unknown order returns null.");
  await multiEdit(API_PKG, [
    ['    "dev": "tsx watch src/index.ts",', '    "dev": "tsx watch src/index.ts",\n    "test": "vitest run",'],
    ['    "typescript": "^5.6.3"', '    "typescript": "^5.6.3",\n    "vitest": "^2.1.9"'],
  ]);
  await writeFile(TEST, TEST_TS);
  await bash('npm --prefix apps/api test -- orderService', VITEST_OUT(3), { description: 'Run the order service tests' });
  await say('All three tests pass.');
  await stop('All three tests pass.');
  await sleep(1200);

  // The user flags the cancel route from LiveMap, the way the inspector's Flag box does.
  log('flag: the user flags the cancel route');
  const res = await fetch(api('/api/flags'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-livemap-token': new URL(url).searchParams.get('t') },
    body: JSON.stringify({ target: ROUTES, note: FLAG_NOTE }),
  });
  if (res.status !== 201) throw new Error(`POST /api/flags answered ${res.status}`);
  const flag = await res.json();
  await sleep(1500);

  // 4. Commit: the agent picks up the flag at its next tool call, fixes the route, and commits.
  log('prompt 4: commit, after the flag');
  await prompt('Looks good. Commit it.');
  const commit = 'git add -A && git commit -m "Add order cancellation"';
  const blocked = await bash(commit, '', { description: 'Commit the cancellation work' });
  if (blocked.code !== 2 || !blocked.stderr.includes(FLAG_NOTE)) throw new Error('the flag did not reach the agent');
  await say(`You flagged ${ROUTES}: "${FLAG_NOTE}". Right now the cancel route answers 200 with null for an unknown id. I'll return 404 there, rerun the tests, then commit.`);
  await editFile(ROUTES, CANCEL_HANDLER, CANCEL_HANDLER_404);
  // The agent dealt with it: the user removes the flag, with the call the UI makes (ui/src/api.ts removeFlag).
  const del = await fetch(api(`/api/flags/${flag.id}`), {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-livemap-token': new URL(url).searchParams.get('t') },
  });
  if (del.status !== 200) throw new Error(`DELETE /api/flags/${flag.id} answered ${del.status}`);
  await bash('npm --prefix apps/api test -- orderService', VITEST_OUT(3), { description: 'Run the order service tests' });
  const beforeCommit = await historyLast();
  let hash = '';
  await bash(commit, '', {
    description: 'Commit the cancellation work',
    effect: async () => {
      git('add', '-A');
      git('commit', '-q', '-m', 'Add order cancellation');
      hash = git('rev-parse', '--short', 'HEAD').trim();
      // The git commit event itself (not the Bash tool call, whose command also names the message).
      await until('the commit to be recorded', () => eventSeq(beforeCommit, (e) => e.type === 'commit' && e.agent === 'git' && (e.text ?? '').startsWith('Add order cancellation')));
    },
  });
  if (!hash) throw new Error('the commit did not happen');
  await say('Committed "Add order cancellation". The cancel route now returns 404 for an unknown order, 409 for one that can no longer be canceled, and the canceled order otherwise.');
  await stop('Committed.');
}

// ---------------------------------------------------------------- screenshots

let browser;
let page;
const pageErrors = [];

function chromiumPath() {
  const candidate = process.env.LIVEMAP_CHROMIUM ?? (process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : '/opt/pw-browsers/chromium');
  try { return fs.statSync(candidate).isFile() ? candidate : undefined; } catch { return undefined; }
}

async function launch() {
  const { chromium } = await import('playwright');
  const executablePath = chromiumPath();
  const sandbox = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  return chromium.launch({ ...(executablePath ? { executablePath } : {}), args: sandbox });
}

const tab = (t) => page.locator(`[role=tab][data-tab="${t}"]`);
const feed = () => page.getByRole('main', { name: 'Activity' });
const inspector = () => page.getByRole('complementary', { name: 'Inspector' });
const card = (p) => feed().locator('.f-chg').filter({ has: page.locator('.p', { hasText: new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

async function openUi() {
  browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'no-preference' });
  page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url);
  await page.locator('.statuschip').filter({ hasText: 'Live' }).waitFor({ timeout: STEP_TIMEOUT });
  // The project chip shows the parent folder, which is the temp dir: hide it in the screenshots.
  await page.addStyleTag({ content: '.projsel small { display: none !important; }' });
}

async function showTab(t) {
  await tab(t).click();
  await until(`the ${t} tab`, async () => (await tab(t).getAttribute('aria-selected')) === 'true');
  await sleep(400);
}

/** The React Flow viewport transform. */
const viewport = () => page.evaluate(() => document.querySelector('.react-flow__viewport')?.style.transform ?? '');
/** Every Map card's flow position. */
const positions = () => page.evaluate(() => [...document.querySelectorAll('.node[data-path]')].map((el) => `${el.dataset.path}@${el.dataset.x},${el.dataset.y}`).join('|'));

/** Waits for layout springs (about 0.45 s) and camera eases (600 ms) to end, as the Map e2e spec does. */
async function settleMap() {
  await page.locator('.react-flow__node').first().waitFor({ timeout: STEP_TIMEOUT });
  let prev = '';
  let same = 0;
  await until('the map to settle', async () => {
    const now = `${await viewport()}#${await positions()}`;
    same = now === prev ? same + 1 : 0;
    prev = now;
    if (same >= 2) return true;
    await sleep(250);
    return false;
  });
  await sleep(300);
}

async function setLevel(label) {
  const btn = page.locator('.mini-seg').getByRole('button', { name: label, exact: true });
  await btn.click();
  await until(`the ${label} level`, async () => (await btn.getAttribute('aria-pressed')) === 'true');
}

async function ensureFollow() {
  const follow = page.getByRole('button', { name: 'Follow', exact: true });
  if ((await follow.getAttribute('aria-pressed')) !== 'true') await follow.click();
}

const shotsTaken = [];

const MAX_PNG = 400_000;
/**
 * The scale of each screenshot, fixed so reruns match: the sharpest that kept each frame under 400 KB
 * (Chromium's PNG encoder is the only compression). The hero's busy frame needs 1.5x, the timeline 1.75x.
 */
const SHOT_SCALE = { hero: 1.5, activity: 2, summaries: 2, map: 2, schema: 2, timeline: 1.75 };
/** Shots land here first and reach docs/images only when every one of them succeeded. */
const SHOT_DIR = path.join(base, 'shots');

/** Captures `clip` (CSS px) at the shot's fixed scale; fails when the PNG is 400 KB or more. */
async function shot(name, clip) {
  const scale = SHOT_SCALE[name];
  await page.mouse.move(0, 899);
  await settleAnimations();
  const cdp = await page.context().newCDPSession(page);
  let buf;
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale }, captureBeyondViewport: false });
    buf = Buffer.from(data, 'base64');
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  if (buf.length >= MAX_PNG) throw new Error(`${name}.png is ${Math.round(buf.length / 1024)} KB at ${scale}x, over 400 KB: frame a smaller region or lower its scale (not below 1.5x)`);
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), buf);
  shotsTaken.push(name);
  log(`${name}.png ${Math.round(clip.width * scale)}x${Math.round(clip.height * scale)} at ${scale}x, ${Math.round(buf.length / 1024)} KB`);
}

/** Moves the finished shots into docs/images. */
function publishShots() {
  const missing = Object.keys(SHOT_SCALE).filter((n) => !shotsTaken.includes(n));
  if (missing.length) throw new Error(`screenshots missing: ${missing.join(', ')}`);
  fs.mkdirSync(IMAGES, { recursive: true });
  for (const n of shotsTaken) fs.copyFileSync(path.join(SHOT_DIR, `${n}.png`), path.join(IMAGES, `${n}.png`));
}

/** Waits until no finite CSS or Web animation is running (fades, springs, count-ups); looping glows are ignored. */
async function settleAnimations() {
  await sleep(250);
  await until('animations to finish', () => page.evaluate(() => document.getAnimations().every((a) => {
    const t = a.effect?.getTiming?.();
    return a.playState !== 'running' || !t || t.iterations === Infinity;
  })));
  await sleep(150);
}

/** Fits the whole Map in view, then waits out the pause that puts on Follow, until the toggle shows plain "Follow" again. */
async function fitMap() {
  const follow = page.getByRole('button', { name: 'Follow', exact: true });
  await page.locator('main.center').getByRole('button', { name: 'Fit to screen' }).click();
  await until('Follow to show as paused', async () => (await follow.getAttribute('aria-describedby')) !== null);
  await until('Follow to resume', async () => (await follow.getAttribute('aria-describedby')) === null && (await follow.getAttribute('aria-pressed')) === 'true');
  await settleMap();
}

/** A box (CSS px) for `clip`: the given edges, grown by `pad` and kept inside the viewport. */
function box(x0, y0, x1, y1, pad = 12) {
  const x = Math.max(0, Math.floor(x0 - pad));
  const y = Math.max(0, Math.floor(y0 - pad));
  return { x, y, width: Math.min(1440, Math.ceil(x1 + pad)) - x, height: Math.min(900, Math.ceil(y1 + pad)) - y };
}

const rect = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) throw new Error(`no ${s} on the page`);
  const b = el.getBoundingClientRect();
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}, sel);

const rectOf = async (locator) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error('an element to frame is not visible');
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
};

/** Scrolls the Activity feed so that `locator`'s top sits `offset` px below the top of the feed (no locator: to the top). */
async function scrollFeed(locator, offset) {
  const handle = locator ? await locator.elementHandle() : null;
  await page.evaluate(([el, off]) => {
    const main = document.querySelector('main.center');
    const scroller = [...main.querySelectorAll('*')].find((n) => n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
    if (!scroller) return;
    scroller.scrollTop = el ? scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - off : 0;
  }, [handle, offset]);
  await sleep(500);
}

/**
 * The Map with the page being written: its card glows "Writing now" and the inspector explains it. The
 * frame is the Map and the inspector, cut above the timeline to stay under 400 KB.
 */
async function heroShot() {
  await showTab('map');
  await setLevel('Files');
  await ensureFollow();
  await page.locator(`.node[data-path="${PAGE}"]`).waitFor({ timeout: STEP_TIMEOUT });
  await until('the page card to glow', async () => /\blive\b/.test((await page.locator(`.node[data-path="${PAGE}"]`).getAttribute('class')) ?? ''));
  await page.getByRole('tree', { name: 'Files' }).locator(`[data-file="${PAGE}"]`).click();
  await inspector().getByRole('heading', { name: 'page.tsx' }).waitFor({ timeout: STEP_TIMEOUT });
  await inspector().locator('.ai p').waitFor({ timeout: STEP_TIMEOUT });
  await ensureFollow();
  await settleMap();
  const c = await rect('main.center');
  const i = await rect('aside.insp');
  await shot('hero', box(c.left, c.top, i.right, c.top + 520));
}

/** The lowest bottom edge of a Map folder that shows whole above the canvas hint, so no folder is cut in half. */
const mapBottom = () => page.evaluate(() => {
  const pane = document.querySelector('main.center').getBoundingClientRect();
  const hint = document.querySelector('.mv-canvas')?.getBoundingClientRect().bottom ?? pane.bottom;
  const limit = Math.min(hint, pane.bottom) - 56;
  let best = pane.top + 300;
  for (const g of document.querySelectorAll('.mgroup')) {
    const b = g.getBoundingClientRect();
    if (b.top >= pane.top && b.bottom <= limit) best = Math.max(best, b.bottom);
  }
  return best;
});

async function finalShots() {
  await settleHistory();
  // A fresh load fetches the timeline ticks for the whole session at once.
  await page.reload();
  await page.locator('.statuschip').filter({ hasText: 'Live' }).waitFor({ timeout: STEP_TIMEOUT });
  await page.addStyleTag({ content: '.projsel small { display: none !important; }' });

  // Activity: one whole turn of the session, every change card with its summary.
  await showTab('activity');
  await card(TEST).last().locator('.lead').waitFor({ timeout: STEP_TIMEOUT });
  // Summaries arrive one by one: wait until the count of leads stops growing.
  let leads = -1;
  let same = 0;
  await until('the change summaries', async () => {
    const n = await feed().locator('.f-chg .lead').count();
    same = n === leads ? same + 1 : 0;
    leads = n;
    if (same >= 3) return true;
    await sleep(250);
    return false;
  });
  // The storefront turn: its prompt, the agent's plan, the tool calls and a change card for each file.
  await scrollFeed(feed().locator('.f-prompt').filter({ hasText: 'Show canceled orders' }), 6);
  const c = await rect('main.center');
  // Scrolled up, the feed shows "Jump to latest" near its bottom: end the frame at the last item above it.
  const feedEnd = await page.evaluate(() => {
    const main = document.querySelector('main.center');
    const jump = main.querySelector('.jump.show')?.getBoundingClientRect().top ?? main.getBoundingClientRect().bottom;
    let best = 0;
    for (const el of main.querySelectorAll('.act-hero, .turn-h, .f-prompt, .f-msg, .f-tool, .f-chg, .f-git')) {
      const b = el.getBoundingClientRect();
      if (b.height && b.bottom <= jump - 24) best = Math.max(best, b.bottom);
    }
    return best;
  });
  await shot('activity', box(c.left, c.top, c.right, feedEnd - 2));

  // Summaries: the routes tool call and its change card with the lead, and the inspector's "In plain
  // English" for that file. The frame starts at the tool call and ends at the card, so no item is cut.
  const routes = card(ROUTES).first();
  await routes.locator('.lead').waitFor({ timeout: STEP_TIMEOUT });
  await routes.locator('.ch').click();
  await inspector().getByRole('heading', { name: 'orders.ts' }).waitFor({ timeout: STEP_TIMEOUT });
  await inspector().locator('.ai p').waitFor({ timeout: STEP_TIMEOUT });
  await scrollFeed(feed().locator('.f-tool').filter({ hasText: ROUTES }).first(), 4);
  await settleAnimations();
  const rc = await rectOf(routes);
  const ai = await rectOf(inspector().locator('.ai'));
  if (ai.bottom > rc.bottom) throw new Error('the summary box reaches below the routes card: the summaries frame would cut a feed item');
  const i = await rect('aside.insp');
  // The feed's gap between items is about 12 px: end 6 px below the card so the next item never shows.
  await shot('summaries', box(c.left, c.top, i.right, rc.bottom - 6));

  // Map: Files level, Follow on, nothing selected, cut below the last whole row of folders.
  await inspector().getByRole('button', { name: /Live session/ }).click();
  await until('the selection to clear', async () => (await inspector().locator('.backbtn').count()) === 0);
  await showTab('map');
  await setLevel('Files');
  await ensureFollow();
  await settleMap();
  await fitMap();
  await shot('map', box(c.left, c.top, c.right, await mapBottom()));

  // Schema: the tables, framed tightly (the view fits them with a lot of space around).
  await showTab('schema');
  await settleMap();
  const tables = await page.evaluate(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of document.querySelectorAll('main.center .react-flow__node')) {
      const b = n.getBoundingClientRect();
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    return { x0, y0, x1, y1 };
  });
  await shot('schema', box(Math.max(c.left, tables.x0 - 36), tables.y0 - 36, Math.min(c.right, tables.x1 + 36), tables.y1 + 36, 0));

  // Timeline: rewound to just after the API work, before the storefront change.
  const slider = page.getByRole('group', { name: 'Session timeline' }).getByRole('slider', { name: 'Time' });
  await showTab('map');
  await slider.focus();
  await page.keyboard.press('Home');
  const target = marks.afterApi;
  for (let n = 0; ; n++) {
    if (n > 2000) throw new Error('the timeline never reached the API work');
    const now = Number(await slider.getAttribute('aria-valuenow'));
    if (now >= target) break;
    await page.keyboard.press('ArrowRight');
  }
  await page.locator('.rw-banner').waitFor({ timeout: STEP_TIMEOUT });
  await page.locator(`.node[data-path="${MIGRATION}"]`).waitFor({ timeout: STEP_TIMEOUT });
  await settleMap();
  await page.locator('main.center').getByRole('button', { name: 'Fit to screen' }).click();
  await settleMap();
  await shot('timeline', box(c.left, c.top, c.right, c.bottom));
  publishShots();
}

// ---------------------------------------------------------------- export

const LEAKS = ['/tmp/', '/home/', '/Users/', 'C:\\Users', 'C:\\\\Users'];

function checkExport(html) {
  const found = LEAKS.filter((s) => html.includes(s));
  for (const v of [process.env.HOME, base].filter((v) => v && v.length > 1)) {
    if (html.includes(v)) found.push('an environment value');
  }
  if (found.length) throw new Error(`the export contains machine paths or environment values (${[...new Set(found)].join(', ')})`);
}

/** Opens the export from file:// with every network request blocked, as the export e2e spec does. */
async function checkOffline(file) {
  const own = !browser;
  const b = browser ?? (await launch());
  if (own) offlineBrowser = b;
  const offending = [];
  const errors = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    ctx.on('request', (q) => { if (!/^(file|data|blob):/.test(q.url())) offending.push(q.url()); });
    await ctx.route(/^(https?|wss?):/, (r) => r.abort());
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(pathToFileURL(file).href);
    await p.locator('.statuschip').filter({ hasText: 'Replay' }).waitFor({ timeout: STEP_TIMEOUT });
    await p.getByRole('group', { name: 'Session timeline' }).getByRole('button', { name: 'Play history' }).click();
    await sleep(1500);
    await ctx.close();
  } finally {
    if (own) {
      offlineBrowser = undefined;
      await b.close().catch(() => undefined);
    }
  }
  if (offending.length) throw new Error(`the export made network requests: ${offending.join(', ')}`);
  if (errors.length) throw new Error(`the export threw: ${errors.join('; ')}`);
}

// ---------------------------------------------------------------- main

let fake;
let offlineBrowser;

async function main() {
  const t0 = Date.now();
  prepareProject();
  fake = await startFakeProvider();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    summaries: { enabled: true, provider: 'anthropic', apiKey: 'demo-fake-provider', url: `http://127.0.0.1:${fake.address().port}` },
  }));
  url = await startCli(await freePort());
  log(`LiveMap is running on the sample project "shop"${shots ? ', with screenshots' : ''}`);
  if (shots) await openUi();

  await story(shots ? { whileWritingPage: heroShot } : {});
  await settleHistory();
  if (shots) await finalShots();
  if (pageErrors.length) throw new Error(`the UI threw: ${pageErrors.join('; ')}`);

  await stopCli();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const exp = track(spawn(process.execPath, [CLI, 'export', root, '--out', OUT], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  const r = await within('the export', new Promise((resolve) => {
    let out = '';
    exp.stdout.on('data', (b) => { out += b; });
    exp.stderr.on('data', (b) => { out += b; });
    exp.on('close', (code) => resolve({ code, out }));
  }), exp);
  if (r.code !== 0) throw new Error(`livemap export failed:\n${r.out}`);
  checkExport(fs.readFileSync(OUT, 'utf8'));
  await checkOffline(OUT);
  const rel = path.relative(repo, OUT);
  log(`wrote ${rel.startsWith('..') ? OUT : rel} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB) in ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const n of shotsTaken) log(`wrote docs/images/${n}.png`);
}

let cleaning = null;
let signaled = null;

/** Stops everything this run started and removes the temp dir. Every caller gets the same promise, which never rejects. */
function cleanup() {
  cleaning ??= (async () => {
    const step = async (fn) => { try { await fn(); } catch { /* keep cleaning up */ } };
    await step(() => stopCli());
    for (const c of children) await step(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
    await step(() => browser?.close());
    await step(() => offlineBrowser?.close());
    await step(() => new Promise((r) => (fake ? fake.close(() => r()) : r())));
    await step(() => fs.rmSync(base, { recursive: true, force: true }));
  })();
  return cleaning;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    signaled = sig;
    console.error(`demo: stopped by ${sig}`);
    cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}

main().then(cleanup, async (e) => {
  // After a signal, main usually fails because cleanup closed its browser; the signal handler owns the exit code.
  if (signaled) return;
  console.error(`demo: ${e instanceof Error ? e.message : e}`);
  await cleanup();
  process.exit(1);
});
