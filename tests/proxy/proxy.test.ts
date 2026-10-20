import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ChildEndpoint, HttpEndpoint, LineEndpoint, LIVEMAP_CLIENT_NAME, runProxy, splitCommand, type Endpoint } from '../../src/proxy/proxy.js';
import { HookPoster } from '../../src/proxy/poster.js';
import type { CaptureEvent } from '../../src/proxy/capture.js';
import { CLIENT_NAME } from '../../plugins/servicenow/nexus.js';
import { AgentHub } from '../../src/agents/hub.js';
import { handleHook } from '../../src/server/agent-routes.js';
import { BIG_BYTES, startMockUpstream, SYS_ID_NEW, type MockUpstream } from '../helpers/mock-upstream.js';

const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;
const STDIO_MOCK = fileURLToPath(new URL('../helpers/mock-upstream-stdio.mjs', import.meta.url));

let up: MockUpstream;
beforeAll(async () => { up = await startMockUpstream(); });
afterAll(async () => { await up.close(); });

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

interface Wired { client: Client; captured: CaptureEvent[]; done: Promise<void>; transport: Transport }

/** A desktop-like MCP client talking to the proxy over in-memory stdio pipes. */
async function viaProxy(upstream: Endpoint, opts: { capture?: (e: CaptureEvent) => void; clientName?: string; instance?: string; connect?: boolean } = {}): Promise<Wired> {
  const c2p = new PassThrough();
  const p2c = new PassThrough();
  const captured: CaptureEvent[] = [];
  const done = runProxy({
    client: new LineEndpoint(c2p, p2c), upstream, upstreamName: 'mock', capture: opts.capture ?? ((e) => captured.push(e)),
    ...(opts.instance ? { instance: opts.instance } : {}),
  });
  const client = new Client({ name: opts.clientName ?? 'desktop-test', version: '1.0.0' });
  cleanup.push(async () => { await client.close().catch(() => {}); c2p.end(); await done; });
  const transport = new LineEndpoint(p2c, c2p) as unknown as Transport;
  if (opts.connect !== false) await client.connect(transport);
  return { client, captured, done, transport };
}

