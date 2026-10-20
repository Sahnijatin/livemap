/**
 * `livemap mcp-proxy`: a stdio MCP server that forwards every message to an upstream MCP server
 * (Streamable HTTP or stdio) and back, unchanged. On the side it times each `tools/call` and hands a
 * redacted capture event to LiveMap. The proxy never originates a request of its own, and nothing it does
 * for LiveMap can delay, change or fail a message.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { argNames, buildCapture, SessionContext, type CaptureEvent, type ClientInfo } from './capture.js';
import { baseToolName } from '../shared/tools.js';

/** The MCP client name LiveMap's own nexus session carries (plugins/servicenow/nexus.ts). */
export const LIVEMAP_CLIENT_NAME = 'livemap';
/** nexus picks the instance from this header; its value is the instance name, kept as capture metadata. */
export const INSTANCE_HEADER = 'x-sn-instance';
/** One stdio message may not exceed this (a large query result can run to tens of MB). */
const MAX_LINE = 256 * 1024 * 1024;
/** Calls the proxy is still timing; past this, the oldest is forgotten (its answer still passes through). */
const MAX_PENDING = 1000;

type Msg = Record<string, unknown>;
const rec = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {});

export interface Endpoint {
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(m: Msg): Promise<void>;
  close(): Promise<void>;
}

/**
 * Newline-delimited JSON over a pair of streams, as MCP's stdio transport defines it. Messages are parsed
 * and written as plain JSON with no schema check, so nothing is dropped or reshaped on the way through.
 */
