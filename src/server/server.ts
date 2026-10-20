import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { ProjectModel } from '../engine/project.js';
import type { Watcher } from '../engine/watcher.js';
import type { AgentHub } from '../agents/hub.js';
import type { Attributor } from '../agents/attribution.js';
import { buildUsedBy, type TokenCache } from '../engine/usedby.js';
import { buildDomainIndex, newDataRefCache } from '../engine/domain/build-index.js';
import type { DomainIndex } from '../shared/domain.js';
import type { HistoryStatus, ServerMessage, UsedByEntry } from '../shared/protocol.js';
import type { ProjectState } from '../shared/state.js';
import { RECORDED_TYPES, type HistoryStore } from '../history/store.js';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary, CodeSymbol, ControlState, FileModel } from '../shared/types.js';
import { offStatus, type FileSummary, type SummariesState, type SummaryStatus } from '../shared/summaries.js';
import { changeQualifies } from '../summarize/summarizer.js';
import { buildAskContext, MAX_QUESTION } from '../summarize/ask.js';
import { LOCK_PATH } from '../lock.js';
import { authenticate, hostAllowed, newToken, originAllowed } from './auth.js';
import { handleControlApi, handleHook, MAX_API_BODY, readJsonBody } from './agent-routes.js';
import { handleHistoryApi, sendJsonMaybeGzip } from './history-routes.js';
import { serveStatic } from './static.js';
import { isSnMirror, readSnIndex } from './sn-index.js';

export interface ServerOptions {
  /** The project name the UI shows; the root folder's name by default. */
  name?: string;
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
  /** Records every broadcast data message; without it nothing is recorded and the history routes answer 404. */
  history?: HistoryStore;
  /** Writes AI summaries of files and changes. Without it summaries are off and `/api/summary` answers 503. */
  summarizer?: SummaryEngine;
  /** The project lock's id, answered at `/__livemap/lock` so a later start can tell this LiveMap is alive. */
  lockId?: () => string | undefined;
}

/** What the server uses of a summarizer (`src/summarize/summarizer.ts`); tests inject a fake. */
export interface SummaryEngine {
  status(): SummaryStatus;
  summarizeFile(file: FileModel, text: string): Promise<string | null>;
  summarizeChange(change: ChangeSummary, file: FileModel | null): Promise<string | null>;
  /** Answers a question about the project from a context string (see src/summarize/ask.ts). */
  ask?(question: string, context: string): Promise<{ answer: string } | { error: string }>;
  on(event: 'status', listener: (status: SummaryStatus) => void): unknown;
  off(event: 'status', listener: (status: SummaryStatus) => void): unknown;
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
/** A `history` status goes out at most this often while recording. */
const HISTORY_STATUS_INTERVAL_MS = 5000;
/** No store: history was turned off (`--no-history`), which the UI words differently from a failure. */
const NO_HISTORY: HistoryStatus = { enabled: false, first: 0, last: 0, firstAt: 0, lastAt: 0, off: true };
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

/** sha1 over a file's sorted `qname|signature` pairs, nested symbols included: its summary is redone when this changes. */
export function symbolSetHash(file: FileModel): string {
  const pairs: string[] = [];
  const walk = (syms: CodeSymbol[]): void => {
    for (const s of syms) {
      pairs.push(`${s.qname}|${s.signature}`);
      walk(s.children);
    }
  };
  walk(file.symbols);
  return crypto.createHash('sha1').update(pairs.sort().join('\n')).digest('hex');
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
  const { model, watcher, uiDir, hub, attributor, history, summarizer, buildDomain = buildDomainIndex } = opts;
  const token = opts.token ?? newToken();
  const name = opts.name ?? path.basename(model.root);

  let isReady = false;
  let indexing = { done: 0, total: 0 };
  let lastIndexingSent = 0;
  const changes: ChangeSummary[] = [];
  let usedBy: UsedByEntry[] = [];
  const dataRefCache = newDataRefCache();
  let usedByAt = 0;
  let usedByTimer: NodeJS.Timeout | null = null;
  let domain: DomainIndex = EMPTY_DOMAIN;
  let domainJson = JSON.stringify(EMPTY_DOMAIN);
  const domainErrors = new Set<string>();
  let domainAt = 0;
  let domainTimer: NodeJS.Timeout | null = null;
  const usedByTokens: TokenCache = new Map();
  /** The last recorded seq: what the live state (and so every hello) includes. */
  let seq = 0;
  let statusSent: HistoryStatus | null = null;
  let statusAt = 0;
  let statusTimer: NodeJS.Timeout | null = null;
  let closed = false;
  /** Set when the history store stopped itself after a write error. */
  let recordingFailed = false;
  /** File summaries by path, and the symbol-set hash of each summary being written. */
  const fileSummaries = new Map<string, FileSummary>();
  const fileJobs = new Map<string, string>();

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

  const historyStatus = (): HistoryStatus => {
    if (!history) return NO_HISTORY;
    const { enabled, first, last, firstAt, lastAt, error } = history.info();
    return error ? { enabled, first, last, firstAt, lastAt, error } : { enabled, first, last, firstAt, lastAt };
  };
  /** Broadcasts the status when it changed since the last one sent. */
  const sendStatus = (): void => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    const status = historyStatus();
    if (statusSent && status.last === statusSent.last && status.enabled === statusSent.enabled) return;
    statusSent = status;
    statusAt = Date.now();
    broadcast({ type: 'history', history: status });
  };
  const scheduleStatus = (): void => {
    if (statusTimer || !isReady) return;
    statusTimer = setTimeout(sendStatus, Math.max(0, statusAt + HISTORY_STATUS_INTERVAL_MS - Date.now()));
    statusTimer.unref?.();
  };
  if (history) {
    // Recording failed: the store already stopped itself; say so once and tell every client now.
    history.onError = (e: Error) => {
      recordingFailed = true;
      process.stderr.write(`livemap: history is unavailable: ${history.info().error ?? e.message}\n`);
      if (isReady) sendStatus();
    };
  }
  /**
   * Appends a recorded-type message (with its JSON when already built); other types are ignored by the store.
   * Returns the seq it was given, or -1 when it was not recorded.
   */
  const record = (msg: ServerMessage, text?: string): number => {
    if (!history) return -1;
    const s = history.append(msg, Date.now(), text);
    if (s > 0) {
      seq = s;
      scheduleStatus();
    } else if (recordingFailed && RECORDED_TYPES.has(msg.type)) {
      // Recording failed mid-run: keep stamping live messages with seqs past the last record, so a client
      // returning to live can still tell which buffered messages its fetched state already includes.
      return ++seq;
    }
    return s;
  };

