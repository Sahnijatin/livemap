/**
 * `livemap mcp-proxy`: a stdio MCP server that forwards every message to an upstream MCP server
 * (Streamable HTTP or stdio) and back as it came: no schema check, batches kept whole. On the side it times
 * each `tools/call` and hands a redacted capture event to LiveMap after the answer went out. The proxy
 * originates no tool call. It answers on its own only when it must: a line that is not JSON, a message too
 * large, or a request the upstream could not take. Over HTTP it also re-opens an expired upstream session
 * by replaying the client's own `initialize`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { argNames, buildCapture, MAX_PARSED_RESULT, needsResult, SessionContext, type CaptureEvent, type ClientInfo } from './capture.js';

export { MAX_PARSED_RESULT };
import { baseToolName } from '../shared/tools.js';

/** The MCP client name LiveMap's own nexus session carries (plugins/servicenow/nexus.ts). */
export const LIVEMAP_CLIENT_NAME = 'livemap';
/** nexus picks the instance from this header; its value is the instance name, kept as capture metadata. */
export const INSTANCE_HEADER = 'x-sn-instance';
/** One stdio message may not exceed this (a large query result can run to tens of MB). */
export const MAX_LINE = 256 * 1024 * 1024;
/** Calls the proxy is still timing; past this, the oldest is forgotten (its answer still passes through). */
const MAX_PENDING = 1000;
/** Default per-request timeout for an HTTP upstream: background scripts can run for minutes. */
export const DEFAULT_TIMEOUT_MS = 600_000;

type Msg = Record<string, unknown>;
const rec = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {});
const items = (m: unknown): Msg[] => (Array.isArray(m) ? m : [m]).filter((x): x is Msg => !!x && typeof x === 'object' && !Array.isArray(x));
const isRequest = (m: Msg) => typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const isResponse = (m: Msg) => m.method === undefined && m.id !== undefined && m.id !== null && ('result' in m || 'error' in m);
const idKey = (id: unknown) => `${typeof id}:${String(id)}`;

export interface Endpoint {
  /** One message as it came (an object, a batch array, or any JSON value), with its size in bytes. */
  onmessage?: (m: unknown, bytes: number) => void;
  onclose?: () => void;
  /** A line that could not be read (stdio endpoints only). */
  onBadLine?: (why: BadLine) => void;
  start(): Promise<void>;
  send(m: unknown): Promise<void>;
  close(): Promise<void>;
}

export type BadLine = 'parse' | 'size';

/**
 * Newline-delimited JSON over a pair of streams, as MCP's stdio transport defines it. Lines are parsed and
 * written as plain JSON with no schema check. A line that is not JSON, or longer than MAX_LINE, is reported
 * through `onBadLine` (the rest of an oversized line is skipped).
 */
