/**
 * A mock upstream MCP server for the proxy tests, served over Streamable HTTP. Its tools cover what the proxy
 * must pass through unchanged: plain results, MCP error results, JSON-RPC errors, a large result, a slow
 * call that sees cancellation, and nexus-like ServiceNow tools (all synthetic values).
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const SYS_ID_NEW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const BIG_BYTES = 5 * 1024 * 1024;

export const MOCK_TOOLS = [
  { name: 'echo', description: 'Echoes its args', inputSchema: { type: 'object' as const, properties: { text: { type: 'string', description: 'any text' } }, required: ['text'] } },
  { name: 'fail', inputSchema: { type: 'object' as const } },
  { name: 'boom', inputSchema: { type: 'object' as const } },
  { name: 'big', inputSchema: { type: 'object' as const } },
  { name: 'slow', inputSchema: { type: 'object' as const, properties: { ms: { type: 'number' } } } },
  { name: 'sn_record_manage', inputSchema: { type: 'object' as const, additionalProperties: true } },
  { name: 'sn_session_context', inputSchema: { type: 'object' as const } },
  { name: 'tool_execute', inputSchema: { type: 'object' as const, properties: { tool: { type: 'string' }, args: { type: 'object' } } } },
];

export interface MockUpstream {
  url: string;
  /** Request headers the upstream saw, per HTTP request. */
  headers: http.IncomingHttpHeaders[];
  /** Calls the tools handled, with their args. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Ids of `slow` calls whose abort signal fired. */
  aborted: string[];
  close(): Promise<void>;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

export function runTool(tool: string, a: Record<string, unknown>): unknown {
  switch (tool) {
    case 'sn_record_manage':
      if (a.action === 'create') return { success: true, data: { sys_id: SYS_ID_NEW, table: a.table } };
      return { success: true, data: { sys_id: a.sys_id, table: a.table } };
    case 'sn_session_context': return { success: true, data: { user_name: 'agent.user', roles: ['admin'] } };
    default: return { success: true, data: { ran: tool } };
  }
}

export async function startMockUpstream(): Promise<MockUpstream> {
  const headers: http.IncomingHttpHeaders[] = [];
  const calls: MockUpstream['calls'] = [];
  const aborted: string[] = [];
  const makeServer = () => {
    const server = new Server({ name: 'mock-upstream', version: '1.2.3' }, { capabilities: { tools: { listChanged: true } }, instructions: 'Mock upstream for proxy tests.' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MOCK_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const tool = req.params.name;
      const a = (req.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool, args: a });
      switch (tool) {
        case 'echo': return { ...text({ success: true, data: { echo: a.text } }), structuredContent: { echo: a.text } };
        case 'fail': return { ...text({ success: false, error: 'Record not found' }), isError: true };
        case 'boom': throw new McpError(ErrorCode.InvalidParams, 'boom: bad params');
        case 'big': return { content: [{ type: 'text' as const, text: 'x'.repeat(BIG_BYTES) }] };
        case 'slow': {
          const ms = Number(a.ms ?? 2000);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ms);
            extra.signal.addEventListener('abort', () => { clearTimeout(t); aborted.push(String(extra.requestId)); resolve(); });
          });
          return text({ success: true, data: { slept: ms } });
        }
        case 'tool_execute': return text({ success: true, tool: a.tool, result: runTool(String(a.tool), (a.args ?? {}) as Record<string, unknown>) });
        default: return text(runTool(tool, a));
      }
    });
    return server;
  };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const readBody = (req: http.IncomingMessage): Promise<unknown> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(undefined); } });
  });
  const httpServer = http.createServer(async (req, res) => {
    headers.push(req.headers);
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (!transport) {
      if (req.method !== 'POST') { res.writeHead(400).end(); return; }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { sessions.set(id, t); },
      });
      transport = t;
      await makeServer().connect(t);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers, calls, aborted,
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => {});
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