  /**
   * Records a message from its JSON (recorded even when no client is connected, without the envelope
   * seq), then sends it. A recorded message goes out stamped with its seq (`WireMessage`), so a client
   * returning to live can tell which buffered messages its fetched state already includes. The seq is
   * spliced into the JSON, not re-serialized. Every broadcast of a recordable message goes through here.
   */
  const recordAndSend = (msg: ServerMessage, text: string): void => {
    const s = record(msg, text);
    if (!wss.clients.size) return;
    const out = s > 0 ? `${text.slice(0, -1)},"seq":${s}}` : text;
    broadcastText(out, helloBytesOf(msg, out)); // measured once, not per client
  };

  const broadcast = (msg: ServerMessage): void => {
    if (!history && wss.clients.size === 0) return;
    recordAndSend(msg, JSON.stringify(msg));
  };
  const summariesState = (): SummariesState => ({
    status: summarizer ? summarizer.status() : offStatus(new Date().toISOString().slice(0, 7)),
    files: Object.fromEntries(fileSummaries),
  });

  /**
   * A file's text as `/api/file` serves it, or the status and error to answer with. Secret, binary and
   * too-large files have no text here, so neither the UI nor the summarizer ever gets theirs.
   */
  const readText = (raw: string | null): { file: FileModel; content: string } | { status: number; error: string } => {
    const rel = safeRelPath(raw);
    if (!rel) return { status: 400, error: 'invalid path' };
    const file = model.get(rel);
    if (!file) return { status: 404, error: 'not found' };
    const content = file.flags.secret || file.flags.binary || file.flags.tooLarge ? null : model.content(rel);
    if (content === null) return { status: 403, error: 'content not available' };
    return { file, content };
  };

  /** Writes a file summary unless one for this symbol set is already being written; broadcasts it when done. */
  const summarizeFile = (file: FileModel, text: string): void => {
    if (!summarizer) return;
    const hash = symbolSetHash(file);
    if (fileJobs.get(file.path) === hash) return;
    fileJobs.set(file.path, hash);
    summarizer.summarizeFile(file, text).catch(() => null).then(summary => {
      if (fileJobs.get(file.path) === hash) fileJobs.delete(file.path);
      if (!summary || closed) return;
      // The file changed while this was written: a newer request covers it.
      const now = model.get(file.path);
      if (!now || symbolSetHash(now) !== hash) return;
      fileSummaries.set(file.path, { hash, summary });
      broadcast({ type: 'fileSummary', path: file.path, hash, summary });
    });
  };