export class LineEndpoint implements Endpoint {
  onmessage?: (m: unknown, bytes: number) => void;
  onclose?: () => void;
  onBadLine?: (why: BadLine) => void;
  private buf: Buffer[] = [];
  private size = 0;
  private skipping = false;
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly maxLine = MAX_LINE) {}

  async start(): Promise<void> {
    this.input.on('data', (chunk: Buffer | string) => this.data(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    this.input.once('end', () => this.end());
    this.input.once('close', () => this.end());
    this.input.on('error', () => this.end());
    this.output.on('error', () => this.end());
  }

  private data(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      if (this.skipping) {
        this.skipping = false;
      } else {
        const bytes = this.size + (i - start);
        if (bytes > this.maxLine) this.onBadLine?.('size');
        else {
          this.buf.push(chunk.subarray(start, i));
          const line = Buffer.concat(this.buf).toString('utf8').replace(/\r$/, '');
          if (line.trim()) this.line(line, bytes);
        }
      }
      this.buf = [];
      this.size = 0;
      start = i + 1;
    }
    if (start < chunk.length && !this.skipping) {
      this.buf.push(chunk.subarray(start));
      this.size += chunk.length - start;
      if (this.size > this.maxLine) {
        this.buf = [];
        this.size = 0;
        this.skipping = true;
        this.onBadLine?.('size');
      }
    }
  }

  private line(line: string, bytes: number): void {
    let m: unknown;
    try { m = JSON.parse(line); } catch { this.onBadLine?.('parse'); return; }
    this.onmessage?.(m, bytes);
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  send(m: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('closed'));
      this.output.write(`${JSON.stringify(m)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.end();
  }
}

/** The upstream answered with an HTTP error status. `body` is its text, which may hold a JSON-RPC error. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/** The upstream's answer ended without a response for every request in it. */
export class IncompleteAnswerError extends Error {
  constructor() {
    super('the upstream ended its answer without a response');
    this.name = 'IncompleteAnswerError';
  }
}

/** A failed send, with the ids of the responses that still reached the client before it failed. */
type SendError = Error & { delivered?: Set<string> };

/**
 * Streamable HTTP upstream, done with plain fetch so responses pass through as sent: JSON bodies and SSE
 * events are parsed as JSON only, never checked against a schema. Keeps the session id and protocol
 * version, opens the server's GET stream after `notifications/initialized`, and on a 404 for a stale
 * session replays the client's `initialize` under an internal id, then retries the message once.
 */
export class HttpEndpoint implements Endpoint {
  onmessage?: (m: unknown, bytes: number) => void;
  onclose?: () => void;
  sessionId?: string;
  protocolVersion?: string;
  private initParams?: unknown;
  private initId?: string;
  private reiniting?: Promise<void>;
  private reinits = 0;
  private stream?: AbortController;
  private readonly aborts = new Set<AbortController>();
  private closed = false;

  constructor(readonly url: URL, private readonly extra: Record<string, string>, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async start(): Promise<void> { /* connects on the first message */ }

  private headers(accept: string): Record<string, string> {
    return {
      ...this.extra,
      accept,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  async send(m: unknown): Promise<void> {
    for (const x of items(m)) {
      if (x.method === 'initialize' && isRequest(x)) { this.initParams = x.params; this.initId = idKey(x.id); }
    }
    await this.post(m, true, (msg, bytes) => this.deliver(msg, bytes));
  }

  /** Hands one upstream message on, noting the protocol version from the client's initialize response. */
  private deliver(m: unknown, bytes: number): void {
    for (const x of items(m)) {
      if (this.initId && isResponse(x) && idKey(x.id) === this.initId) {
        const v = rec(x.result).protocolVersion;
        if (typeof v === 'string') this.protocolVersion = v;
        this.initId = undefined;
      }
    }
    this.onmessage?.(m, bytes);
  }

  private timed(): { ac: AbortController; done: () => void } {
    const ac = new AbortController();
    this.aborts.add(ac);
    const timer = setTimeout(() => ac.abort(new Error(`no answer within ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs);
    timer.unref?.();
    return { ac, done: () => { clearTimeout(timer); this.aborts.delete(ac); } };
  }

  /** POSTs one message (or batch) and hands every message of the answer to `sink`. */
  private async post(m: unknown, mayRetry: boolean, sink: (msg: unknown, bytes: number) => void): Promise<void> {
    if (this.closed) throw new Error('closed');
    const requests = new Set(items(m).filter(isRequest).map((x) => idKey(x.id)));
    const delivered = new Set<string>();
    const track = (msg: unknown, bytes: number) => {
      for (const x of items(msg)) if (isResponse(x)) delivered.add(idKey(x.id));
      sink(msg, bytes);
    };
    const { ac, done } = this.timed();
    // The session this message went out on: a 404 for an old one means another request already re-opened it.
    const sentOn = this.sessionId;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { ...this.headers('application/json, text/event-stream'), 'content-type': 'application/json' },
        body: JSON.stringify(m),
        signal: ac.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      const stale = res.status === 404 && !!sentOn && !items(m).some((x) => x.method === 'initialize');
      if (stale && mayRetry && this.initParams !== undefined) {
        await res.body?.cancel().catch(() => {});
        done();
        if (this.reiniting) await this.reiniting;
        else if (this.sessionId === sentOn) await this.reinit();
        return await this.post(m, false, sink);
      }
      if (sid) this.sessionId = sid;
      if (!res.ok) throw new HttpStatusError(res.status, await res.text().catch(() => ''));
      if (res.status === 202 || !requests.size) {
        await res.body?.cancel().catch(() => {});
        if (items(m).some((x) => x.method === 'notifications/initialized')) this.openStream();
        return;
      }
      const type = res.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream')) await this.readSse(res, track, () => [...requests].every((id) => delivered.has(id)));
      else {
        const text = await res.text();
        if (text.trim()) {
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw new HttpStatusError(res.status, text); }
          track(parsed, Buffer.byteLength(text));
        }
      }
      // A stream or body that ended cleanly without an answer would leave the client waiting for ever.
      if ([...requests].some((id) => !delivered.has(id))) throw new IncompleteAnswerError();
    } catch (e) {
      // An answer that already reached the client stands; only the requests left unanswered fail.
      if ([...requests].every((id) => delivered.has(id)) && requests.size) return;
      const err = (e instanceof Error ? e : new Error(String(e))) as SendError;
      err.delivered = delivered;
      throw err;
    } finally {
      done();
    }
  }

  /** Reads an SSE body, handing each event's JSON to `sink`, until it ends or `enough()` says all answers came. */
  private async readSse(res: Response, sink: (msg: unknown, bytes: number) => void, enough: () => boolean = () => false): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const flush = (block: string) => {
      let event = 'message';
      const data: string[] = [];
      for (const raw of block.split(/\r?\n/)) {
        if (raw.startsWith(':')) continue;
        const at = raw.indexOf(':');
        const field = at < 0 ? raw : raw.slice(0, at);
        const value = at < 0 ? '' : raw.slice(at + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (event !== 'message' || !data.length) return;
      const text = data.join('\n');
      try { sink(JSON.parse(text), Buffer.byteLength(text)); } catch { /* not JSON: nothing to forward */ }
    };
    // Text since the last event is kept as chunks. Only each new chunk (with the 3 characters before it, a
    // separator may span chunks) is scanned for the blank line that ends an event, and the chunks are joined
    // once per event: a large event read in many chunks costs linear time.
    const sep = /\r?\n\r?\n/g;
    let parts: string[] = [];
    let tail = '';
    const take = (text: string) => {
      sep.lastIndex = 0;
      if (!sep.exec(tail + text)) {
        parts.push(text);
        tail = (tail + text).slice(-3);
        return;
      }
      let all = parts.join('') + text;
      parts = [];
      for (;;) {
        sep.lastIndex = 0;
        const cut = sep.exec(all);
        if (!cut) break;
        flush(all.slice(0, cut.index));
        all = all.slice(cut.index + cut[0].length);
      }
      if (all) parts.push(all);
      tail = all.slice(-3);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        take(dec.decode(value, { stream: true }));
        if (enough()) break;
      }
      buf = parts.join('');
      if (buf.trim()) flush(buf);
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** The server's GET stream for its own requests and notifications; reopened with backoff while the session lives. */
  private openStream(): void {
    if (this.closed || this.stream) return;
    const ac = new AbortController();
    this.stream = ac;
    let wait = 1000;
    const run = async () => {
      while (!this.closed && this.stream === ac) {
        try {
          const res = await fetch(this.url, { method: 'GET', headers: this.headers('text/event-stream'), signal: ac.signal });
          if (res.status === 405 || res.status === 404 || !res.ok) { await res.body?.cancel().catch(() => {}); break; }
          wait = 1000;
          await this.readSse(res, (msg, bytes) => this.deliver(msg, bytes));
        } catch { if (ac.signal.aborted) break; }
        if (this.closed || this.stream !== ac) break;
        await new Promise((r) => setTimeout(r, wait).unref?.());
        wait = Math.min(wait * 2, 30_000);
      }
      if (this.stream === ac) this.stream = undefined;
    };
    void run();
  }

  /** A new upstream session: the client's initialize replayed under an internal id, its answer kept here. */
  private reinit(): Promise<void> {
    this.reiniting ??= (async () => {
      // The old id is kept until the new session is open: if this fails, later requests still carry it, get
      // 404 again, and try again (without any id they would get 400 and never re-open).
      const old = this.sessionId;
      this.sessionId = undefined;
      this.stream?.abort();
      this.stream = undefined;
      const id = `livemap-proxy-reinit-${++this.reinits}`;
      try {
        await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: this.initParams }, false, (msg, bytes) => {
          const rest: Msg[] = [];
          for (const x of items(msg)) {
            if (isResponse(x) && x.id === id) {
              const v = rec(x.result).protocolVersion;
              if (typeof v === 'string') this.protocolVersion = v;
            } else rest.push(x);
          }
          // The server's own requests and notifications on this stream are the client's to answer.
          for (const x of rest) this.deliver(x, bytes);
        });
        if (!this.sessionId) throw new Error('the upstream gave no session id');
        await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false, (msg, bytes) => this.deliver(msg, bytes));
      } catch (e) {
        this.sessionId = old;
        throw e;
      }
    })().finally(() => { this.reiniting = undefined; });
    return this.reiniting;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream?.abort();
    for (const ac of this.aborts) ac.abort();
    if (!this.sessionId) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try { await fetch(this.url, { method: 'DELETE', headers: this.headers('application/json'), signal: ac.signal }); } catch { /* the session expires on its own */ }
    clearTimeout(timer);
  }
}

