import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { startServer, type ServerOptions } from '../../src/server/server.js';
import { buildDomainIndex } from '../../src/engine/domain/build-index.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

type Started = Awaited<ReturnType<typeof startServer>>;

let root: string;
let uiDir: string;
let model: ProjectModel;
let watcher: Watcher;
let srv: Started | null;
let sockets: WebSocket[];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
function put(rel: string, data: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

interface Client { msgs: ServerMessage[]; times: number[] }
function connect(port: number, token: string): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
  sockets.push(ws);
  const c: Client = { msgs: [], times: [] };
  ws.on('message', d => { c.msgs.push(JSON.parse(String(d))); c.times.push(Date.now()); });
  ws.on('error', () => {});
  return c;
}
const ofType = <T extends ServerMessage['type']>(c: Client, t: T) =>
  c.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

async function boot(extra: Partial<ServerOptions> = {}): Promise<{ s: Started; c: Client }> {
  model = new ProjectModel(root);
  await model.scan();
  watcher = new Watcher(model, { debounceMs: 30 });
  await watcher.start();
  srv = await startServer({ model, watcher, port: 0, uiDir, ...extra });
  srv.ready();
  const c = connect(srv.port, srv.token);
  await waitFor(() => c.msgs.length >= 1);
  return { s: srv, c };
}

const ROUTER = (paths: string[]) => `import { Router } from 'express';\nconst router = Router();\n${paths.map(p => `router.get('${p}', (req, res) => res.json([]));`).join('\n')}\nexport default router;\n`;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-dom-')));
  uiDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-ui-')));
  put('package.json', JSON.stringify({ dependencies: { express: '^4.19.0' } }, null, 2));
  put('src/index.ts', "import express from 'express';\nimport orders from './routes/orders';\nconst app = express();\napp.use('/api', orders);\n");
  put('src/routes/orders.ts', ROUTER(['/orders']));
  put('src/b.ts', 'export const b = 1;\n');
  fs.writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>LiveMap</title>');
  srv = null;
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await srv?.close();
  await watcher?.stop();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(uiDir, { recursive: true, force: true });
});

describe('server: domain index', () => {
  it('sends the domain index in hello', async () => {
    const { c } = await boot();
    const hello = c.msgs[0];
    if (hello.type !== 'hello') throw new Error('expected hello');
    expect(hello.domain.routes.map(r => `${r.method} ${r.fullPath}`)).toEqual(['GET /api/orders']);
    expect(hello.domain.stack.map(t => t.id)).toContain('express');
  });

  it('broadcasts a domain message within 1.5 s of writing a new route file', async () => {
    const { c } = await boot();
    const t0 = Date.now();
    put('src/routes/users.ts', ROUTER(['/users']));
    await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.some(r => r.file === 'src/routes/users.ts')), 1500);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('throttles domain messages: two rapid edits give at most 2 in 1.5 s', async () => {
    const { c } = await boot();
    const t0 = Date.now();
    put('src/routes/orders.ts', ROUTER(['/orders', '/orders/:id']));
    put('src/routes/users.ts', ROUTER(['/users']));
    await waitFor(() => ofType(c, 'change').length >= 2);
    await sleep(Math.max(0, t0 + 1500 - Date.now()));
    const domains = ofType(c, 'domain');
    expect(domains.length).toBeGreaterThanOrEqual(1);
    expect(domains.length).toBeLessThanOrEqual(2);
    await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.some(r => r.fullPath === '/api/orders/:id')) && ofType(c, 'domain').some(m => m.domain.routes.some(r => r.file === 'src/routes/users.ts')));
  });

  it('sends no domain message when an edit leaves the index unchanged', async () => {
    const { c } = await boot();
    put('src/b.ts', 'export const b = 2;\n');
    await waitFor(() => ofType(c, 'change').length >= 1);
    await sleep(1300);
    expect(ofType(c, 'domain')).toEqual([]);
  });

  it('keeps the last good index when a rebuild throws, logging the error once', async () => {
    let fail = false;
    const buildDomain: typeof buildDomainIndex = (files, contents) => {
      if (fail) throw new Error('boom');
      return buildDomainIndex(files, contents);
    };
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { s, c } = await boot({ buildDomain });
      fail = true;
      put('src/routes/users.ts', ROUTER(['/users']));
      await waitFor(() => ofType(c, 'change').length >= 1);
      await sleep(1200);
      put('src/routes/items.ts', ROUTER(['/items']));
      await waitFor(() => ofType(c, 'change').length >= 2);
      await sleep(1200);
      expect(ofType(c, 'domain')).toEqual([]);
      expect(err.mock.calls.filter(a => String(a[0]).includes('domain index failed: boom'))).toHaveLength(1);
      const late = connect(s.port, s.token);
      await waitFor(() => late.msgs.length >= 1);
      const hello = late.msgs[0];
      if (hello.type !== 'hello') throw new Error('expected hello');
      expect(hello.domain.routes.map(r => r.fullPath)).toEqual(['/api/orders']);
      fail = false;
      put('src/b.ts', 'export const b = 3;\n');
      await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.some(r => r.file === 'src/routes/items.ts')), 2500);
    } finally {
      err.mockRestore();
    }
  });
});

describe('review fixes: domain refresh on touched and reset', () => {
  it('rebuilds the domain index after files arrive without a change (watcher "touched")', async () => {
    const { c } = await boot();
    await waitFor(() => ofType(c, 'hello').length >= 1);
    put('src/routes/extra.ts', ROUTER(['/extra']));
    await model.update('src/routes/extra.ts', 'add', { deferRelink: true }); // no change event goes out for it
    watcher.emit('touched', [model.get('src/routes/extra.ts')!], []);
    await waitFor(() => ofType(c, 'domain').some(m => m.domain.routes.some(r => r.path === '/extra')), 3000);
  });

  it('a reset sends a hello with a freshly built domain index', async () => {
    const { c } = await boot();
    await waitFor(() => ofType(c, 'hello').length >= 1);
    put('src/routes/late.ts', ROUTER(['/late']));
    await model.update('src/routes/late.ts', 'add', { deferRelink: true });
    watcher.emit('reset');
    await waitFor(() => ofType(c, 'hello').length >= 2);
    expect(ofType(c, 'hello')[1].domain.routes.some(r => r.path === '/late')).toBe(true);
  });
});

