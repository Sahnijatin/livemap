/**
 * A mock of SkyForge's nexus MCP that replays tests/fixtures/servicenow/bharatbank.json.gz. It serves
 * Streamable HTTP and SSE on one URL (`/mcp`), like nexus, and records every call and header so tests can
 * check that LiveMap only reads. Faults can be injected: failing calls, refusing a tool until `tool_search`
 * enabled it, serving only SSE, or going down.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const FIXTURE = fileURLToPath(new URL('../fixtures/servicenow/bharatbank.json.gz', import.meta.url));

type Rec = Record<string, string>;
export interface Fixture {
  instance: { instance_name: string; release: string; patch: string };
  scope: { sys_id: string; scope: string; name: string; version: string };
  groundTruth: { records: number; byClass: Record<string, number>; mirrored: Record<string, number> };
  tables: Record<string, Rec[]> & { sys_metadata: { columns: string[]; rows: string[][] } };
  sys_update_xml: Rec[];
  mcpLogExcerpt: { lines: string[] };
}

let cached: Fixture | null = null;
export function loadFixture(): Fixture {
  cached ??= JSON.parse(gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8')) as Fixture;
  return cached;
}

/** Every record of a table as the instance would hold it: the recorded ones, plus inventory for the rest. */
/** One `sys_update_version` row per fixture update_xml row, as the instance would hold it (no payload). */
function versionRows(fx: Fixture, extra: Rec[] = [], application: boolean | 'some' = false): Rec[] {
  const names = [...new Set([...fx.sys_update_xml, ...extra].map(r => r.name))];
  return [...fx.sys_update_xml, ...extra].map((r, i) => {
    const inner = /<sys_updated_on>([^<]+)<\/sys_updated_on>/.exec(r.payload)?.[1];
    return {
      sys_id: `7a${String(i + 1).padStart(30, '0')}`, name: r.name, type: r.type, record_name: r.target_name, action: r.action,
      sys_created_by: r.sys_created_by, sys_created_on: r.action === 'DELETE' || !inner ? r.sys_updated_on : inner, state: 'current',
      ...(application === true || (application === 'some' && names.indexOf(r.name) % 2 === 0) ? { application: fx.scope.sys_id } : {}),
    };
  });
}