/** A stdio upstream: the command runs as a child; its stderr goes to the proxy's stderr. */
export class ChildEndpoint implements Endpoint {
  onmessage?: (m: unknown, bytes: number) => void;
  onclose?: () => void;
  private child?: ChildProcess;
  private lines?: LineEndpoint;
  exitCode: number | null = null;

  constructor(private readonly command: string, private readonly args: string[]) {}

  async start(): Promise<void> {
    // Windows runs `npx`, `livemap` and other bare names through .cmd shims, which need a shell; a full
    // path to an .exe does not, and must not get one (a shell would split it at its spaces).
    const shell = process.platform === 'win32' && needsShell(this.command);
    const child = shell
      ? spawn([escapeCmd(this.command), ...this.args.map(quoteForCmd)].join(' '), { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, shell: true })
      : spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.child = child;
    const lines = new LineEndpoint(child.stdout as Readable, child.stdin as Writable);
    this.lines = lines;
    lines.onmessage = (m, bytes) => this.onmessage?.(m, bytes);
    // 'close' comes after stdout has ended, so the child's last messages are not lost.
    child.once('close', (code) => { this.exitCode = code; this.onclose?.(); });
    child.once('error', (err) => {
      try { process.stderr.write(`livemap mcp-proxy: could not start ${this.command}: ${err.message}\n`); } catch { /* closed */ }
      this.exitCode = 1;
      this.onclose?.();
    });
    await lines.start();
  }

