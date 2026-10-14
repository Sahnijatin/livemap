import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { startServer, safeSend, DEFAULT_PORT, MAX_BUFFERED_BYTES } from '../../src/server/server.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

type Started = Awaited<ReturnType<typeof startServer>>;

let root: string;
let uiDir: string;
let model: ProjectModel;
let watcher: Watcher;
let srv: Started | null;
let sockets: WebSocket[];
let blockers: net.Server[];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
function put(dir: string, rel: string, data: string | Buffer): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }
function get(port: number, pathAndQuery: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface Client { ws: WebSocket; msgs: ServerMessage[]; times: number[]; closed: { code: number } | null; opened: boolean; rejected: number | null }
function connect(port: number, query: string, headers: Record<string, string> = {}): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers });
  sockets.push(ws);
  const c: Client = { ws, msgs: [], times: [], closed: null, opened: false, rejected: null };
  ws.on('open', () => (c.opened = true));
  ws.on('message', d => { c.msgs.push(JSON.parse(String(d))); c.times.push(Date.now()); });
  ws.on('close', code => (c.closed = { code }));
  ws.on('unexpected-response', (_req, res) => { c.rejected = res.statusCode ?? 0; ws.terminate(); });
  ws.on('error', () => {});
  return c;
}
const ofType = <T extends ServerMessage['type']>(c: Client, t: T) =>
  c.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