  /** Drops a file's summary and tells clients (a recorded `fileSummary` with an empty hash). */
  const clearFileSummary = (path: string): void => {
    if (!fileSummaries.delete(path)) return;
    broadcast({ type: 'fileSummary', path, hash: '', summary: '' });
  };

  /**
   * After a change goes out: a one-line summary when it changed a symbol, route or entity. File summaries
   * are written only on request (`/api/summary`, for a file opened in the inspector): an outdated one is
   * withdrawn, and the inspector asks again; a request still being answered is redone for the new symbols.
   */
  const summarizeAfter = (change: ChangeSummary): void => {
    if (!summarizer) return;
    const file = model.get(change.path) ?? null;
    if (changeQualifies(change)) {
      summarizer.summarizeChange(change, file).catch(() => null).then(summary => {
        if (!summary || closed) return;
        const i = changes.findIndex(c => c.id === change.id);
        if (i !== -1) changes[i] = { ...changes[i], summary };
        broadcast({ type: 'summary', changeId: change.id, summary });
      });
    }
    if (change.kind === 'deleted' || !file) {
      clearFileSummary(change.path);
      return;
    }
    const hash = symbolSetHash(file);
    const have = fileSummaries.get(file.path)?.hash;
    // An outdated summary is withdrawn at once, so it never shows as current while (or if) a new one is written.
    if (have !== undefined && have !== hash) clearFileSummary(file.path);
    // Its answer would be dropped as outdated, leaving the request unanswered.
    const pending = fileJobs.get(file.path);
    if (pending === undefined || pending === hash) return;
    const r = readText(file.path);
    if ('content' in r) summarizeFile(r.file, r.content);
  };

