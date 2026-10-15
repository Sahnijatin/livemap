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
function tableRows(fx: Fixture, table: string, unrecorded: 'inventory' | 'empty'): Rec[] {
  const inv = fx.tables.sys_metadata;
  const inventory = (): Rec[] => inv.rows.map(r => {
    const o: Rec = { sys_scope: fx.scope.sys_id };
    inv.columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
  if (table === 'sys_metadata') return inventory();
  if (table === 'sys_scope' || table === 'sys_app') return [{ sys_id: fx.scope.sys_id, scope: fx.scope.scope, name: fx.scope.name, version: fx.scope.version, sys_class_name: 'sys_app' }];
  if (table === 'sys_update_xml') return fx.sys_update_xml;
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
}

export interface CallLog { tool: string; args: Record<string, unknown>; inner?: string }

export interface MockNexus {
  url: string;
  calls: CallLog[];
  headers: http.IncomingHttpHeaders[];
  /** Transports that connected: 'http' or 'sse'. */
  sessions: string[];
  close(): Promise<void>;
}

const TOOLS = ['sn_query_table', 'sn_record_manage', 'sn_get_table_metadata', 'sn_discover_platform_tables', 'sn_intermediate_flow', 'tool_search', 'tool_execute', 'sn_load_skill'];

export async function startMockNexus(opts: MockNexusOptions = {}): Promise<MockNexus> {
  const fx = loadFixture();
  const calls: CallLog[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const sessions: string[] = [];
  let failLeft = opts.failCalls ?? 0;
  const searched = new Set<string>();
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

  const query = (a: Record<string, unknown>) => {
    const table = String(a.table ?? '');
    if (opts.failTables?.includes(table)) return { success: false, error: `Insufficient rights to query ${table}` };
    let rows = tableRows(fx, table, opts.unrecorded ?? 'inventory').filter(r => matches(r, a.query as string | undefined));
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
    const records = fields ? page.map(r => Object.fromEntries(fields.map(f => [f, r[f] ?? '']))) : page;
    const total = opts.plusTotals && rows.length > 100 ? '100+' : rows.length;
    return { success: true, data: { records, count: records.length, total, has_more: offset + page.length < rows.length } };
  };

  const run = (tool: string, a: Record<string, unknown>): unknown => {
    switch (tool) {
      case 'sn_query_table': return query(a);
      case 'sn_get_instance_info': return { success: true, data: { ...fx.instance } };
      case 'sn_session_context': return { success: true, data: { user_name: 'admin', roles: ['admin'] } };
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
    calls, headers, sessions,
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
