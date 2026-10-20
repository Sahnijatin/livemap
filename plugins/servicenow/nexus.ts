import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { assertReadOnly, GATEWAY, NotAllowedError } from './allowlist.js';

/** The nexus endpoint SkyForge documents; `--nexus` overrides it. */
export const DEFAULT_NEXUS_URL = 'http://127.0.0.1:3006/mcp';
/** nexus picks the instance from this header. */
export const INSTANCE_HEADER = 'X-SN-Instance';
/** The MCP client name LiveMap's own session carries, so attribution can exclude it. */
export const CLIENT_NAME = 'livemap';
/** `sn_query_table` caps `limit` at 10,000. */
const MAX_LIMIT = 10_000;

export type NexusState = 'idle' | 'online' | 'offline';
export type TransportKind = 'http' | 'sse';

export interface NexusOptions {
  url?: string;
  instance?: string;
  /** Which transports to try, in order. Default: Streamable HTTP, then SSE. */
  transports?: TransportKind[];
  /** Attempts per call before nexus counts as offline (default 3). */
  attempts?: number;
  /** First retry wait; it doubles each time (default 500 ms). */
  backoffMs?: number;
  /** Per-call timeout (default 120 s: a full scripted page can be slow). */
  timeoutMs?: number;
  version?: string;
  /** Test seam: called with each wait instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
}

export class NexusOfflineError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NexusOfflineError';
  }
}

/** A tool answered with `success: false` or an MCP error result. Not retried: the same call would fail again. */
export class NexusToolError extends Error {
  constructor(readonly tool: string, message: string) {
    super(`${tool}: ${message}`);
    this.name = 'NexusToolError';
  }
}

/** A call or query ran out of the time its caller gave it. */
export class NexusDeadlineError extends Error {
  constructor(readonly tool: string) {
    super(`${tool}: out of time`);
    this.name = 'NexusDeadlineError';
  }
}

/** A point in time (epoch ms by `now`, default Date.now) after which no call starts or keeps waiting. */
export interface Deadline { at: number; now?: () => number }

export interface QueryOptions {
  query?: string;
  fields?: string[];
  /** Records per page (default 200). */
  pageSize?: number;
  orderBy?: string;
  /** Stop after this many records (default: all). */
  max?: number;
  /** Checked before each page; each page's timeout is capped at the time left. */
  deadline?: Deadline;
}

/** A record as LiveMap uses it: every field a string, after `flattenRecord`. */
export type SnRecord = Record<string, string>;
interface QueryPage { records: unknown[]; has_more?: boolean; count?: number; total?: number | string }

/**
 * One field as a string. Real nexus returns reference fields as `{link, value}` even with
 * `display_value:false` (`sys_scope`, `operation`, `type`, ...); those become their `value`. null and
 * undefined become '', numbers and booleans their text, and any other non-string its JSON.
 */
export function flattenValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && !Array.isArray(v) && 'value' in v) return flattenValue((v as { value: unknown }).value);
  return JSON.stringify(v);
}

/** A record from nexus with every field flattened to a string (see `flattenValue`). */
export function flattenRecord(r: unknown): SnRecord {
  const out: SnRecord = {};
  if (r && typeof r === 'object' && !Array.isArray(r)) for (const [k, v] of Object.entries(r)) out[k] = flattenValue(v);
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The JSON a nexus tool returned. Tool results are MCP text content holding JSON, either the tool's own
 * `{success, data}` or, through `tool_execute`, `{success, tool, result: {success, data}}`.
 */
export function unwrapResult(tool: string, result: unknown): unknown {
  const r = isObj(result) ? result : {};
  const texts = Array.isArray(r.content) ? r.content.filter((c): c is { type: 'text'; text: string } => isObj(c) && c.type === 'text' && typeof c.text === 'string') : [];
  const text = texts.map(t => t.text).join('');
  if (r.isError) throw new NexusToolError(tool, text.slice(0, 500) || 'error');
  let body: unknown = r.structuredContent ?? text;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return body; }
  }
  if (isObj(body) && isObj(body.result) && 'tool' in body) body = body.result;
  if (isObj(body) && body.success === false) {
    const msg = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : 'request failed';
    throw new NexusToolError(tool, msg);
  }
  return body;
}

/** A tool that `tool_execute` refused because nexus has not enabled it yet (tool_search enables it). */
const NOT_ENABLED = /not (?:found|enabled|loaded|available)|unknown tool|tool_search/i;

/**
 * LiveMap's read-only client of SkyForge's nexus MCP. Every call passes the allowlist first. Connects over
 * Streamable HTTP and falls back to SSE. A call is retried with backoff; when every attempt fails, the client
 * is offline until a later call reconnects.
 */
export class NexusClient {
  readonly url: string;
  readonly instance?: string;
  state: NexusState = 'idle';
  /** The transport that connected, once one has. */
  transport?: TransportKind;
  private client?: Client;
  private readonly transports: TransportKind[];
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly version: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly enabled = new Set<string>();