  send(m: unknown): Promise<void> {
    return this.lines ? this.lines.send(m) : Promise.reject(new Error('not started'));
  }

  async close(): Promise<void> {
    try { this.child?.stdin?.end(); } catch { /* already gone */ }
    const c = this.child;
    if (c && c.exitCode === null) setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 2000).unref();
  }
}

/** A bare command name or a .cmd/.bat script: on Windows it needs cmd.exe to run. */
export const needsShell = (cmd: string): boolean => /\.(cmd|bat)$/i.test(cmd) || (!/[\\/]/.test(cmd) && !/\.exe$/i.test(cmd));
/** Characters cmd.exe treats specially; each gets a `^` in front. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** A command name for cmd.exe: its special characters escaped. */
export const escapeCmd = (cmd: string): string => cmd.replace(CMD_META, '^$1');
/**
 * One argument for cmd.exe: quoted for the program's own argument parser (backslashes before quotes
 * doubled), then every special character escaped for cmd.exe, quotes included.
 */
export function quoteForCmd(a: string): string {
  const quoted = `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}

/** Splits a command line on spaces, keeping "double" or 'single' quoted parts together. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface ProxyOptions {
  client: Endpoint;
  upstream: Endpoint;
  /** Where capture events go; it must return at once. */
  capture: (e: CaptureEvent) => void;
  /** The instance this upstream serves (from its X-SN-Instance header), when known. */
  instance?: string;
  /** Text for the error the proxy answers with when the upstream cannot take a request. */
  upstreamName: string;
  sessionId?: string;
  now?: () => number;
  /** Debug lines: tool names and arg names only. */
  debug?: (line: string) => void;
}

interface Pending { name: string; args: unknown; start: number }

/** JSON-RPC codes the proxy answers with. -32000 is "the upstream could not be reached" (no HTTP status). */
export const UPSTREAM_UNREACHABLE = -32000;
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INTERNAL_ERROR = -32603;

/** The JSON-RPC error a failed send turns into: the upstream's own JSON-RPC error when its HTTP body holds one. */
export function errorFor(err: unknown, upstreamName: string): { code: number; message: string; data?: unknown } {
  if (err instanceof HttpStatusError) {
    try {
      const body = rec(JSON.parse(err.body));
      const e = rec(Array.isArray(body) ? body[0]?.error : body.error);
      if (typeof e.code === 'number' && typeof e.message === 'string') return e as { code: number; message: string };
    } catch { /* not JSON */ }
    return { code: INTERNAL_ERROR, message: `The upstream MCP server (${upstreamName}) answered HTTP ${err.status}` };
  }
  if (err instanceof IncompleteAnswerError) return { code: INTERNAL_ERROR, message: `The upstream MCP server (${upstreamName}) ended its answer without a response` };
  const why = err instanceof Error && err.message ? `: ${err.message.split('\n')[0].slice(0, 200)}` : '';
  return { code: UPSTREAM_UNREACHABLE, message: `The upstream MCP server (${upstreamName}) did not take the request${why}` };
}

/**
 * Wires a client endpoint to an upstream endpoint. Resolves when the client closes, or when a stdio
 * upstream exits. Messages are forwarded first; capture bookkeeping runs after, off the message path.
 */
export function runProxy(o: ProxyOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const sessionId = o.sessionId ?? `mcp:${process.pid}-${now().toString(36)}`;
  const ctx = new SessionContext(o.instance);
  const pending = new Map<string, Pending>();
  let clientInfo: ClientInfo | undefined;
  let own = false;

  const emit = (id: unknown, p: Pending, extra: { result?: unknown; rpcError?: unknown; cancelled?: boolean; skipResult?: boolean }) => {
    try {
      const ev = buildCapture({ ...(clientInfo ? { client: clientInfo } : {}), sessionId, callId: String(id), name: p.name, args: p.args, start: p.start, end: now(), own, ...extra }, ctx);
      o.debug?.(`${extra.cancelled ? 'cancelled' : 'done'} ${ev.innerTool ?? ev.tool} ok=${ev.ok}`);
      if (!own) o.capture(ev);
    } catch { /* capture must never affect the call */ }
  };

  const fromClient = (m: unknown) => {
    const end = now();
    const list = items(m);
    try {
      for (const x of list) {
        const method = typeof x.method === 'string' ? x.method : undefined;
        if (method === 'initialize' && isRequest(x)) {
          const ci = rec(rec(x.params).clientInfo);
          if (typeof ci.name === 'string') {
            clientInfo = { name: ci.name, ...(typeof ci.version === 'string' ? { version: ci.version } : {}) };
            own = ci.name === LIVEMAP_CLIENT_NAME;
          }
        } else if (method === 'tools/call' && isRequest(x)) {
          const p = rec(x.params);
          const name = typeof p.name === 'string' ? p.name : '';
          pending.set(idKey(x.id), { name, args: p.arguments ?? {}, start: end });
          if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
          o.debug?.(`call ${baseToolName(name)} args: ${argNames(p.arguments).join(', ')}`);
        } else if (method === 'notifications/cancelled') {
          const id = rec(x.params).requestId;
          const p = pending.get(idKey(id));
          if (p) { pending.delete(idKey(id)); setImmediate(() => emit(id, p, { cancelled: true })); }
        }
      }
    } catch { /* bookkeeping only */ }
    o.upstream.send(m).catch((err: SendError) => {
      const errors: Msg[] = [];
      for (const x of list) {
        if (!isRequest(x) || err?.delivered?.has(idKey(x.id))) continue;
        pending.delete(idKey(x.id));
        errors.push({ jsonrpc: '2.0', id: x.id, error: errorFor(err, o.upstreamName) });
      }
      if (!errors.length) return;
      // A batch is answered as one array, as JSON-RPC asks.
      o.client.send(Array.isArray(m) ? errors : errors[0]).catch(() => {});
    });
  };

  const fromUpstream = (m: unknown, bytes: number) => {
    o.client.send(m).catch(() => {});
    setImmediate(() => {
      try {
        for (const x of items(m)) {
          if (!isResponse(x)) continue;
          const p = pending.get(idKey(x.id));
          if (!p) continue;
          pending.delete(idKey(x.id));
          // Parse only what the capture needs: a write's new sys_ids, a context tool's answer, a small error's message.
          const failed = rec(x.result).isError === true;
          const skipResult = bytes > MAX_PARSED_RESULT || (!failed && !needsResult(p.name, p.args));
          emit(x.id, p, x.error !== undefined ? { rpcError: x.error } : { result: x.result, skipResult });
        }
      } catch { /* bookkeeping only */ }
    });
  };

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      void o.upstream.close().catch(() => {});
      void o.client.close().catch(() => {});
      resolve();
    };
    o.client.onmessage = fromClient;
    o.client.onBadLine = badLineReply(o.client);
    o.upstream.onmessage = fromUpstream;
    o.client.onclose = finish;
    // An HTTP upstream has no lasting connection to lose; only a stdio child that exits ends the proxy.
    if (!(o.upstream instanceof HttpEndpoint)) o.upstream.onclose = finish;
    o.upstream.start().then(() => o.client.start()).catch(finish);
  });
}

/** The client endpoint's bad-line handler: a JSON-RPC error with id null, as the spec says for an unreadable message. */
export function badLineReply(client: Endpoint): (why: BadLine) => void {
  return (why) => {
    const error = why === 'parse' ? { code: PARSE_ERROR, message: 'Parse error' } : { code: INVALID_REQUEST, message: `Invalid Request: message larger than ${MAX_LINE} bytes` };
    client.send({ jsonrpc: '2.0', id: null, error }).catch(() => {});
  };
}
