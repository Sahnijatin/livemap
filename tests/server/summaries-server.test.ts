import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { startServer, type ServerOptions } from '../../src/server/server.js';
import { HistoryStore } from '../../src/history/store.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import type { SummaryStatus } from '../../src/shared/summaries.js';
import type { ChangeSummary, CodeSymbol, FileModel } from '../../src/shared/types.js';

type Started = Awaited<ReturnType<typeof startServer>>;

/** A summarizer double: answers at once (or when released), records what it was asked. */
class FakeSummarizer extends EventEmitter {
  st: SummaryStatus = { state: 'ready', provider: 'anthropic', model: 'claude-haiku-5-5', usedTokens: 10, capTokens: 1000, month: '2026-10' };
  files: { path: string; text: string }[] = [];
  changes: ChangeSummary[] = [];
  hold: Promise<void> | null = null;
  status(): SummaryStatus { return this.st; }
  async summarizeFile(file: FileModel, text: string): Promise<string | null> {
    this.files.push({ path: file.path, text });
    if (this.hold) await this.hold;
    return `About ${file.path} (${file.symbols.length})`;
  }
  async summarizeChange(change: ChangeSummary): Promise<string | null> {
    this.changes.push(change);
    return `Changed ${change.path}`;
  }
  setStatus(s: Partial<SummaryStatus>): void {
    this.st = { ...this.st, ...s };
    this.emit('status', this.st);
  }
}

