import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProjectModel } from '../engine/project.js';
import type { Watcher } from '../engine/watcher.js';
import type { AgentHub } from '../agents/hub.js';
import type { Attributor } from '../agents/attribution.js';
import { buildUsedBy } from '../engine/usedby.js';
import { buildDomainIndex } from '../engine/domain/build-index.js';
import type { DomainIndex } from '../shared/domain.js';
import type { ServerMessage, UsedByEntry } from '../shared/protocol.js';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary, ControlState, FileModel } from '../shared/types.js';
import { authenticate, hostAllowed, newToken, originAllowed, sessionCookie } from './auth.js';
import { handleControlApi, handleHook } from './agent-routes.js';
import { serveStatic } from './static.js';

export interface ServerOptions {
  model: ProjectModel;
  watcher: Watcher;
  /** First port to try (default 4317); 0 lets the OS choose. */
  port?: number;
  uiDir: string;
  token?: string;
  /** Agent activity. Without it the agent routes answer 503 and hello carries empty agent fields. */
  hub?: AgentHub;
  /** Links file changes to agent actions; changes go out unattributed without it. */
  attributor?: Attributor;
  /** Domain index builder; tests inject a failing one. */
  buildDomain?: typeof buildDomainIndex;
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
const HELLO_EVENTS = 500;
const USED_BY_INTERVAL_MS = 1000;
const DOMAIN_INTERVAL_MS = 1000;
const EMPTY_DOMAIN: DomainIndex = {
  routes: [], tables: [], dataRefs: [], stack: [], deps: [], scripts: [], env: [],
  counts: { routes: 0, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 },
};
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
export const UNAUTHORIZED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiveMap</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef0f5;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center;background:#fff;border-radius:28px;padding:32px 28px;box-shadow:0 2px 4px rgba(0,0,0,.04),0 20px 50px rgba(17,24,39,.13)}
i{display:block;width:48px;height:48px;border-radius:15px;margin:0 auto 16px;background:conic-gradient(from 210deg,#0a7cff,#a64df0,#f0287a,#ff8a00,#0a7cff)}
h1{margin:0 0 8px;font-size:24px;letter-spacing:-.02em}
p{margin:0;color:#55595f;text-wrap:balance}
@media (prefers-color-scheme:dark){body{background:#0b0d13;color:#f2f3f7}main{background:#1a1e2a;box-shadow:0 20px 60px rgba(0,0,0,.5)}p{color:#b4b9c4}}
</style></head>
<body><main><i aria-hidden="true"></i><h1>LiveMap</h1><p>Open the link printed in your terminal. It includes a one-time key.</p></main></body></html>
`;

function unauthorizedPage(res: http.ServerResponse): void {
  res.writeHead(401, {
    ...BASE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(UNAUTHORIZED_PAGE)),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(UNAUTHORIZED_PAGE);
}

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
  const { model, watcher, uiDir, hub, attributor, buildDomain = buildDomainIndex } = opts;
  const token = opts.token ?? newToken();
  const name = path.basename(model.root);

  let port = 0; // set once bound; no request can arrive before that
  let isReady = false;
  let indexing = { done: 0, total: 0 };
  let lastIndexingSent = 0;
  const changes: ChangeSummary[] = [];
  let usedBy: UsedByEntry[] = [];
  let usedByAt = 0;
  let usedByTimer: NodeJS.Timeout | null = null;
  let domain: DomainIndex = EMPTY_DOMAIN;
  let domainJson = JSON.stringify(EMPTY_DOMAIN);
  const domainErrors = new Set<string>();
  let domainAt = 0;
  let domainTimer: NodeJS.Timeout | null = null;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const send = (ws: WebSocket, msg: ServerMessage): void => safeSend(ws, JSON.stringify(msg));
  const broadcastText = (text: string): void => {
    for (const ws of wss.clients) safeSend(ws, text);
  };
  const broadcast = (msg: ServerMessage): void => {
    if (wss.clients.size === 0) return;
    broadcastText(JSON.stringify(msg));
  };
  const hello = (): ServerMessage => ({
    type: 'hello', root: model.root, name, files: model.all(), changes: [...changes], usedBy, domain, indexing: false,
    events: hub ? hub.events(HELLO_EVENTS) : [], sessions: hub ? hub.sessions() : [], control: hub ? hub.control.state() : { paused: false, flags: [] },
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

  /**
   * Rebuilds the domain index; true when it differs from the last one (by JSON). A failing build keeps the
   * last good index and logs each distinct error once.
   */
  const computeDomain = (): boolean => {
    domainAt = Date.now();
    let next: DomainIndex;
    try {
      next = buildDomain(model.all(), p => model.content(p));
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (!domainErrors.has(msg)) {
        domainErrors.add(msg);
        process.stderr.write(`livemap: domain index failed: ${msg}\n`);
      }
      return false;
    }
    const text = JSON.stringify(next);
    if (text === domainJson) return false;
    domain = next;
    domainJson = text;
    return true;
  };
  // Rebuilt only in this trailing timer, never in the change handler, so saves are not held up.
  const scheduleDomain = (): void => {
    if (domainTimer) return;
    const wait = Math.max(0, domainAt + DOMAIN_INTERVAL_MS - Date.now());
    domainTimer = setTimeout(() => {
      domainTimer = null;
      // The index is sent from the JSON already built for the comparison.
      if (computeDomain() && wss.clients.size) broadcastText(`{"type":"domain","domain":${domainJson}}`);
    }, wait);
  };

  const onChange = (change: ChangeSummary, touched: FileModel[]): void => {
    if (attributor) {
      try {
        const attribution = attributor.attribute(change);
        if (attribution) change = { ...change, attribution };
      } catch { /* attribution is best effort */ }
    }
    changes.push(change);
    if (changes.length > MAX_CHANGES) changes.splice(0, changes.length - MAX_CHANGES);
    if (!isReady) return; // hello will carry the state
    const own = model.get(change.path);
    const files = own ? [own, ...touched.filter(f => f.path !== own.path)] : touched;
    broadcast({ type: 'change', change });
    broadcast({ type: 'files', files, removed: change.kind === 'deleted' ? [change.path] : [] });
    scheduleUsedBy();
    scheduleDomain();
  };
  watcher.on('change', onChange);

  // Before ready(), hello carries the agent state, so live agent messages wait for it.
  const onEvent = (event: AgentEvent): void => { if (isReady) broadcast({ type: 'agentEvent', event }); };
  const onSession = (session: AgentSession): void => { if (isReady) broadcast({ type: 'session', session }); };
  const onControl = (control: ControlState): void => { if (isReady) broadcast({ type: 'control', control }); };
  const onLate = (changeId: number, attribution: Attribution): void => {
    const i = changes.findIndex(c => c.id === changeId);
    if (i !== -1) changes[i] = { ...changes[i], attribution };
    if (isReady) broadcast({ type: 'attribution', changeId, attribution });
  };
  hub?.on('event', onEvent);
  hub?.on('session', onSession);
  hub?.control.on('change', onControl);
  attributor?.on('late', onLate);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!hostAllowed(req)) return json(res, 403, { error: 'forbidden host' });
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
    const reply = (status: number, body: unknown, extra?: Record<string, string>) => json(res, status, body, extra);
    if (url.pathname === '/hook') return handleHook(req, res, reply, token, hub);
    const source = authenticate(req, url, token, port);
    if (!source) {
      if (isApiPath(url.pathname)) return json(res, 401, { error: 'unauthorized' });
      return unauthorizedPage(res);
    }
    if (await handleControlApi(req, res, reply, url.pathname, hub, originAllowed(req))) return;
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

    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (source !== 'cookie') headers['set-cookie'] = sessionCookie(token, port);
    await serveStatic(uiDir, url.pathname, res, headers);
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
    const authed = authenticate(req, url, token, port) !== null;
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      if (!authed) {
        ws.close(WS_UNAUTHORIZED, 'unauthorized');
        return;
      }
      send(ws, isReady ? hello() : { type: 'indexing', ...indexing });
    });
  });


  port = await bind(server, opts.port ?? DEFAULT_PORT);

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
      computeDomain();
      isReady = true;
      broadcast(hello());
    },
    async close(): Promise<void> {
      watcher.off('change', onChange);
      hub?.off('event', onEvent);
      hub?.off('session', onSession);
      hub?.control.off('change', onControl);
      attributor?.off('late', onLate);
      if (usedByTimer) clearTimeout(usedByTimer);
      usedByTimer = null;
      if (domainTimer) clearTimeout(domainTimer);
      domainTimer = null;
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