export class LineEndpoint implements Endpoint {
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  private buf: Buffer[] = [];
  private size = 0;
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly onBadLine?: (why: string) => void) {}

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
      this.buf.push(chunk.subarray(start, i));
      const line = Buffer.concat(this.buf).toString('utf8').replace(/\r$/, '');
      this.buf = [];
      this.size = 0;
      start = i + 1;
      if (line.trim()) this.line(line);
    }
    if (start < chunk.length) {
      this.buf.push(chunk.subarray(start));
      this.size += chunk.length - start;
      if (this.size > MAX_LINE) { this.buf = []; this.size = 0; this.onBadLine?.('message too large'); }
    }
  }

  private line(line: string): void {
    let m: unknown;
    try { m = JSON.parse(line); } catch { this.onBadLine?.('not JSON'); return; }
    if (Array.isArray(m)) { for (const x of m) this.onmessage?.(rec(x)); return; }
    this.onmessage?.(rec(m));
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  send(m: Msg): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('closed'));
      this.output.write(`${JSON.stringify(m)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.end();
  }
}

/** Streamable HTTP upstream through the SDK transport (it handles sessions, SSE streams and resumption). */
export class HttpEndpoint implements Endpoint {
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  private readonly t: StreamableHTTPClientTransport;

  constructor(readonly url: URL, headers: Record<string, string>) {
    this.t = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    this.t.onmessage = (m) => this.onmessage?.(m as unknown as Msg);
    this.t.onclose = () => this.onclose?.();
    this.t.onerror = () => { /* each failed send rejects, and the proxy answers for it */ };
  }

  start(): Promise<void> { return this.t.start(); }
  send(m: Msg): Promise<void> { return this.t.send(m as unknown as JSONRPCMessage); }
  close(): Promise<void> { return this.t.close(); }
  /** The HTTP transport sends the negotiated version on every request after `initialize`. */
  setProtocolVersion(v: string): void { this.t.setProtocolVersion(v); }
}

/** A stdio upstream: the command runs as a child; its stderr goes to the proxy's stderr. */
export class ChildEndpoint implements Endpoint {
  onmessage?: (m: Msg) => void;
  onclose?: () => void;
  private child?: ChildProcess;
  private lines?: LineEndpoint;
  exitCode: number | null = null;

  constructor(private readonly command: string, private readonly args: string[]) {}

  async start(): Promise<void> {
    // Windows runs `npx`, `livemap` and other bare names through .cmd shims, which need a shell; a full
    // path to an .exe does not, and must not get one (a shell would split it at its spaces).
    const shell = process.platform === 'win32' && needsShell(this.command);
    const args = shell ? this.args.map(quoteForCmd) : this.args;
    const child = spawn(shell ? quoteForCmd(this.command) : this.command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, shell });
    this.child = child;
    const lines = new LineEndpoint(child.stdout as Readable, child.stdin as Writable);
    this.lines = lines;
    lines.onmessage = (m) => this.onmessage?.(m);
    child.once('exit', (code) => { this.exitCode = code; this.onclose?.(); });
    child.once('error', (err) => {
      try { process.stderr.write(`livemap mcp-proxy: could not start ${this.command}: ${err.message}\n`); } catch { /* closed */ }
      this.exitCode = 1;
      this.onclose?.();
    });
    await lines.start();
  }

  send(m: Msg): Promise<void> {
    return this.lines ? this.lines.send(m) : Promise.reject(new Error('not started'));
  }

  async close(): Promise<void> {
    try { this.child?.stdin?.end(); } catch { /* already gone */ }
    const c = this.child;
    if (c && c.exitCode === null) setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 2000).unref();
  }
}

/** A bare command name or a .cmd/.bat script: on Windows it needs cmd.exe to run. */
export const needsShell = (cmd: string): boolean => /\.(cmd|bat)$/i.test(cmd) || !/[\\/]/.test(cmd) && !/\.exe$/i.test(cmd);
/** Quotes an argument for cmd.exe when it has spaces or quotes. */
export const quoteForCmd = (a: string): string => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

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

/** Error code for "the upstream server could not be reached"; JSON-RPC reserves -32000 to -32099 for servers. */
export const UPSTREAM_UNREACHABLE = -32000;

/**
 * Wires a client endpoint to an upstream endpoint. Resolves when either side closes. Every message goes
 * through as it came; only a request the upstream cannot take is answered by the proxy, with an error, so
 * the client is not left waiting.
 */
export function runProxy(o: ProxyOptions): Promise<void> {
  const now = o.now ?? Date.now;
  const sessionId = o.sessionId ?? `mcp:${process.pid}-${now().toString(36)}`;
  const ctx = new SessionContext(o.instance);
  const pending = new Map<string, Pending>();
  let initId: string | undefined;
  let clientInfo: ClientInfo | undefined;
  let own = false;
  const key = (id: unknown) => `${typeof id}:${String(id)}`;

  const emit = (id: string, p: Pending, extra: { result?: unknown; rpcError?: unknown; cancelled?: boolean }) => {
    try {
      const ev = buildCapture({ ...(clientInfo ? { client: clientInfo } : {}), sessionId, callId: id, name: p.name, args: p.args, start: p.start, end: now(), own, ...extra }, ctx);
      o.debug?.(`${extra.cancelled ? 'cancelled' : 'done'} ${ev.innerTool ?? ev.tool} ok=${ev.ok}`);
      if (!own) o.capture(ev);
    } catch { /* capture must never affect the call */ }
  };

  const fromClient = (m: Msg) => {
    try {
      const method = typeof m.method === 'string' ? m.method : undefined;
      const hasId = m.id !== undefined && m.id !== null;
      if (method === 'initialize' && hasId) {
        initId = key(m.id);
        const ci = rec(rec(m.params).clientInfo);
        if (typeof ci.name === 'string') {
          clientInfo = { name: ci.name, ...(typeof ci.version === 'string' ? { version: ci.version } : {}) };
          own = ci.name === LIVEMAP_CLIENT_NAME;
        }
      } else if (method === 'tools/call' && hasId) {
        const p = rec(m.params);
        const name = typeof p.name === 'string' ? p.name : '';
        pending.set(key(m.id), { name, args: p.arguments ?? {}, start: now() });
        if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
        o.debug?.(`call ${baseToolName(name)} args: ${argNames(p.arguments).join(', ')}`);
      } else if (method === 'notifications/cancelled') {
        const id = rec(m.params).requestId;
        const k = key(id);
        const p = pending.get(k);
        if (p) { pending.delete(k); emit(String(id), p, { cancelled: true }); }
      }
    } catch { /* bookkeeping only */ }
    o.upstream.send(m).catch((err: unknown) => {
      if (m.method === undefined || m.id === undefined || m.id === null) return;
      pending.delete(key(m.id));
      const why = err instanceof Error && err.message ? `: ${err.message.split('\n')[0].slice(0, 200)}` : '';
      o.client.send({ jsonrpc: '2.0', id: m.id, error: { code: UPSTREAM_UNREACHABLE, message: `The upstream MCP server (${o.upstreamName}) did not take the request${why}` } }).catch(() => {});
    });
  };

  const fromUpstream = (m: Msg) => {
    try {
      const isResponse = m.method === undefined && m.id !== undefined && m.id !== null;
      if (isResponse) {
        const k = key(m.id);
        if (k === initId) {
          initId = undefined;
          const v = rec(m.result).protocolVersion;
          if (typeof v === 'string' && o.upstream instanceof HttpEndpoint) o.upstream.setProtocolVersion(v);
        }
        const p = pending.get(k);
        if (p) {
          pending.delete(k);
          emit(String(m.id), p, m.error !== undefined ? { rpcError: m.error } : { result: m.result });
        }
      }
    } catch { /* bookkeeping only */ }
    o.client.send(m).catch(() => {});
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
    o.upstream.onmessage = fromUpstream;
    o.client.onclose = finish;
    // An HTTP upstream has no lasting connection to lose; only a stdio child that exits ends the proxy.
    if (!(o.upstream instanceof HttpEndpoint)) o.upstream.onclose = finish;
    o.upstream.start().then(() => o.client.start()).catch(finish);
  });
}
