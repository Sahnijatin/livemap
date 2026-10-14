import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProjectModel } from '../engine/project.js';
import type { Watcher } from '../engine/watcher.js';
import type { AgentHub } from '../agents/hub.js';
import type { Attributor } from '../agents/attribution.js';
import { buildUsedBy, type TokenCache } from '../engine/usedby.js';
import { buildDomainIndex } from '../engine/domain/build-index.js';
import type { DomainIndex } from '../shared/domain.js';
import type { ServerMessage, UsedByEntry } from '../shared/protocol.js';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary, ControlState, FileModel } from '../shared/types.js';
import { authenticate, hostAllowed, newToken, originAllowed } from './auth.js';
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
  /** Security warnings for the person running LiveMap (the CLI prints them to stderr). */
  warn?: (message: string) => void;
}

export interface LiveMapServer {
  /** `http://127.0.0.1:<port>/?t=<token>` */
  url: string;
  port: number;
  token: string;
  server: http.Server;
  /**
   * A URL for a browser opener: a single-use code (expires after LAUNCH_TTL_MS) that redirects to
   * `url`. Opener and browser arguments are readable by other local users, so the token never
   * goes there; a code read from them later is already spent. A local user who redeems it before
   * the browser does still wins that race, but the browser then hits a spent code and `warn` fires.
   */
  launchUrl(): string;
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
const REUSED_LINK = 'the browser launch link was used more than once. If you did not open it twice, stop LiveMap and start it again for a new key.';
/** How long a launch code from launchUrl() stays redeemable. */
export const LAUNCH_TTL_MS = 2 * 60_000;

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

/**
 * Sends unless the client is closed or too far behind, in which case it is terminated.
 * `allowance` is extra room for a snapshot (hello) the client may still be receiving, so a project
 * whose hello alone exceeds the limit does not get every client dropped on the next broadcast.
 */
export function safeSend(ws: WebSocket, text: string, allowance = 0): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES + allowance) {
    ws.terminate();
    return;
  }
  ws.send(text);
}

/**
 * safeSend with a per-client allowance for its last hello: set to the hello's byte size when one
 * is sent (`helloBytes`, null for other messages), then shrunk to the buffered amount on every
 * later send, so it lasts only while the hello can still be in the buffer.
 */
export function sendTracked(ws: WebSocket, text: string, helloBytes: number | null, allowances: WeakMap<WebSocket, number>): void {
  const allowance = helloBytes ?? Math.min(allowances.get(ws) ?? 0, ws.bufferedAmount);
  allowances.set(ws, allowance);
  safeSend(ws, text, allowance);
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function startServer(opts: ServerOptions): Promise<LiveMapServer> {
  const { model, watcher, uiDir, hub, attributor, buildDomain = buildDomainIndex } = opts;
  const token = opts.token ?? newToken();
  const name = path.basename(model.root);

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
  const usedByTokens: TokenCache = new Map();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  /** One-time launch codes (see launchUrl). */
  const launches = new Map<string, { expires: number; spent: boolean; warned: boolean }>();

  /** Room each client may still need for draining its last hello (see sendTracked). */
  const allowances = new WeakMap<WebSocket, number>();
  const helloBytesOf = (msg: ServerMessage, text: string): number | null => (msg.type === 'hello' ? Buffer.byteLength(text) : null);
  const send = (ws: WebSocket, msg: ServerMessage): void => {
    const text = JSON.stringify(msg);
    sendTracked(ws, text, helloBytesOf(msg, text), allowances);
  };
  const broadcastText = (text: string, helloBytes: number | null = null): void => {
    for (const ws of wss.clients) sendTracked(ws, text, helloBytes, allowances);
  };
  const broadcast = (msg: ServerMessage): void => {
    if (wss.clients.size === 0) return;
    const text = JSON.stringify(msg);
    broadcastText(text, helloBytesOf(msg, text)); // measured once, not per client
  };
  const hello = (): ServerMessage => ({
    type: 'hello', root: model.root, name, files: model.all(), changes: [...changes], usedBy, domain, indexing: false,
    events: hub ? hub.events(HELLO_EVENTS) : [], sessions: hub ? hub.sessions() : [], control: hub ? hub.control.state() : { paused: false, flags: [] },
  });
  const computeUsedBy = (): void => {
    usedByAt = Date.now();
    usedBy = buildUsedBy(model.all(), p => model.content(p), usedByTokens);
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
    broadcast({ type: 'change', change, files, removed: change.kind === 'deleted' ? [change.path] : [] });
    scheduleUsedBy();
    scheduleDomain();
  };
  watcher.on('change', onChange);
  const onTouched = (files: FileModel[], removed: string[] = []): void => {
    if (!isReady) return; // hello will carry the state
    broadcast({ type: 'files', files, removed });
    scheduleUsedBy();
    scheduleDomain(); // routes and tables can arrive this way (re-indexing, mounts resolving after a burst)
  };
  watcher.on('touched', onTouched);
  const onReset = (): void => {
    if (!isReady) return; // hello will carry the state
    computeUsedBy();
    computeDomain();
    broadcast(hello());
  };
  watcher.on('reset', onReset);

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
    // The UI shell is static and holds no project data, so it loads without a token (a reload has
    // none in its URL); the page then sends the token it kept in sessionStorage with every request.
    if (isApiPath(url.pathname) && !authenticate(req, url, token)) return json(res, 401, { error: 'unauthorized' });
    if (await handleControlApi(req, res, reply, url.pathname, hub, originAllowed(req))) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });

    // Only a real navigation spends a launch code: a HEAD, link check or browser prefetch/prerender
    // (Sec-Purpose, Purpose, Safari's X-Purpose, Firefox's X-Moz) must not lock the browser out. A prefetch gets a 503 so the
    // browser discards it and makes the real request when the page is actually opened.
    const launch = req.method === 'GET' && url.pathname === '/' ? url.searchParams.get('launch') : null;
    const entry = launch === null ? undefined : launches.get(launch);
    const h = req.headers;
    const purpose = `${h['sec-purpose'] ?? ''} ${h.purpose ?? ''} ${h['x-purpose'] ?? ''} ${h['x-moz'] ?? ''}`;
    if (entry && /prefetch|prerender|preview/i.test(purpose)) return json(res, 503, { error: 'not prefetchable' });
    if (entry && Date.now() > entry.expires) {
      launches.delete(launch!);
      if (!entry.spent) opts.warn?.('the browser launch link expired before it was opened. Open the URL printed above instead.');
      else if (!entry.warned) opts.warn?.(REUSED_LINK);
    } else if (entry && !entry.spent) {
      entry.spent = true; // kept until it expires, so a second use can be reported
      res.writeHead(302, { ...BASE_HEADERS, location: `/?t=${token}`, 'content-length': '0' });
      res.end();
      return;
    } else if (entry && !entry.warned) {
      entry.warned = true;
      opts.warn?.(REUSED_LINK);
    }

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
    launchUrl(): string {
      const now = Date.now();
      for (const [code, { expires }] of launches) if (expires < now) launches.delete(code);
      const code = newToken();
      launches.set(code, { expires: now + LAUNCH_TTL_MS, spent: false, warned: false });
      return `http://${HOST}:${port}/?launch=${code}`;
    },
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
      watcher.off('touched', onTouched);
      watcher.off('reset', onReset);
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