async function direct(): Promise<Client> {
  const client = new Client({ name: 'desktop-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(up.url)));
  cleanup.push(() => client.close());
  return client;
}

const http_ = (headers: Record<string, string> = {}) => new HttpEndpoint(new URL(up.url), headers);
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

describe('mcp-proxy pass-through (Streamable HTTP upstream)', () => {
  it('initialize and tools/list match a direct connection: same server info, capabilities, instructions, tools and schemas', async () => {
    const { client } = await viaProxy(http_());
    const d = await direct();
    expect(client.getServerVersion()).toEqual(d.getServerVersion());
    expect(client.getServerCapabilities()).toEqual(d.getServerCapabilities());
    expect(client.getInstructions()).toEqual(d.getInstructions());
    expect(await client.listTools()).toEqual(await d.listTools());
  });

  it('a call returns the same result, and is captured with its timing', async () => {
    const { client, captured } = await viaProxy(http_());
    const d = await direct();
    const args = { name: 'echo', arguments: { text: 'hello' } };
    const viaRes = await client.callTool(args);
    expect(viaRes).toEqual(await d.callTool(args));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ source: 'mcp-proxy', tool: 'echo', args: { text: 'hello' }, ok: true, client: { name: 'desktop-test', version: '1.0.0' } });
    expect(captured[0].end).toBeGreaterThanOrEqual(captured[0].start);
  });

  it('an MCP error result passes through and is captured as failed', async () => {
    const { client, captured } = await viaProxy(http_());
    const d = await direct();
    expect(await client.callTool({ name: 'fail', arguments: {} })).toEqual(await d.callTool({ name: 'fail', arguments: {} }));
    expect(captured[0]).toMatchObject({ tool: 'fail', ok: false, error: 'Record not found' });
  });

  it('a JSON-RPC error passes through with its code and message', async () => {
    const { client, captured } = await viaProxy(http_());
    const d = await direct();
    const viaErr = await client.callTool({ name: 'boom', arguments: {} }).catch((e: unknown) => e as { code: number; message: string });
    const dErr = await d.callTool({ name: 'boom', arguments: {} }).catch((e: unknown) => e as { code: number; message: string });
    expect(viaErr).toMatchObject({ code: dErr.code, message: dErr.message });
    expect(captured[0]).toMatchObject({ tool: 'boom', ok: false });
    expect(captured[0].error).toContain('boom');
  });

  it('a 5 MB result arrives whole', async () => {
    const { client } = await viaProxy(http_());
    const r = await client.callTool({ name: 'big', arguments: {} });
    expect((r.content as { text: string }[])[0].text.length).toBe(BIG_BYTES);
  });

  it('cancellation reaches the upstream, and the call is captured as cancelled', async () => {
    const { client, captured } = await viaProxy(http_());
    const ac = new AbortController();
    const before = up.aborted.length;
    const p = client.callTool({ name: 'slow', arguments: { ms: 5000 } }, undefined, { signal: ac.signal });
    await until(() => up.calls.some((c) => c.tool === 'slow'));
    ac.abort();
    await expect(p).rejects.toThrow();
    await until(() => up.aborted.length > before);
    expect(captured.find((e) => e.tool === 'slow')).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('sends its headers upstream, keeps the instance as metadata, and never captures a header value', async () => {
    const { client, captured } = await viaProxy(http_({ 'X-SN-Instance': 'devtest', Authorization: 'Bearer s3cret-value' }), { instance: 'devtest' });
    up.headers.length = 0;
    await client.callTool({ name: 'echo', arguments: { text: 'x' } });
    expect(up.headers.some((h) => h['x-sn-instance'] === 'devtest' && h.authorization === 'Bearer s3cret-value')).toBe(true);
    expect(captured[0].instance).toBe('devtest');
    expect(JSON.stringify(captured)).not.toContain('s3cret');
  });

  it('nexus-shaped calls: unwraps tool_execute, takes the new sys_id from the result, learns the session user', async () => {
    const { client, captured } = await viaProxy(http_(), { instance: 'devtest' });
    await client.callTool({ name: 'sn_session_context', arguments: {} });
    await client.callTool({ name: 'tool_execute', arguments: { tool: 'sn_record_manage', args: { action: 'create', table: 'sys_script', data: { name: 'Set priority', script: 'x' } } } });
    const c = captured[1];
    expect(c).toMatchObject({ tool: 'tool_execute', innerTool: 'sn_record_manage', user: 'agent.user', instance: 'devtest', ok: true, resultSysIds: [SYS_ID_NEW] });
    expect(c.targets).toContainEqual({ kind: 'record', instance: 'devtest', table: 'sys_script', sysId: SYS_ID_NEW, name: 'Set priority' });
  });

  it("LiveMap's own session is never captured", async () => {
    expect(LIVEMAP_CLIENT_NAME).toBe(CLIENT_NAME);
    const { client, captured } = await viaProxy(http_(), { clientName: CLIENT_NAME });
    await client.callTool({ name: 'echo', arguments: { text: 'x' } });
    expect(captured).toEqual([]);
  });

  it('upstream down: the client gets an error answer at once instead of waiting', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const { client, transport } = await viaProxy(new HttpEndpoint(new URL(`http://127.0.0.1:${port}/mcp`), {}), { connect: false });
    const t = Date.now();
    await expect(client.connect(transport)).rejects.toThrow(/did not take the request/);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('mcp-proxy with a stdio upstream (--upstream-cmd)', () => {
  it('splits a command line, keeping quoted parts', () => {
    expect(splitCommand('node "C:/Program Files/x/server.js" --flag \'a b\'')).toEqual(['node', 'C:/Program Files/x/server.js', '--flag', 'a b']);
  });

  it('lists and calls through a child process, and captures the call', async () => {
    const { client, captured } = await viaProxy(new ChildEndpoint(process.execPath, [STDIO_MOCK]));
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name)).toEqual(['echo', 'sn_record_manage']);
    const sysId = 'b'.repeat(32);
    const r = await client.callTool({ name: 'sn_record_manage', arguments: { action: 'update', table: 'sp_widget', sys_id: sysId, data: { template: '<div/>' } } });
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual({ success: true, data: { sys_id: sysId, table: 'sp_widget' } });
    expect(captured[0].targets).toEqual([{ kind: 'record', instance: '', table: 'sp_widget', sysId }]);
  });

  it('ends when the child exits', async () => {
    const { done } = await viaProxy(new ChildEndpoint(process.execPath, ['-e', 'process.exit(3)']), { connect: false });
    await done;
  });
});

describe('mcp-proxy with LiveMap down', () => {
  /** A LiveMap that accepts connections and never answers. */
  async function hangingServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const s = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return { port: (s.address() as AddressInfo).port, close: async () => { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } };
  }

  async function meanCallMs(client: Client, n: number): Promise<number> {
    const t = performance.now();
    for (let i = 0; i < n; i++) await client.callTool({ name: 'echo', arguments: { text: String(i) } });
    return (performance.now() - t) / n;
  }

  it('a hanging or absent LiveMap adds no measurable latency to calls', async () => {
    const hang = await hangingServer();
    cleanup.push(hang.close);
    const runs = [{ root: '/p/.livemap/sn', port: hang.port, token: 't', pid: process.pid }, { root: '/q/.livemap/sn', port: 1, token: 't', pid: process.pid }];
    const poster = new HookPoster({ runtimes: () => runs, timeoutMs: 500 });
    const base = await viaProxy(http_(), { capture: () => {} });
    const slow = await viaProxy(http_(), { capture: (e) => poster.send(e) });
    await meanCallMs(base.client, 5);
    await meanCallMs(slow.client, 5);
    const a = await meanCallMs(base.client, 30);
    const b = await meanCallMs(slow.client, 30);
    expect(b - a).toBeLessThan(10 * TIME_SCALE);
  });

  it('send() returns at once and the queue keeps only the newest events', async () => {
    const hang = await hangingServer();
    cleanup.push(hang.close);
    const poster = new HookPoster({ runtimes: () => [{ root: '/p/.livemap/sn', port: hang.port, token: 't', pid: process.pid }], timeoutMs: 200, queueMax: 10 });
    const t = performance.now();
    for (let i = 0; i < 50; i++) poster.send({ i });
    expect(performance.now() - t).toBeLessThan(20 * TIME_SCALE);
    expect(poster.dropped).toBeGreaterThanOrEqual(39);
  });

  it('with no run file, events are dropped and nothing throws', async () => {
    const poster = new HookPoster({ runtimes: () => [] });
    poster.send({ x: 1 });
    await poster.flushed();
    expect(poster.delivered).toBe(0);
  });

  it('only ServiceNow mirror runs get events by default', async () => {
    const got: string[] = [];
    const s = http.createServer((req, res) => { got.push(req.url ?? ''); res.writeHead(200).end('{}'); });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
    const port = (s.address() as AddressInfo).port;
    const poster = new HookPoster({ runtimes: () => [{ root: '/code/app', port, token: 't', pid: process.pid }, { root: 'C:\\work\\proj\\.livemap\\sn', port, token: 't', pid: process.pid }] });
    poster.send({ x: 1 });
    await poster.flushed();
    expect(got).toEqual(['/hook']);
  });
});

describe('mcp-proxy to a running LiveMap', () => {
  it('a captured call lands in the hub as a tool_start and tool_end of an mcp-client session', async () => {
    const hub = new AgentHub('/p/.livemap/sn');
    cleanup.push(() => hub.stop());
    const s = http.createServer((req, res) => {
      void handleHook(req, res, (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); }, 'tok', hub);
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
    const poster = new HookPoster({ runtimes: () => [{ root: '/p/.livemap/sn', port: (s.address() as AddressInfo).port, token: 'tok', pid: process.pid }] });
    const { client } = await viaProxy(http_(), { capture: (e) => poster.send(e), instance: 'devtest' });
    await client.callTool({ name: 'sn_record_manage', arguments: { action: 'update', table: 'sys_script', sys_id: 'c'.repeat(32), password: 'hunter2' } });
    await poster.flushed();
    const evs = hub.events();
    expect(evs.map((e) => [e.agent, e.type])).toEqual([['mcp-client', 'tool_start'], ['mcp-client', 'tool_end']]);
    expect(evs[0].tool).toMatchObject({ name: 'sn_record_manage', access: 'write', targets: [{ table: 'sys_script', sysId: 'c'.repeat(32), instance: 'devtest' }] });
    expect(JSON.stringify(evs)).not.toContain('hunter2');
    expect(poster.delivered).toBe(1);
  });
});