function tableRows(fx: Fixture, table: string, unrecorded: 'inventory' | 'empty', versions: boolean | 'application' | 'some-application' = false, extraXml: Rec[] = []): Rec[] {
  const inv = fx.tables.sys_metadata;
  const inventory = (): Rec[] => inv.rows.map(r => {
    const o: Rec = { sys_scope: fx.scope.sys_id };
    inv.columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
  if (table === 'sys_metadata') return inventory();
  if (table === 'sys_scope' || table === 'sys_app') return [{ sys_id: fx.scope.sys_id, scope: fx.scope.scope, name: fx.scope.name, version: fx.scope.version, sys_class_name: 'sys_app' }];
  // Every recorded row belongs to the scope; the fixture leaves out the `application` field.
  if (table === 'sys_update_xml') return [...fx.sys_update_xml, ...extraXml].map(r => ({ ...r, application: fx.scope.sys_id }));
  if (table === 'sys_update_version') return versions ? versionRows(fx, extraXml, versions === 'application' ? true : versions === 'some-application' ? 'some' : false) : [];
  const recorded = (fx.tables as Record<string, unknown>)[table];
  if (Array.isArray(recorded)) return recorded as Rec[];
  // A class the fixture has no full records for: the instance would return its records, so serve the
  // inventory fields of that class (sys_id, class, name, dates, sys_scope).
  return unrecorded === 'inventory' ? inventory().filter(r => r.sys_class_name === table) : [];
}

/**
 * A minimal encoded-query matcher: `^`-joined terms of `field=value`, `field!=value`, `field>value`,
 * `field>=value`, `field<value`, `fieldINa,b`, `fieldSTARTSWITHx`, and `ORDERBYfield` / `ORDERBYDESCfield`.
 */
export function matches(rec: Rec, query: string | undefined): boolean {
  if (!query) return true;
  for (const term of query.split('^')) {
    if (!term || term.startsWith('ORDERBY')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(\w+?)IN(.*)$/.exec(term)) && !/[=<>]/.test(term)) { if (!m[2].split(',').includes(rec[m[1]] ?? '')) return false; continue; }
    if ((m = /^(\w+?)STARTSWITH(.*)$/.exec(term))) { if (!(rec[m[1]] ?? '').startsWith(m[2])) return false; continue; }
    m = /^(\w+)(!=|>=|<=|=|>|<)(.*)$/.exec(term);
    if (!m) throw new Error(`mock nexus cannot read query term: ${term}`);
    const [, f, op, v] = m;
    const x = rec[f] ?? '';
    const ok = op === '=' ? x === v : op === '!=' ? x !== v : op === '>' ? x > v : op === '>=' ? x >= v : op === '<' ? x < v : x <= v;
    if (!ok) return false;
  }
  return true;
}

export interface MockNexusOptions {
  /** Serve only SSE (the Streamable HTTP POST answers 405), to test the fallback. */
  sseOnly?: boolean;
  /** Fail this many calls (any tool) with a transport-level 503 before answering. */
  failCalls?: number;
  /** `tool_execute` refuses these tools until `tool_search` was called for them. */
  needsSearch?: string[];
  /** What a class without recorded full records returns (default: its inventory fields). */
  unrecorded?: 'inventory' | 'empty';
  /** Tables whose queries answer `success: false` (to test the inventory fallback). */
  failTables?: string[];
  /** Report `total` as "100+" when more than 100 records match, as nexus does. */
  plusTotals?: boolean;
  /** has_more on every page, even a short one (the default is real nexus: has_more whenever a page is full). */
  alwaysMore?: boolean;
  /** Plain strings for reference fields, as the fixture stores them (the default is real nexus: `{link, value}`). */
  flatReferences?: boolean;
  /**
   * Serve `sys_update_version` rows built from the fixture's update_xml rows (the default: none, as recorded).
   * `application` also gives them the scope's `application`, as newer releases do; `some-application` gives it
   * to the rows of every other update name only.
   */
  versions?: boolean | 'application' | 'some-application';
  /** What `sn_session_context` answers (default: user admin). */
  sessionContext?: unknown;
  /** Extra `sys_update_xml` rows for the scope, after the fixture's. */
  extraUpdateXml?: Rec[];
}

/** Fields real nexus returns as references, besides any other field holding a sys_id. */
export const REFERENCE_FIELDS = new Set(['operation', 'type', 'sys_scope', 'sp_widget', 'sp_page', 'sp_column', 'sp_row', 'sp_container', 'collection', 'table', 'reference', 'super_class']);
const SYS_ID_VALUE = /^[0-9a-f]{32}$/;

/**
 * A record in the shape real `sn_query_table` returns, verified live: reference fields are `{link, value}`
 * objects even with `display_value:false`. The record's own `sys_id` stays a string; empty references stay ''.
 */
export function asNexusRecord(table: string, r: Rec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    const ref = k !== 'sys_id' && typeof v === 'string' && v !== '' && (REFERENCE_FIELDS.has(k) || SYS_ID_VALUE.test(v));
    out[k] = ref ? { link: `https://mock.service-now.com/api/now/table/${k === 'sys_scope' ? 'sys_scope' : table}/${v}`, value: v } : v;
  }
  return out;
}

export interface CallLog { tool: string; args: Record<string, unknown>; inner?: string }

export interface MockNexus {
  url: string;
  calls: CallLog[];
  headers: http.IncomingHttpHeaders[];
  /** Transports that connected: 'http' or 'sse'. */
  sessions: string[];
  /** MCP client names from each `initialize`. */
  clients: string[];
  /**
   * Changes made while the mock runs, as a live poll sees them: rows per table, read on every query, that add
   * to the fixture's or replace a row with the same sys_id. `down` makes every request fail with 503.
   */
  live: { rows: Record<string, Rec[]>; down: boolean; onQuery?: (table: string) => void };
  close(): Promise<void>;
}

const TOOLS = ['sn_query_table', 'sn_record_manage', 'sn_get_table_metadata', 'sn_discover_platform_tables', 'sn_intermediate_flow', 'tool_search', 'tool_execute', 'sn_load_skill'];