  // A `livemap sn` mirror writes its manifests before the server starts.
  const sn = isSnMirror(model.root);
  const liveState = (): ProjectState => ({
    root: model.root, name, files: model.all(), changes: [...changes], usedBy, domain, indexing: false,
    events: hub ? hub.events(HELLO_EVENTS) : [], sessions: hub ? hub.sessions() : [], control: hub ? hub.control.state() : { paused: false, flags: [] },
    summaries: summariesState(),
    ...(sn ? { sn: true } : {}),
  });
  const hello = (state: ProjectState = liveState()): ServerMessage => ({ type: 'hello', ...state, history: historyStatus(), seq });
  /**
   * Starts a recording run from the live state (the run-start record carries it, without the hello's
   * recording fields) and returns the hello for it. The run is current once startRun returns its promise.
   * The run-start record's seq is assigned synchronously, so the hello's `seq` is that record's seq: the
   * hello goes out stamped like every other recorded broadcast (`WireMessage.seq` is the same field).
   */
  const startRun = (): ServerMessage => {
    const state = liveState();
    if (history) {
      history.startRun(state).catch(() => undefined); // failures surface through onError
      const status = history.info();
      if (status.enabled) seq = status.last;
    }
    return hello(state);
  };
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
      next = buildDomain(model.all(), p => model.content(p), dataRefCache);
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
      // The index is sent and recorded from the JSON already built for the comparison.
      if (!computeDomain()) return;
      const text = `{"type":"domain","domain":${domainJson}}`;
      recordAndSend({ type: 'domain', domain }, text);
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
    summarizeAfter(change);
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
    // The model was rebuilt from disk: a new run, so replay starts from the rebuilt state.
    broadcast(startRun());
  };
  watcher.on('reset', onReset);

  // Before ready(), hello carries the agent state, so live agent messages wait for it.
  // A batch (a transcript tailer's read) goes out as one message, so the UI updates once for it.
  // Attributions a batch's events trigger wait for the batch, so history keeps cause before effect.
  let afterBatch: ServerMessage[] = [];
  const onEvents = (events: AgentEvent[]): void => {
    if (isReady) broadcast(events.length === 1 ? { type: 'agentEvent', event: events[0] } : { type: 'agentEvents', events });
    if (hub?.batching) return; // an outer batch is still open
    const queued = afterBatch;
    afterBatch = [];
    if (isReady) for (const m of queued) broadcast(m);
  };
  const onSession = (session: AgentSession): void => { if (isReady) broadcast({ type: 'session', session }); };
  const onControl = (control: ControlState): void => { if (isReady) broadcast({ type: 'control', control }); };
  const onLate = (changeId: number, attribution: Attribution): void => {
    const i = changes.findIndex(c => c.id === changeId);
    if (i !== -1) changes[i] = { ...changes[i], attribution };
    if (!isReady) return;
    if (hub?.batching) afterBatch.push({ type: 'attribution', changeId, attribution });
    else broadcast({ type: 'attribution', changeId, attribution });
  };
  const onSummaryStatus = (status: SummaryStatus): void => { if (isReady && !closed) broadcast({ type: 'summaryStatus', status }); };
  summarizer?.on('status', onSummaryStatus);
  hub?.on('events', onEvents);
  hub?.on('session', onSession);
  hub?.control.on('change', onControl);
  attributor?.on('late', onLate);

  /**
   * `POST /api/ask` {question, path?}: answers a question about the project with the summary provider, from the
   * project map, the file's connections and the most relevant files' source (never secret, binary or too-large files).
   */
  const handleAsk = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    if (!originAllowed(req)) return json(res, 403, { error: 'forbidden origin' });
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'expected application/json' });
    const body = await readJsonBody(req, MAX_API_BODY);
    if (!body.ok) return json(res, body.status, { error: body.error });
    const v = body.value as { question?: unknown; path?: unknown } | null;
    const question = typeof v?.question === 'string' ? v.question.trim() : '';
    if (!question || question.length > MAX_QUESTION) return json(res, 400, { error: `expected {question} of 1 to ${MAX_QUESTION} characters` });
    if (!summarizer?.ask) return json(res, 503, { error: 'AI is off: enable summaries in ~/.livemap/config.json' });
    if (!isReady) return json(res, 503, { error: 'still indexing' });
    const focus = typeof v?.path === 'string' ? safeRelPath(v.path) ?? undefined : undefined;
    const context = buildAskContext({
      name, files: model.all(), usedBy, domain, changes, question, ...(focus ? { focus } : {}),
      content: p => { const r = readText(p); return 'content' in r ? r.content : null; },
    });
    const r = await summarizer.ask(question, context);
    if (closed) return;
    if ('error' in r) return json(res, 502, { error: r.error });
    return json(res, 200, { answer: r.answer });
  };

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
    // No token: the id is random and only says that this LiveMap still holds its project's lock.
    if (url.pathname === LOCK_PATH && req.method === 'GET') {
      const lock = opts.lockId?.();
      return lock ? json(res, 200, { lock }) : json(res, 404, { error: 'no lock' });
    }
    // The UI shell is static and holds no project data, so it loads without a token (a reload has
    // none in its URL); the page then sends the token it kept in sessionStorage with every request.
    if (isApiPath(url.pathname) && !authenticate(req, url, token)) return json(res, 401, { error: 'unauthorized' });
    if (await handleControlApi(req, res, reply, url.pathname, hub, originAllowed(req))) return;
    if (url.pathname === '/api/ask') return handleAsk(req, res);
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
    if (url.pathname === '/api/state') {
      if (!isReady) return json(res, 503, { error: 'indexing' });
      return sendJsonMaybeGzip(req, res, reply, hello(), BASE_HEADERS);
    }
    if (await handleHistoryApi(req, res, reply, url, history, BASE_HEADERS)) return;
    if (url.pathname === '/api/file') {
      const r = readText(url.searchParams.get('path'));
      if (!('content' in r)) return json(res, r.status, { error: r.error });
      return json(res, 200, { path: r.file.path, content: r.content });
    }
    if (url.pathname === '/api/sn') {
      // A `livemap sn` mirror's records (scope, update set, last update); 404 for any other project.
      const index = await readSnIndex(model.root, { warn: opts.warn });
      if (!index) return json(res, 404, { error: 'not a ServiceNow mirror' });
      const hosts = (process.env.LIVEMAP_SN_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean);
      return sendJsonMaybeGzip(req, res, reply, hosts.length ? { ...index, hosts } : index, BASE_HEADERS);
    }
    if (url.pathname === '/api/summary') {
      // The same checks as /api/file, so a secret, binary or too-large file is never sent.
      const r = readText(url.searchParams.get('path'));
      if (!('content' in r)) return json(res, r.status, { error: r.error });
      if (!summarizer) return json(res, 503, { error: 'summaries are off' });
      const have = fileSummaries.get(r.file.path);
      if (have && have.hash === symbolSetHash(r.file)) return json(res, 200, { summary: have.summary, hash: have.hash });
      summarizeFile(r.file, r.content);
      return json(res, 202, { pending: true });
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
      // The run starts before the first hello, so everything recorded after it builds on that hello's state.
      broadcast(startRun());
    },
    async close(): Promise<void> {
      closed = true;
      summarizer?.off('status', onSummaryStatus);
      watcher.off('change', onChange);
      hub?.off('events', onEvents);
      hub?.off('session', onSession);
      hub?.control.off('change', onControl);
      attributor?.off('late', onLate);
      watcher.off('touched', onTouched);
      watcher.off('reset', onReset);
      if (usedByTimer) clearTimeout(usedByTimer);
      usedByTimer = null;
      if (domainTimer) clearTimeout(domainTimer);
      domainTimer = null;
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = null;
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