let root: string;
let home: string;
let uiDir: string;
let model: ProjectModel;
let watcher: Watcher;
let srv: Started | null;
let store: HistoryStore | null;
let sockets: WebSocket[];
let savedHome: string | undefined;
let fake: FakeSummarizer;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
function put(rel: string, data: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

interface Client { msgs: ServerMessage[] }
function connect(port: number, token: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
  sockets.push(ws);
  const c: Client = { msgs: [] };
  ws.on('message', d => c.msgs.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  return c;
}
const ofType = <T extends ServerMessage['type']>(c: Client, t: T) =>
  c.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

async function get(pathAndQuery: string, token: string | null = srv!.token): Promise<{ status: number; body: any }> {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:${srv!.port}${pathAndQuery}${token ? `${sep}t=${token}` : ''}`;
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
      });
    }).on('error', reject);
  });
}

async function boot(extra: Partial<ServerOptions> = {}, withHistory = false): Promise<Started> {
  model = new ProjectModel(root);
  await model.scan();
  watcher = new Watcher(model, { debounceMs: 30 });
  await watcher.start();
  store = withHistory ? await HistoryStore.open(root) : null;
  srv = await startServer({ model, watcher, port: 0, uiDir, summarizer: fake, ...(store ? { history: store } : {}), ...extra });
  srv.ready();
  return srv;
}

async function hello(s: Started): Promise<Extract<ServerMessage, { type: 'hello' }>> {
  const c = connect(s.port, s.token);
  await waitFor(() => ofType(c, 'hello').length === 1);
  return ofType(c, 'hello')[0];
}

function symbolHash(f: FileModel): string {
  const pairs: string[] = [];
  const walk = (xs: CodeSymbol[]) => { for (const x of xs) { pairs.push(`${x.qname}|${x.signature}`); walk(x.children); } };
  walk(f.symbols);
  return crypto.createHash('sha1').update(pairs.sort().join('\n')).digest('hex');
}

beforeEach(() => {
  savedHome = process.env.LIVEMAP_HOME;
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sum-')));
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sum-home-')));
  uiDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sum-ui-')));
  process.env.LIVEMAP_HOME = home;
  put('src/a.ts', 'export function alpha() { return 1; }\n');
  put('src/b.ts', 'export function beta() { return 2; }\n');
  put('.env', 'SECRET_TOKEN=abc123\n');
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>LiveMap</title>');
  srv = null;
  store = null;
  sockets = [];
  fake = new FakeSummarizer();
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await srv?.close();
  await watcher?.stop();
  await store?.close();
  if (savedHome === undefined) delete process.env.LIVEMAP_HOME;
  else process.env.LIVEMAP_HOME = savedHome;
  for (const d of [root, home, uiDir]) fs.rmSync(d, { recursive: true, force: true });
});

describe('server: change summaries', () => {
  it('sends a summary for a change with a symbol change, after attribution', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 1; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(() => ofType(c, 'summary').length === 1);
    const change = ofType(c, 'change')[0].change;
    expect(ofType(c, 'summary')[0]).toMatchObject({ changeId: change.id, summary: 'Changed src/a.ts' });
    // The summary goes out after the change it describes.
    expect(c.msgs.findIndex(m => m.type === 'change')).toBeLessThan(c.msgs.findIndex(m => m.type === 'summary'));
    // A later hello carries it on the change.
    const h = await hello(s);
    expect(h.changes.find(x => x.id === change.id)?.summary).toBe('Changed src/a.ts');
  });

  it('does not summarize a whitespace-only change', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 1; }\n\n\n');
    await waitFor(() => ofType(c, 'change').length === 1);
    await sleep(150);
    expect(fake.changes).toHaveLength(0);
    expect(ofType(c, 'summary')).toHaveLength(0);
  });

  it('sends nothing for changes without a summarizer, and hello says summaries are off', async () => {
    const s = await boot({ summarizer: undefined });
    const h = await hello(s);
    expect(h.summaries?.status.state).toBe('off');
    expect(h.summaries?.status.capTokens).toBe(2_000_000);
    expect(h.summaries?.status.month).toMatch(/^\d{4}-\d{2}$/);
    expect(h.summaries?.files).toEqual({});
    expect((await get('/api/summary?path=src/a.ts')).status).toBe(503);
  });
});

describe('server: file summaries', () => {
  it('answers 202, broadcasts fileSummary when ready, then serves the cached summary', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    let release!: () => void;
    fake.hold = new Promise(r => { release = r; });
    const first = await get('/api/summary?path=src/a.ts');
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ pending: true });
    // A second request while pending does not ask again.
    expect((await get('/api/summary?path=src/a.ts')).status).toBe(202);
    release();
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    const hash = symbolHash(model.get('src/a.ts')!);
    expect(ofType(c, 'fileSummary')[0]).toMatchObject({ path: 'src/a.ts', hash, summary: 'About src/a.ts (1)' });
    expect(fake.files).toEqual([{ path: 'src/a.ts', text: 'export function alpha() { return 1; }\n' }]);
    const again = await get('/api/summary?path=src/a.ts');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ summary: 'About src/a.ts (1)', hash });
    expect(fake.files).toHaveLength(1);
    expect((await hello(s)).summaries?.files['src/a.ts']).toEqual({ hash, summary: 'About src/a.ts (1)' });
  });

  it('validates the path like /api/file and never sends a secret file', async () => {
    await boot();
    expect((await get('/api/summary?path=.env')).status).toBe(403);
    expect((await get('/api/summary?path=../etc/passwd')).status).toBe(400);
    expect((await get('/api/summary')).status).toBe(400);
    expect((await get('/api/summary?path=src/nope.ts')).status).toBe(404);
    expect((await get('/api/summary?path=src/a.ts', null)).status).toBe(401);
    expect(fake.files).toHaveLength(0);
  });

  it('writes no file summary for a new or changed file until it is requested (#34)', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/c.ts', 'export function gamma() { return 3; }\n');
    await waitFor(() => ofType(c, 'change').some(m => m.change.path === 'src/c.ts'));
    put('src/c.ts', 'export function gamma() { return 3; }\nexport function delta() { return 4; }\n');
    await waitFor(() => ofType(c, 'change').filter(m => m.change.path === 'src/c.ts').length === 2);
    await sleep(150);
    expect(fake.files).toEqual([]);
    expect(ofType(c, 'fileSummary')).toEqual([]);
    // Change cards are still summarized on their own.
    await waitFor(() => ofType(c, 'summary').length === 2);
    expect((await get('/api/summary?path=src/c.ts')).status).toBe(202);
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    expect(ofType(c, 'fileSummary')[0]).toMatchObject({ path: 'src/c.ts', summary: 'About src/c.ts (2)', hash: symbolHash(model.get('src/c.ts')!) });
  });

  it('withdraws an outdated summary with a recorded clear when the symbol set changes; a new one waits for a request', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    expect((await get('/api/summary?path=src/a.ts')).status).toBe(202);
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    put('src/a.ts', 'export function alpha() { return 1; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(() => ofType(c, 'fileSummary').length === 2);
    // The clear goes out at once, and hello no longer carries the old summary.
    expect(ofType(c, 'fileSummary')[1]).toMatchObject({ path: 'src/a.ts', hash: '', summary: '' });
    expect((await hello(s)).summaries?.files['src/a.ts']).toBeUndefined();
    await sleep(150);
    expect(fake.files).toHaveLength(1);
    // A body-only edit keeps the symbol set: nothing to withdraw.
    put('src/a.ts', 'export function alpha() { return 10; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(() => ofType(c, 'change').filter(m => m.change.path === 'src/a.ts').length === 2);
    expect((await get('/api/summary?path=src/a.ts')).status).toBe(202);
    await waitFor(() => ofType(c, 'fileSummary').length === 3);
    expect(ofType(c, 'fileSummary')[2]).toMatchObject({ path: 'src/a.ts', hash: symbolHash(model.get('src/a.ts')!), summary: 'About src/a.ts (2)' });
  });

  it('redoes a requested summary still being written when the symbol set changes', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    let release!: () => void;
    fake.hold = new Promise(r => { release = r; });
    expect((await get('/api/summary?path=src/a.ts')).status).toBe(202);
    put('src/a.ts', 'export function alpha() { return 1; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(() => fake.files.length === 2);
    release();
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    await sleep(100);
    expect(ofType(c, 'fileSummary')).toHaveLength(1);
    expect(ofType(c, 'fileSummary')[0]).toMatchObject({ path: 'src/a.ts', hash: symbolHash(model.get('src/a.ts')!), summary: 'About src/a.ts (2)' });
  });

  it('withdraws a deleted file\'s summary with a clear', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    expect((await get('/api/summary?path=src/b.ts')).status).toBe(202);
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    fs.rmSync(path.join(root, 'src/b.ts'));
    await waitFor(() => ofType(c, 'fileSummary').length === 2);
    expect(ofType(c, 'fileSummary')[1]).toMatchObject({ path: 'src/b.ts', hash: '', summary: '' });
    expect((await hello(s)).summaries?.files).toEqual({});
    // A file without a summary is deleted without a clear.
    fs.rmSync(path.join(root, 'src/a.ts'));
    await waitFor(() => ofType(c, 'change').filter(m => m.change.kind === 'deleted').length === 2);
    await sleep(100);
    expect(ofType(c, 'fileSummary')).toHaveLength(2);
  });

  it('broadcasts status changes and sends the status in hello', async () => {
    const s = await boot();
    const h = await hello(s);
    expect(h.summaries?.status).toEqual(fake.st);
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    fake.setStatus({ state: 'error', error: '401 invalid key' });
    await waitFor(() => ofType(c, 'summaryStatus').length === 1);
    expect(ofType(c, 'summaryStatus')[0].status).toMatchObject({ state: 'error', error: '401 invalid key' });
    expect(JSON.stringify(c.msgs)).not.toContain('apiKey');
  });
});

describe('server: summaries in history', () => {
  it('records summary and fileSummary (not summaryStatus) and replays them in stateAt', async () => {
    const s = await boot({}, true);
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 1; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(() => ofType(c, 'summary').length === 1);
    expect((await get('/api/summary?path=src/b.ts')).status).toBe(202);
    await waitFor(() => ofType(c, 'fileSummary').length === 1);
    fake.setStatus({ state: 'working' });
    await waitFor(() => ofType(c, 'summaryStatus').length === 1);
    // Recorded messages are stamped with their seq; the status is not recorded.
    expect((ofType(c, 'summary')[0] as { seq?: number }).seq).toBeGreaterThan(0);
    expect((ofType(c, 'fileSummary')[0] as { seq?: number }).seq).toBeGreaterThan(0);
    expect((ofType(c, 'summaryStatus')[0] as { seq?: number }).seq).toBeUndefined();

    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.msg.type === 'fileSummary'));
    const records = (await get('/api/history/messages?from=1&to=1000')).body as { seq: number; msg: ServerMessage }[];
    const types = records.map(r => r.msg.type);
    expect(types).toContain('summary');
    expect(types).not.toContain('summaryStatus');
    const last = records[records.length - 1].seq;
    const state = (await get(`/api/history/state?seq=${last}`)).body;
    expect(state.changes.find((x: any) => x.path === 'src/a.ts').summary).toBe('Changed src/a.ts');
    expect(state.summaries.files['src/b.ts'].summary).toBe('About src/b.ts (1)');

    // A clear is recorded too, so replay past it shows no summary.
    fs.rmSync(path.join(root, 'src/b.ts'));
    await waitFor(() => ofType(c, 'fileSummary').length === 2);
    const clearSeq = (ofType(c, 'fileSummary')[1] as { seq?: number }).seq!;
    expect(clearSeq).toBeGreaterThan(0);
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.seq === clearSeq));
    const after = (await get(`/api/history/state?seq=${clearSeq}`)).body;
    expect(after.summaries.files).toEqual({});
  });
});