export async function startMockNexus(opts: MockNexusOptions = {}): Promise<MockNexus> {
  const fx = loadFixture();
  const calls: CallLog[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const sessions: string[] = [];
  let failLeft = opts.failCalls ?? 0;
  const clients: string[] = [];
  const live: MockNexus['live'] = { rows: {}, down: false };
  /** The fixture's rows of a table with the live ones laid over them. */
  const rowsOf = (table: string): Rec[] => {
    const base = tableRows(fx, table, opts.unrecorded ?? 'inventory', opts.versions, opts.extraUpdateXml);
    const extra = (live.rows[table] ?? []).map(r => (table === 'sys_update_xml' ? { application: fx.scope.sys_id, ...r } : r));
    if (!extra.length) return base;
    const ids = new Set(extra.map(r => r.sys_id));
    return [...base.filter(r => !ids.has(r.sys_id)), ...extra];
  };
  const searched = new Set<string>();
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

  const query = (a: Record<string, unknown>) => {
    const table = String(a.table ?? '');
    if (opts.failTables?.includes(table)) return { success: false, error: `Insufficient rights to query ${table}` };
    live.onQuery?.(table); // a test can commit rows between two queries
    let rows = rowsOf(table).filter(r => matches(r, a.query as string | undefined));
    const order = typeof a.order_by === 'string' ? a.order_by : undefined;
    if (order) {
      const desc = order.startsWith('-');
      const f = desc ? order.slice(1) : order;
      rows = [...rows].sort((x, y) => ((x[f] ?? '') < (y[f] ?? '') ? -1 : (x[f] ?? '') > (y[f] ?? '') ? 1 : 0) * (desc ? -1 : 1));
    }
    const limit = Math.min(10_000, Number(a.limit ?? 100));
    const offset = Number(a.offset ?? 0);
    const page = rows.slice(offset, offset + limit);
    const fields = Array.isArray(a.fields) ? (a.fields as string[]) : null;
    const picked = fields ? page.map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? '']))) : page;
    const records = opts.flatReferences ? picked : picked.map(r => asNexusRecord(table, r as Rec));
    const total = opts.plusTotals && rows.length > 100 ? '100+' : rows.length;
    // Real nexus sets has_more whenever a page is full, even when no rows are left.
    return { success: true, data: { records, count: records.length, total, has_more: opts.alwaysMore || records.length === limit } };
  };

  const run = (tool: string, a: Record<string, unknown>): unknown => {
    switch (tool) {
      case 'sn_query_table': return query(a);
      case 'sn_get_instance_info': return { success: true, data: { ...fx.instance } };
      case 'sn_session_context': return opts.sessionContext ?? { success: true, data: { user_name: 'admin', roles: ['admin'] } };
      case 'sn_get_table_metadata': return { success: true, data: { table: a.table } };
      case 'tool_search': {
        const q = String(a.query ?? '');
        searched.add(q);
        return { success: true, data: { tools: [{ name: q }] } };
      }
      default: return { success: true, data: { note: `mock nexus ran ${tool}` } };
    }
  };

  const makeServer = () => {
    const server = new Server({ name: 'skyforge-nexus-mock', version: '4.4.2' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS.map(name => ({ name, inputSchema: { type: 'object' as const, additionalProperties: true } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = req.params.name;
      const a = (req.params.arguments ?? {}) as Record<string, unknown>;
      const inner = tool === 'tool_execute' && typeof a.tool === 'string' ? a.tool : undefined;
      calls.push({ tool, args: a, ...(inner ? { inner } : {}) });
      if (inner) {
        if (opts.needsSearch?.includes(inner) && !searched.has(inner)) {
          return { ...text({ success: false, error: `Tool ${inner} not found. Use tool_search to enable it first.` }), isError: true };
        }
        return text({ success: true, tool: inner, result: run(inner, (a.args ?? {}) as Record<string, unknown>) });
      }
      return text(run(tool, a));
    });
    return server;
  };

  const streams = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();
  const readBody = (req: http.IncomingMessage): Promise<unknown> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(undefined); } });
  });

  const httpServer = http.createServer(async (req, res) => {
    headers.push(req.headers);
    if (live.down) { req.resume(); res.writeHead(503).end('unavailable'); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/mcp/messages' && req.method === 'POST') {
        const t = sse.get(url.searchParams.get('sessionId') ?? '');
        if (!t) { res.writeHead(404).end(); return; }
        const body = await readBody(req);
        if (failLeft > 0 && isToolCall(body)) { failLeft--; res.writeHead(503).end('unavailable'); return; }
        await t.handlePostMessage(req, res, body);
        return;
      }
      if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
      const sid = req.headers['mcp-session-id'];
      if (req.method === 'GET' && !sid) {
        const t = new SSEServerTransport('/mcp/messages', res);
        sse.set(t.sessionId, t);
        sessions.push('sse');
        res.on('close', () => sse.delete(t.sessionId));
        await makeServer().connect(t);
        return;
      }
      if (opts.sseOnly) { res.writeHead(405).end(); return; }
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (failLeft > 0 && isToolCall(body)) { failLeft--; res.writeHead(503).end('unavailable'); return; }
      const init = body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
      if (init?.method === 'initialize' && init.params?.clientInfo?.name) clients.push(init.params.clientInfo.name);
      let t = typeof sid === 'string' ? streams.get(sid) : undefined;
      if (!t) {
        t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { streams.set(id, t!); } });
        sessions.push('http');
        await makeServer().connect(t);
      }
      await t.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>(r => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls, headers, sessions, clients, live,
    close: async () => {
      for (const t of streams.values()) await t.close().catch(() => {});
      for (const t of sse.values()) await t.close().catch(() => {});
      httpServer.closeAllConnections?.();
      await new Promise<void>(r => httpServer.close(() => r()));
    },
  };
}

const isToolCall = (body: unknown): boolean =>
  !!body && typeof body === 'object' && (body as { method?: unknown }).method === 'tools/call';

/** The fixture path relative to the repo (for docs and messages). */
export const FIXTURE_REL = path.join('tests', 'fixtures', 'servicenow', 'bharatbank.json.gz');