  constructor(opts: NexusOptions = {}) {
    this.url = opts.url ?? DEFAULT_NEXUS_URL;
    this.instance = opts.instance;
    this.transports = opts.transports ?? ['http', 'sse'];
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.backoffMs = opts.backoffMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.version = opts.version ?? '0.1.0';
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  private headers(): Record<string, string> {
    return this.instance ? { [INSTANCE_HEADER]: this.instance } : {};
  }

  private makeTransport(kind: TransportKind): Transport {
    const url = new URL(this.url);
    const requestInit = { headers: this.headers() };
    return kind === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit })
      : new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers ?? {}), ...this.headers() } }) } });
  }

  /** Connects with the first transport that works. Throws NexusOfflineError when none does. */
  async connect(): Promise<void> {
    if (this.client) return;
    const errors: string[] = [];
    for (const kind of this.transports) {
      const client = new Client({ name: CLIENT_NAME, version: this.version });
      try {
        await client.connect(this.makeTransport(kind), { timeout: this.timeoutMs });
        this.client = client;
        this.transport = kind;
        this.state = 'online';
        return;
      } catch (e) {
        errors.push(`${kind}: ${(e as Error)?.message ?? String(e)}`);
        await client.close().catch(() => {});
      }
    }
    this.state = 'offline';
    throw new NexusOfflineError(`nexus is not reachable at ${this.url} (${errors.join('; ')})`);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.enabled.clear();
    if (c) await c.close().catch(() => {});
  }

  /**
   * Calls one allowlisted tool and returns its parsed JSON. Transport failures are retried with backoff
   * (reconnecting); a tool's own error is not. After the last failed attempt the client is offline.
   */
  async call(tool: string, args: Obj = {}, deadline?: Deadline): Promise<unknown> {
    assertReadOnly(tool, args);
    const left = () => (deadline ? deadline.at - (deadline.now ?? Date.now)() : Infinity);
    let last: unknown;
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      if (left() <= 0) throw new NexusDeadlineError(tool);
      try {
        await this.connect();
        const res = await this.client!.callTool({ name: tool, arguments: args }, undefined, { timeout: Math.max(1, Math.min(this.timeoutMs, left())) });
        this.state = 'online';
        return unwrapResult(tool, res);
      } catch (e) {
        if (e instanceof NexusToolError || e instanceof NotAllowedError) throw e;
        last = e;
        await this.close();
        // A call cut short by the caller's deadline is not retried, and does not make nexus offline.
        if (left() <= 0) throw new NexusDeadlineError(tool);
      }
    }
    this.state = 'offline';
    throw new NexusOfflineError(`nexus did not answer ${tool} after ${this.attempts} attempts: ${(last as Error)?.message ?? String(last)}`, last);
  }

  /**
   * Runs an allowlisted tool through `tool_execute`. When nexus has not enabled the tool yet, it is found with
   * `tool_search` (which enables it) and the call is tried once more.
   */
  async execute(tool: string, args: Obj = {}, deadline?: Deadline): Promise<unknown> {
    try {
      return await this.call(GATEWAY, { tool, args }, deadline);
    } catch (e) {
      if (!(e instanceof NexusToolError) || this.enabled.has(tool) || !NOT_ENABLED.test(e.message)) throw e;
      this.enabled.add(tool);
      await this.call('tool_search', { query: tool, limit: 5 }, deadline);
      return this.call(GATEWAY, { tool, args }, deadline);
    }
  }

  /**
   * Every record of a `sn_query_table` query. Paging stops on a short page or when `has_more` is false: nexus
   * reports `has_more` whenever a page is full, even the last one, and its `total` can read "100+".
   */
  async query(table: string, opts: QueryOptions = {}): Promise<SnRecord[]> {
    const out: SnRecord[] = [];
    for await (const page of this.pages(table, opts)) out.push(...page);
    return out;
  }

  /** The pages of a `sn_query_table` query, one array per call. */
  async *pages(table: string, opts: QueryOptions = {}): AsyncGenerator<SnRecord[]> {
    const size = Math.min(MAX_LIMIT, Math.max(1, opts.pageSize ?? 200));
    let offset = 0;
    for (;;) {
      const limit = opts.max === undefined ? size : Math.min(size, opts.max - offset);
      if (limit <= 0) return;
      const args: Obj = { table, limit, offset, truncate_output: false, display_value: false };
      if (opts.query) args.query = opts.query;
      if (opts.fields?.length) args.fields = opts.fields;
      if (opts.orderBy) args.order_by = opts.orderBy;
      if (opts.deadline && opts.deadline.at - (opts.deadline.now ?? Date.now)() <= 0) throw new NexusDeadlineError('sn_query_table');
      const body = await this.call('sn_query_table', args, opts.deadline);
      const data = (isObj(body) && isObj(body.data) ? body.data : body) as QueryPage;
      // Flattened here, at the boundary, so nothing past the client sees a reference object.
      const records = Array.isArray(data?.records) ? data.records.map(flattenRecord) : [];
      if (records.length) yield records;
      offset += records.length;
      if (!data?.has_more || records.length < limit) return;
    }
  }
}