async function boot(opts: { ready?: boolean; port?: number; ui?: string } = {}): Promise<Started> {
  model = new ProjectModel(root);
  await model.scan();
  watcher = new Watcher(model, { debounceMs: 30 });
  await watcher.start();
  srv = await startServer({ model, watcher, port: opts.port ?? 0, uiDir: opts.ui ?? uiDir });
  if (opts.ready !== false) srv.ready();
  return srv;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-srv-')));
  uiDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ui-')));
  put(root, 'src/a.ts', 'import { b } from "./b";\nexport const a = b + 1;\n');
  put(root, 'src/b.ts', 'export const b = 1;\n');
  put(root, 'src/a b/ü.ts', 'export const umlaut = "ü";\n');
  put(root, '.env', 'API_KEY=supersecretvalue\n');
  put(root, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 0]));
  put(uiDir, 'index.html', '<!doctype html><title>LiveMap</title>');
  put(uiDir, 'assets/app.js', 'console.log(1);');
  put(uiDir, 'assets/app.css', 'body{}');
  srv = null;
  sockets = [];
  blockers = [];
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await srv?.close();
  await watcher?.stop();
  for (const b of blockers) await new Promise(r => b.close(r));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe('startServer: binding and ports', () => {
  it('binds 127.0.0.1 and generates a 32-hex token', async () => {
    const s = await boot();
    expect(s.server.address()).toMatchObject({ address: '127.0.0.1' });
    expect(s.token).toMatch(/^[0-9a-f]{32}$/);
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/?t=${s.token}`);
  });

  it('falls back to the next port when the requested one is occupied', async () => {
    // Ask the OS for a free port P whose neighbour P+1 is also free, then occupy P.
    let blocker: net.Server | null = null;
    let p = 0;
    for (let attempt = 0; attempt < 20 && !blocker; attempt++) {
      const b = net.createServer();
      await new Promise<void>(r => b.listen(0, '127.0.0.1', () => r()));
      p = (b.address() as net.AddressInfo).port;
      const probe = net.createServer();
      const free = await new Promise<boolean>(r => {
        probe.once('error', () => r(false));
        probe.listen(p + 1, '127.0.0.1', () => r(true));
      });
      if (free) await new Promise(r => probe.close(r));
      if (free && p < 65535) blocker = b;
      else await new Promise(r => b.close(r));
    }
    if (!blocker) throw new Error('no free port pair found');
    blockers.push(blocker);
    const s = await boot({ port: p });
    expect(s.port).toBe(p + 1);
  });

  it('defaults to port 4317', () => {
    expect(DEFAULT_PORT).toBe(4317);
  });
});

describe('startServer: HTTP auth', () => {
  it('/api/health is 401 without a token and 200 with it', async () => {
    const s = await boot();
    expect((await get(s.port, '/api/health')).status).toBe(401);
    expect((await get(s.port, '/api/health?t=deadbeef')).status).toBe(401);
    const ok = await get(s.port, `/api/health?t=${s.token}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
  });

  it('R10: an unauthenticated page load gets a 401 HTML guidance page with no project data; API stays JSON', async () => {
    const s = await boot();
    for (const p of ['/', '/?t=deadbeef', '/some/route']) {
      const r = await get(s.port, p);
      expect(r.status, p).toBe(401);
      expect(r.headers['content-type'], p).toMatch(/^text\/html/);
      expect(r.headers['set-cookie'], p).toBeUndefined();
      expect(r.body, p).toContain('<h1>LiveMap</h1>');
      expect(r.body, p).toContain('Open the link printed in your terminal. It includes a one-time key.');
      expect(r.body, p).not.toContain(path.basename(root));
      expect(r.body, p).not.toContain('a.ts');
      expect(r.body, p).not.toMatch(/<script|<link|src=/i);
    }
    const api = await get(s.port, '/api/file?path=src/a.ts');
    expect(api.status).toBe(401);
    expect(api.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(api.body)).toEqual({ error: 'unauthorized' });
  });

  it('accepts the x-livemap-token header', async () => {
    const s = await boot();
    expect((await get(s.port, '/api/health', { 'x-livemap-token': s.token })).status).toBe(200);
    expect((await get(s.port, '/api/health', { 'x-livemap-token': s.token.slice(1) })).status).toBe(401);
  });

  it('GET / with the token sets an HttpOnly SameSite=Strict cookie that then authenticates', async () => {
    const s = await boot();
    const page = await get(s.port, `/?t=${s.token}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>LiveMap</title>');
    const cookie = String(page.headers['set-cookie']?.[0] ?? '');
    expect(cookie).toMatch(new RegExp(`^lm_token_${s.port}=[0-9a-f]{32}`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    const jar = cookie.split(';')[0];
    expect((await get(s.port, '/assets/app.js', { cookie: jar })).status).toBe(200);
    expect((await get(s.port, '/api/health', { cookie: jar })).status).toBe(200);
    expect((await get(s.port, '/api/health', { cookie: `lm_token_${s.port}=nope` })).status).toBe(401);
    expect((await get(s.port, '/api/health', { cookie: `lm_token=${s.token}` })).status).toBe(401);
    expect((await get(s.port, '/')).status).toBe(401);
    expect((await get(s.port, '/assets/app.js')).status).toBe(401);
  });

  it('scopes the cookie per port so two instances never collide', async () => {
    const a = await boot();
    const b = await startServer({ model, watcher, port: 0, uiDir });
    try {
      b.ready();
      const ca = String((await get(a.port, `/?t=${a.token}`)).headers['set-cookie']?.[0]).split(';')[0];
      const cb = String((await get(b.port, `/?t=${b.token}`)).headers['set-cookie']?.[0]).split(';')[0];
      expect(ca.split('=')[0]).not.toBe(cb.split('=')[0]);
      // A browser sends both cookies to both ports (cookies ignore ports).
      const both = `${ca}; ${cb}`;
      expect((await get(a.port, '/api/health', { cookie: both })).status).toBe(200);
      expect((await get(b.port, '/api/health', { cookie: both })).status).toBe(200);
      expect((await get(a.port, '/api/health', { cookie: cb })).status).toBe(401);
      expect((await get(b.port, '/api/health', { cookie: ca })).status).toBe(401);
      // The other instance's token under this instance's cookie name is rejected too.
      expect((await get(a.port, '/api/health', { cookie: `lm_token_${a.port}=${b.token}` })).status).toBe(401);
      const wa = connect(a.port, '', { cookie: cb });
      await waitFor(() => wa.closed !== null);
      expect(wa.closed!.code).toBe(4401);
    } finally {
      await b.close();
    }
  });

  it('rejects a foreign Host header with 403 (DNS rebinding)', async () => {
    const s = await boot();
    expect((await get(s.port, `/api/health?t=${s.token}`, { host: 'evil.example:80' })).status).toBe(403);
    expect((await get(s.port, `/api/health?t=${s.token}`, { host: `localhost:${s.port}` })).status).toBe(200);
  });
});

describe('startServer: /api/file', () => {
  it('rejects traversal and absolute paths with 400', async () => {
    const s = await boot();
    for (const p of ['../etc/passwd', 'src/../../etc/passwd', '/etc/passwd', '..\\..\\x', 'C:/Windows/win.ini', '']) {
      const r = await get(s.port, `/api/file?path=${encodeURIComponent(p)}&t=${s.token}`);
      expect(r.status, p).toBe(400);
    }
  });

  it('returns 403 for secret and binary files and 404 for unknown ones', async () => {
    const s = await boot();
    const env = await get(s.port, `/api/file?path=.env&t=${s.token}`);
    expect(env.status).toBe(403);
    expect(env.body).not.toContain('supersecretvalue');
    expect((await get(s.port, `/api/file?path=img.bin&t=${s.token}`)).status).toBe(403);
    expect((await get(s.port, `/api/file?path=src/nope.ts&t=${s.token}`)).status).toBe(404);
  });

  it('serves URL-encoded paths with spaces and non-ASCII characters', async () => {
    const s = await boot();
    const r = await get(s.port, `/api/file?path=${encodeURIComponent('src/a b/ü.ts')}&t=${s.token}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ path: 'src/a b/ü.ts', content: 'export const umlaut = "ü";\n' });
  });

  it('normalizes backslashes', async () => {
    const s = await boot();
    const r = await get(s.port, `/api/file?path=${encodeURIComponent('src\\b.ts')}&t=${s.token}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).path).toBe('src/b.ts');
  });
});

describe('startServer: static files', () => {
  it('serves assets with a MIME type and falls back to index.html for unknown paths', async () => {
    const s = await boot();
    const js = await get(s.port, `/assets/app.js?t=${s.token}`);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await get(s.port, `/assets/app.css?t=${s.token}`)).headers['content-type']).toMatch(/text\/css/);
    const spa = await get(s.port, `/some/route?t=${s.token}`);
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('<title>LiveMap</title>');
    const dir = await get(s.port, `/assets/?t=${s.token}`);
    expect(dir.body).toContain('<title>LiveMap</title>');
  });

  it('never serves files outside uiDir', async () => {
    put(path.dirname(uiDir), `${path.basename(uiDir)}-secret.txt`, 'TOP SECRET');
    const s = await boot();
    for (const p of [`/..%2f${path.basename(uiDir)}-secret.txt`, `/%2e%2e/${path.basename(uiDir)}-secret.txt`, '/assets/..%2f..%2fetc%2fpasswd']) {
      const r = await get(s.port, `${p}?t=${s.token}`);
      expect(r.body, p).not.toContain('TOP SECRET');
      expect(r.body, p).not.toContain('root:');
    }
    fs.rmSync(path.join(path.dirname(uiDir), `${path.basename(uiDir)}-secret.txt`), { force: true });
  });

  it('returns 503 "LiveMap UI is not built" when uiDir is missing, while the API still works', async () => {
    const s = await boot({ ui: path.join(uiDir, 'does-not-exist') });
    const r = await get(s.port, `/?t=${s.token}`);
    expect(r.status).toBe(503);
    expect(r.body).toBe('LiveMap UI is not built');
    expect((await get(s.port, `/api/health?t=${s.token}`)).status).toBe(200);
    expect((await get(s.port, '/')).status).toBe(401);
  });
});

describe('startServer: WebSocket', () => {
  it('closes a connection with a bad token with code 4401', async () => {
    const s = await boot();
    const c = connect(s.port, '?t=wrong');
    await waitFor(() => c.closed !== null);
    expect(c.closed!.code).toBe(4401);
    expect(c.msgs).toEqual([]);
  });

  it('closes a connection without a token with code 4401', async () => {
    const s = await boot();
    const c = connect(s.port, '');
    await waitFor(() => c.closed !== null);
    expect(c.closed!.code).toBe(4401);
  });

  it('sends hello with every model file', async () => {
    const s = await boot();
    const c = connect(s.port, `?t=${s.token}`);
    await waitFor(() => c.msgs.length >= 1);
    const hello = c.msgs[0];
    expect(hello.type).toBe('hello');
    if (hello.type !== 'hello') return;
    expect(hello.files.map(f => f.path)).toEqual(model.all().map(f => f.path));
    expect(hello.indexing).toBe(false);
    expect(hello.root).toBe(root);
    expect(hello.name).toBe(path.basename(root));
    expect(hello.changes).toEqual([]);
    expect(hello.usedBy).toEqual([{ file: 'src/b.ts', symbol: 'b', usedIn: ['src/a.ts'] }]);
    expect(JSON.stringify(hello)).not.toContain('supersecretvalue');
  });

  it('accepts the lm_token cookie', async () => {
    const s = await boot();
    const c = connect(s.port, '', { cookie: `lm_token_${s.port}=${s.token}` });
    await waitFor(() => c.msgs.length >= 1);
    expect(c.msgs[0].type).toBe('hello');
  });

  it('rejects a cross-origin Origin and a foreign Host', async () => {
    const s = await boot();
    const bad = connect(s.port, `?t=${s.token}`, { origin: 'http://evil.example' });
    await waitFor(() => bad.rejected !== null || bad.closed !== null);
    expect(bad.rejected).toBe(403);
    expect(bad.msgs).toEqual([]);
    const host = connect(s.port, `?t=${s.token}`, { host: 'evil.example' });
    await waitFor(() => host.rejected !== null || host.closed !== null);
    expect(host.rejected).toBe(403);
    const same = connect(s.port, `?t=${s.token}`, { origin: `http://127.0.0.1:${s.port}` });
    await waitFor(() => same.msgs.length >= 1);
    expect(same.msgs[0].type).toBe('hello');
  });

  it('broadcasts change and files within 1 s of a write, then a throttled usedBy', async () => {
    const s = await boot();
    const c = connect(s.port, `?t=${s.token}`);
    await waitFor(() => c.msgs.length >= 1);
    const t0 = Date.now();
    put(root, 'src/c.ts', 'import { b } from "./b";\nexport const c = b * 2;\n');
    await waitFor(() => ofType(c, 'change').length >= 1, 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    const change = ofType(c, 'change')[0].change;
    expect(change).toMatchObject({ path: 'src/c.ts', kind: 'created' });
    await waitFor(() => ofType(c, 'files').length >= 1);
    const files = ofType(c, 'files')[0];
    expect(files.files.map(f => f.path)).toContain('src/c.ts');
    expect(files.removed).toEqual([]);
    const iChange = c.msgs.findIndex(m => m.type === 'change');
    const iFiles = c.msgs.findIndex(m => m.type === 'files');
    expect(iChange).toBeLessThan(iFiles);
    await waitFor(() => ofType(c, 'usedBy').some(m => m.usedBy.some(e => e.file === 'src/b.ts' && e.usedIn.includes('src/c.ts'))), 3000);
  });

  it('reports deletions as removed paths and keeps changes for later hellos', async () => {
    const s = await boot();
    const c = connect(s.port, `?t=${s.token}`);
    await waitFor(() => c.msgs.length >= 1);
    fs.rmSync(path.join(root, 'src/a.ts'));
    await waitFor(() => ofType(c, 'files').some(m => m.removed.includes('src/a.ts')));
    const late = connect(s.port, `?t=${s.token}`);
    await waitFor(() => late.msgs.length >= 1);
    const hello = late.msgs[0];
    if (hello.type !== 'hello') throw new Error('expected hello');
    expect(hello.changes.map(ch => [ch.path, ch.kind])).toEqual([['src/a.ts', 'deleted']]);
    expect(hello.files.map(f => f.path)).not.toContain('src/a.ts');
  });

  it('throttles usedBy to at most once per second', async () => {
    const s = await boot();
    const c = connect(s.port, `?t=${s.token}`);
    await waitFor(() => c.msgs.length >= 1);
    for (let i = 0; i < 4; i++) {
      put(root, `src/n${i}.ts`, `import { b } from "./b";\nexport const n${i} = b;\n`);
      await waitFor(() => ofType(c, 'change').length >= i + 1);
    }
    await waitFor(() => ofType(c, 'usedBy').some(m => m.usedBy.some(e => e.file === 'src/b.ts' && e.usedIn.includes('src/n3.ts'))), 4000);
    const stamps = c.msgs.map((m, i) => (m.type === 'usedBy' ? c.times[i] : -1)).filter(t => t >= 0);
    expect(stamps.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(950);
  });

  it('sends indexing progress before ready() and hello to connected clients on ready()', async () => {
    model = new ProjectModel(root);
    watcher = new Watcher(model, { debounceMs: 30 });
    srv = await startServer({ model, watcher, port: 0, uiDir });
    const early = connect(srv.port, `?t=${srv.token}`);
    await waitFor(() => early.msgs.length >= 1);
    expect(early.msgs[0]).toEqual({ type: 'indexing', done: 0, total: 0 });
    await model.scan((d, t) => srv!.setIndexing(d, t));
    await waitFor(() => ofType(early, 'indexing').some(m => m.done === m.total && m.total > 0));
    const mid = connect(srv.port, `?t=${srv.token}`);
    await waitFor(() => mid.msgs.length >= 1);
    expect(mid.msgs[0].type).toBe('indexing');
    expect(ofType(early, 'hello')).toEqual([]);
    await watcher.start();
    srv.ready();
    await waitFor(() => ofType(early, 'hello').length === 1 && ofType(mid, 'hello').length === 1);
    expect(ofType(early, 'hello')[0].indexing).toBe(false);
    expect(ofType(early, 'hello')[0].files.length).toBe(model.all().length);
  });
});

describe('safeSend backpressure', () => {
  function fake(bufferedAmount: number) {
    const f = { readyState: WebSocket.OPEN, bufferedAmount, sent: [] as string[], terminated: false,
      send(t: string) { f.sent.push(t); }, terminate() { f.terminated = true; } };
    return f;
  }
  it('sends to a healthy client', () => {
    const f = fake(0);
    safeSend(f as unknown as WebSocket, 'x');
    expect(f.sent).toEqual(['x']);
    expect(f.terminated).toBe(false);
  });
  it('terminates a client with more than 8 MB buffered instead of sending', () => {
    expect(MAX_BUFFERED_BYTES).toBe(8 * 1024 * 1024);
    const f = fake(MAX_BUFFERED_BYTES + 1);
    safeSend(f as unknown as WebSocket, 'x');
    expect(f.sent).toEqual([]);
    expect(f.terminated).toBe(true);
  });
});
