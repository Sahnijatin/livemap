import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import WebSocket from 'ws';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { startServer, type ServerOptions } from '../../src/server/server.js';
import { HistoryStore } from '../../src/history/store.js';
import { projectDir } from '../../src/history/paths.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

type Started = Awaited<ReturnType<typeof startServer>>;

let root: string;
let home: string;
let uiDir: string;
let model: ProjectModel;
let watcher: Watcher;
let srv: Started | null;
let store: HistoryStore | null;
let sockets: WebSocket[];
let savedHome: string | undefined;

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

async function get(pathAndQuery: string, opts: { token?: string | null; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  const token = opts.token === undefined ? srv!.token : opts.token;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `http://127.0.0.1:${srv!.port}${pathAndQuery}${token ? `${sep}t=${token}` : ''}`;
  return new Promise((resolve, reject) => {
    http.get(url, { headers: opts.headers ?? {} }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
        resolve({ status: res.statusCode!, headers: res.headers, body: raw.length ? JSON.parse(raw.toString('utf8')) : null });
      });
    }).on('error', reject);
  });
}

async function boot(extra: Partial<ServerOptions> = {}, withHistory = true): Promise<Started> {
  model = new ProjectModel(root);
  await model.scan();
  watcher = new Watcher(model, { debounceMs: 30 });
  await watcher.start();
  store = withHistory ? await HistoryStore.open(root) : null;
  srv = await startServer({ model, watcher, port: 0, uiDir, ...(store ? { history: store } : {}), ...extra });
  srv.ready();
  return srv;
}

