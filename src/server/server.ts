import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProjectModel } from '../engine/project.js';
import type { Watcher } from '../engine/watcher.js';
import { buildUsedBy } from '../engine/usedby.js';
import type { ServerMessage, UsedByEntry } from '../shared/protocol.js';
import type { ChangeSummary, FileModel } from '../shared/types.js';
import { authenticate, hostAllowed, newToken, originAllowed } from './auth.js';
import { serveStatic } from './static.js';

export interface ServerOptions {
  model: ProjectModel;
  watcher: Watcher;
  /** First port to try (default 4317); 0 lets the OS choose. */
  port?: number;
  uiDir: string;
  token?: string;
}

export interface LiveMapServer {
  /** `http://127.0.0.1:<port>/?t=<token>` */
  url: string;
  port: number;
  token: string;
  server: http.Server;
  close(): Promise<void>;
  /** Indexing progress; broadcast (throttled) until ready() is called. */
  setIndexing(done: number, total: number): void;
  /** Indexing finished: send hello to every client, and to every client that connects later. */
  ready(): void;
}

const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4317;
/** A client this far behind is dropped rather than buffered without bound. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const PORT_TRIES = 20;
const MAX_CHANGES = 500;
const USED_BY_INTERVAL_MS = 1000;
const INDEXING_INTERVAL_MS = 100;
const WS_UNAUTHORIZED = 4401;

const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, ...extra, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

const isApiPath = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/');

/** Shown to a browser that opens LiveMap without the key: guidance only, never project data. */
/** A project-relative POSIX path, or null when it is empty, absolute or climbs out with `..`. */
export function safeRelPath(raw: string | null): string | null {
  if (raw === null) return null;
  const p = raw.replace(/\\/g, '/');
  if (p === '' || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const segs = p.split('/');
  if (segs.some(s => s === '..')) return null;
  const clean = segs.filter(s => s !== '' && s !== '.').join('/');
  return clean === '' ? null : clean;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function bind(server: http.Server, first: number): Promise<number> {
  if (first === 0) return listen(server, 0);
  const last = Math.min(first + PORT_TRIES, 65535);
  for (let port = first; ; port++) {
    try {
      return await listen(server, port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port >= last) throw e;
    }
  }
}

/** Sends unless the client is closed or too far behind, in which case it is terminated. */
export function safeSend(ws: WebSocket, text: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return;
  }
  ws.send(text);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(opts: ServerOptions): Promise<LiveMapServer> {
  const { model, watcher, uiDir } = opts;
  const token = opts.token ?? newToken();
  const name = path.basename(model.root);

  let isReady = false;
  let indexing = { done: 0, total: 0 };
  let lastIndexingSent = 0;
  const changes: ChangeSummary[] = [];
  let usedBy: UsedByEntry[] = [];
  let usedByAt = 0;
  let usedByTimer: NodeJS.Timeout | null = null;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const send = (ws: WebSocket, msg: ServerMessage): void => safeSend(ws, JSON.stringify(msg));
  const broadcast = (msg: ServerMessage): void => {
    if (wss.clients.size === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of wss.clients) safeSend(ws, text);
  };
  const hello = (): ServerMessage => ({
    type: 'hello', root: model.root, name, files: model.all(), changes: [...changes], usedBy, indexing: false,
  });
  const computeUsedBy = (): void => {
    usedByAt = Date.now();
    usedBy = buildUsedBy(model.all(), p => model.content(p));
  };
  const scheduleUsedBy = (): void => {
    if (usedByTimer) return;
    const wait = Math.max(0, usedByAt + USED_BY_INTERVAL_MS - Date.now());
    usedByTimer = setTimeout(() => {
      usedByTimer = null;
      computeUsedBy();
      broadcast({ type: 'usedBy', usedBy });
    }, wait);
  };

  const onChange = (change: ChangeSummary, touched: FileModel[]): void => {
    changes.push(change);
    if (changes.length > MAX_CHANGES) changes.splice(0, changes.length - MAX_CHANGES);
    if (!isReady) return; // hello will carry the state
    const own = model.get(change.path);
    const files = own ? [own, ...touched.filter(f => f.path !== own.path)] : touched;
    broadcast({ type: 'change', change });
    broadcast({ type: 'files', files, removed: change.kind === 'deleted' ? [change.path] : [] });
    scheduleUsedBy();
  };
  watcher.on('change', onChange);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' });
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    // The UI shell is static and holds no project data, so it loads without a token (a reload has
    // none in its URL); the page then sends the token it kept in sessionStorage with every request.
    if (isApiPath(url.pathname) && !authenticate(req, url, token)) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });

    if (url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/file') {
      const rel = safeRelPath(url.searchParams.get('path'));
      if (!rel) return json(res, 400, { error: 'invalid path' });
      const file = model.get(rel);
      if (!file) return json(res, 404, { error: 'not found' });
      const content = file.flags.secret || file.flags.binary || file.flags.tooLarge ? null : model.content(rel);
      if (content === null) return json(res, 403, { error: 'content not available' });
      return json(res, 200, { path: rel, content });
    }
    if (isApiPath(url.pathname)) return json(res, 404, { error: 'not found' });

    await serveStatic(uiDir, url.pathname, res, { ...BASE_HEADERS });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    if (!hostAllowed(req) || !originAllowed(req)) return reject(socket, 403, 'Forbidden');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
    const authed = authenticate(req, url, token);
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      if (!authed) {
        ws.close(WS_UNAUTHORIZED, 'unauthorized');
        return;
      }
      send(ws, isReady ? hello() : { type: 'indexing', ...indexing });
    });
  });


  const port = await bind(server, opts.port ?? DEFAULT_PORT);

  return {
    url: `http://${HOST}:${port}/?t=${token}`,
    port,
    token,
    server,
    setIndexing(done: number, total: number): void {
      indexing = { done, total };
      if (isReady) return;
      const now = Date.now();
      if (done < total && now - lastIndexingSent < INDEXING_INTERVAL_MS) return;
      lastIndexingSent = now;
      broadcast({ type: 'indexing', done, total });
    },
    ready(): void {
      if (isReady) return;
      computeUsedBy();
      isReady = true;
      broadcast(hello());
    },
    async close(): Promise<void> {
      watcher.off('change', onChange);
      if (usedByTimer) clearTimeout(usedByTimer);
      usedByTimer = null;
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