beforeEach(() => {
  savedHome = process.env.LIVEMAP_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hsrv-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hsrv-home-')));
  uiDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hsrv-ui-')));
  process.env.LIVEMAP_HOME = home;
  put('src/a.ts', 'export function alpha() { return 1; }\n');
  put('src/b.ts', 'export function beta() { return 2; }\n');
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>LiveMap</title>');
  srv = null;
  store = null;
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await srv?.close();
  await watcher?.stop();
  await store?.close();
  if (savedHome === undefined) delete process.env.LIVEMAP_HOME;
  else process.env.LIVEMAP_HOME = savedHome;
  for (const d of [root, home, uiDir]) {
    try { fs.chmodSync(d, 0o700); } catch { /* gone */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('server: history recording', () => {
  it('records changes made before any client connects, and serves state at a seq', async () => {
    const s = await boot();
    put('src/a.ts', 'export function alpha() { return 1; }\nexport function alphaTwo() { return 3; }\n');
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.msg.type === 'change'));
    put('src/b.ts', 'export function beta() { return 2; }\nexport function betaTwo() { return 4; }\n');
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.filter((r: any) => r.msg.type === 'change').length === 2);

    const info = (await get('/api/history/info')).body;
    expect(info.enabled).toBe(true);
    expect(info.runs).toHaveLength(1);
    expect(info.last).toBeGreaterThan(info.first);

    const records = (await get(`/api/history/messages?from=${info.first}&to=${info.last}`)).body;
    // The run-start record carries the state at ready, without the hello's history fields.
    expect(records[0].msg.type).toBe('hello');
    expect(records[0].msg).not.toHaveProperty('history');
    expect(records[0].msg).not.toHaveProperty('seq');
    expect(records[0].msg.files.map((f: any) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const changes = records.filter((r: any) => r.msg.type === 'change');
    expect(changes.map((r: any) => r.msg.change.path)).toEqual(['src/a.ts', 'src/b.ts']);

    const res = await get(`/api/history/state?seq=${changes[0].seq}`);
    expect(res.status).toBe(200);
    expect(res.body.seq).toBe(changes[0].seq);
    expect(res.body.changes.map((c: any) => c.path)).toEqual(['src/a.ts']);
    const symbols = (p: string) => res.body.files.find((f: any) => f.path === p).symbols.map((x: any) => x.name);
    expect(symbols('src/a.ts')).toContain('alphaTwo');
    expect(symbols('src/b.ts')).not.toContain('betaTwo');

    // hello.seq is the last recorded seq; the hello's history status matches info.
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    const hello = ofType(c, 'hello')[0];
    const now = (await get('/api/history/info')).body;
    expect(hello.seq).toBe(now.last);
    expect(hello.history).toMatchObject({ enabled: true, first: now.first, last: now.last });
  });

  it('records domain changes from the parsed index', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('package.json', JSON.stringify({ dependencies: { express: '^4.19.0' } }));
    put('src/server.ts', "import express from 'express';\nconst app = express();\napp.get('/api/orders', (req, res) => res.json([]));\n");
    await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.length > 0));
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.msg.type === 'domain'));
    const records = (await get('/api/history/messages?from=1&to=1000')).body;
    const domain = records.filter((r: any) => r.msg.type === 'domain').pop();
    expect(domain.msg.domain).toEqual(ofType(c, 'domain').pop()!.domain);
  });

  it('broadcasts history status after recording', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 5; }\n');
    await waitFor(() => ofType(c, 'history').length > 0);
    const status = ofType(c, 'history').pop()!.history;
    expect(status.enabled).toBe(true);
    expect(status.last).toBeGreaterThan(ofType(c, 'hello')[0].seq!);
  });

  it('stamps each recorded broadcast with its seq; the recorded message itself has none', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 6; }\n');
    await waitFor(() => ofType(c, 'change').length > 0);
    const live = ofType(c, 'change')[0] as any;
    expect(live.seq).toBeGreaterThan(ofType(c, 'hello')[0].seq!);
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.seq === live.seq));
    const rec = (await get('/api/history/messages?from=1&to=1000')).body.find((r: any) => r.seq === live.seq);
    expect(rec.msg.type).toBe('change');
    expect(rec.msg).not.toHaveProperty('seq');
    // Status messages are not recorded and carry no seq.
    await waitFor(() => ofType(c, 'history').length > 0);
    expect(ofType(c, 'history')[0]).not.toHaveProperty('seq');
  });

  it('stamps a live domain update with the seq it was recorded at', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('package.json', JSON.stringify({ dependencies: { express: '^4.19.0' } }));
    put('src/server.ts', "import express from 'express';\nconst app = express();\napp.get('/api/orders', (req, res) => res.json([]));\n");
    await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.length > 0));
    const live = ofType(c, 'domain').find(m => m.domain.routes.length > 0) as any;
    expect(live.seq).toBeGreaterThan(ofType(c, 'hello')[0].seq!);
    await waitFor(async () => (await get('/api/history/messages?from=1&to=1000')).body.some((r: any) => r.seq === live.seq));
    const rec = (await get('/api/history/messages?from=1&to=1000')).body.find((r: any) => r.seq === live.seq);
    expect(rec.msg.type).toBe('domain');
    expect(rec.msg).not.toHaveProperty('seq');
  });

  it('a watcher reset starts a new run: its hello carries the run-start seq, and state at that seq is the rebuilt model', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/late.ts', 'export function late() { return 7; }\n');
    await model.update('src/late.ts', 'add', { deferRelink: true }); // in the model, no change sent
    watcher.emit('reset');
    await waitFor(() => ofType(c, 'hello').length === 2);
    const info = (await get('/api/history/info')).body;
    expect(info.runs).toHaveLength(2);
    const newRun = info.runs[1];
    const resetHello = ofType(c, 'hello')[1];
    expect(resetHello.seq).toBe(newRun.firstSeq);
    const state = (await get(`/api/history/state?seq=${newRun.firstSeq}`)).body;
    expect(state.seq).toBe(newRun.firstSeq);
    expect(state.files).toEqual(model.all());
    expect(state.files).toEqual(resetHello.files);
    expect(state.files.map((f: any) => f.path)).toContain('src/late.ts');
  });

  it('sends no seq on broadcasts when history is off', async () => {
    const s = await boot({}, false);
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    put('src/a.ts', 'export function alpha() { return 9; }\n');
    await waitFor(() => ofType(c, 'change').length > 0);
    expect(ofType(c, 'change')[0]).not.toHaveProperty('seq');
  });

  it('serves the live hello at /api/state', async () => {
    await boot();
    const res = await get('/api/state', { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.type).toBe('hello');
    expect(res.body.files.map((f: any) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(res.body.seq).toBe((await get('/api/history/info')).body.last);
    expect(res.body.history.enabled).toBe(true);
  });

  it('gzips state at a seq only when the client accepts it', async () => {
    await boot();
    const plain = await get('/api/history/state?seq=1');
    expect(plain.status).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    const gz = await get('/api/history/state?seq=1', { headers: { 'accept-encoding': 'gzip, deflate' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body).toEqual(plain.body);
  });

  it('rejects requests without a token', async () => {
    await boot();
    for (const p of ['/api/history/info', '/api/history/ticks', '/api/history/state?seq=1', '/api/history/messages', '/api/state']) {
      expect((await get(p, { token: null })).status, p).toBe(401);
    }
  });

  it('answers 400 for a bad or out-of-range seq and clamps ticks and limits', async () => {
    await boot();
    for (const q of ['', 'seq=', 'seq=abc', 'seq=-1', 'seq=1.5', 'seq=999999']) {
      const res = await get(`/api/history/state?${q}`);
      expect(res.status, q).toBe(400);
    }
    expect((await get('/api/history/messages?from=x')).status).toBe(400);
    expect((await get('/api/history/messages?from=5&to=2')).status).toBe(400);
    expect((await get('/api/history/ticks?buckets=nope')).status).toBe(400);
    const ticks = (await get('/api/history/ticks?buckets=1')).body;
    expect(ticks.buckets.length).toBeGreaterThan(0);
    expect((await get('/api/history/messages?from=&to=&limit=999999')).status).toBe(200);
  });

  it('answers 404 history disabled without a store, and hello says disabled', async () => {
    const s = await boot({}, false);
    for (const p of ['/api/history/info', '/api/history/ticks', '/api/history/state?seq=1', '/api/history/messages']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(res.body).toEqual({ error: 'history disabled' });
    }
    expect((await get('/api/state')).status).toBe(200);
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    expect(ofType(c, 'hello')[0].history).toMatchObject({ enabled: false });
    expect(ofType(c, 'hello')[0].seq).toBe(0);
    // Turned off by the user, not a failure: the status says so, with no error.
    expect(ofType(c, 'hello')[0].history).toMatchObject({ off: true });
    expect(ofType(c, 'hello')[0].history).not.toHaveProperty('error');
  });

  it('a recording store is not marked off', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    expect(ofType(c, 'hello')[0].history).not.toHaveProperty('off');
  });

  it('reports a store that stops being writable mid-run, and live messages keep flowing', async () => {
    const s = await boot();
    const c = connect(s.port, s.token);
    await waitFor(() => ofType(c, 'hello').length === 1);
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...rest: any[]) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      // Read-only directory, and (since root ignores modes) the events file swapped for a directory.
      const dir = projectDir(root);
      const events = fs.readdirSync(dir).find(n => n.startsWith('events-'))!;
      fs.rmSync(path.join(dir, events));
      fs.mkdirSync(path.join(dir, events));
      fs.chmodSync(dir, 0o500);

      put('src/a.ts', 'export function alpha() { return 7; }\n');
      await waitFor(() => ofType(c, 'history').some(m => !m.history.enabled));
      const status = ofType(c, 'history').find(m => !m.history.enabled)!.history;
      expect(status.error).toMatch(/could not write history files/);

      put('src/b.ts', 'export function beta() { return 8; }\n');
      await waitFor(() => ofType(c, 'change').some(m => m.change.path === 'src/b.ts'));
      expect(errors.filter(e => e.includes('history')).length).toBe(1);
    } finally {
      process.stderr.write = write;
      fs.chmodSync(projectDir(root), 0o700);
    }
  });
});
