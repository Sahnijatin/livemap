/**
 * The proxy as a pass-through: raw messages (no schema check), batches, unreadable lines, upstream errors
 * and expired sessions, timeouts, and capture running after the answer went out.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ChildEndpoint, HttpEndpoint, LineEndpoint, runProxy, type Endpoint } from '../../src/proxy/proxy.js';

const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;
import type { CaptureEvent } from '../../src/proxy/capture.js';
import { startMockUpstream, SYS_ID_NEW, type MockUpstream } from '../helpers/mock-upstream.js';

let up: MockUpstream;
beforeAll(async () => { up = await startMockUpstream(); });
afterAll(async () => { await up.close(); });
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const settle = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

/** A raw client: writes lines to the proxy and collects every line it answers with, parsed. */
function rawClient(upstream: Endpoint, maxLine?: number) {
  const c2p = new PassThrough();
  const p2c = new PassThrough();
  const got: unknown[] = [];
  const captured: CaptureEvent[] = [];
  let buf = '';
  p2c.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const done = runProxy({ client: new LineEndpoint(c2p, p2c, maxLine), upstream, upstreamName: 'mock', capture: (e) => captured.push(e) });
  cleanup.push(async () => { c2p.end(); await done; });
  return { write: (s: string) => c2p.write(s), send: (m: unknown) => c2p.write(`${JSON.stringify(m)}\n`), got, captured, done };
}

/** An HTTP upstream that answers every POST with what `answer` returns: status, content type and raw body. */
async function rawUpstream(answer: (body: unknown, headers: http.IncomingHttpHeaders) => { status: number; type?: string; body: string; headers?: Record<string, string> }) {
  const seen: unknown[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown;
      seen.push(body);
      const a = answer(body, req.headers);
      res.writeHead(a.status, { ...(a.type ? { 'content-type': a.type } : {}), ...(a.headers ?? {}) }).end(a.body);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  cleanup.push(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
  return { url: new URL(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`), seen };
}

describe('messages pass through as sent', () => {
  it('a response the SDK schema would reject reaches the client byte for byte equivalent', async () => {
    const odd = { jsonrpc: '2.0', id: 7, result: { content: 'not-an-array', isError: 'maybe', extra: { kept: [1, 2] } } };
    const u = await rawUpstream(() => ({ status: 200, type: 'application/json', body: JSON.stringify(odd) }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: {} } });
    await until(() => c.got.length > 0);
    expect(c.got[0]).toEqual(odd);
  });

  it('SSE answers pass through the same way', async () => {
    const odd = { jsonrpc: '2.0', id: 'a', result: { anything: true } };
    const note = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 0.5, odd: 'x' } };
    const u = await rawUpstream(() => ({ status: 200, type: 'text/event-stream', body: `event: message\ndata: ${JSON.stringify(note)}\n\n: keep-alive\n\ndata: ${JSON.stringify(odd)}\n\n` }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'x' } });
    await until(() => c.got.length === 2);
    expect(c.got).toEqual([note, odd]);
  });

  it('a batch goes upstream as one array, and its answer comes back as one array', async () => {
    const u = await rawUpstream((body) => ({ status: 200, type: 'application/json', body: JSON.stringify((body as { id: number }[]).map((m) => ({ jsonrpc: '2.0', id: m.id, result: { n: m.id } }))) }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    const batch = [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }];
    c.send(batch);
    await until(() => c.got.length > 0);
    expect(u.seen).toEqual([batch]);
    expect(c.got).toEqual([[{ jsonrpc: '2.0', id: 1, result: { n: 1 } }, { jsonrpc: '2.0', id: 2, result: { n: 2 } }]]);
  });

  it('a line that is not JSON gets a Parse error with id null; the next message still works', async () => {
    const u = await rawUpstream((body) => ({ status: 200, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: (body as { id: number }).id, result: {} }) }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.write('{not json\n');
    c.send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await until(() => c.got.length === 2);
    expect(c.got).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { jsonrpc: '2.0', id: 5, result: {} }]);
  });

  it('a line over the size limit gets an error answer, not silence, and is skipped whole', async () => {
    const u = await rawUpstream((body) => ({ status: 200, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: (body as { id: number }).id, result: {} }) }));
    const c = rawClient(new HttpEndpoint(u.url, {}), 1000);
    c.write(`{"jsonrpc":"2.0","id":1,"method":"x","params":{"p":"${'y'.repeat(600)}`);
    c.write(`${'y'.repeat(600)}"}}\n`);
    c.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await until(() => c.got.length === 2);
    expect(c.got[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });
    expect(c.got[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(u.seen).toEqual([{ jsonrpc: '2.0', id: 2, method: 'ping' }]);
  });
});

describe('upstream errors', () => {
  it('an HTTP error whose body is a JSON-RPC error is forwarded with the request id', async () => {
    const u = await rawUpstream(() => ({ status: 400, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32602, message: 'Unsupported protocol version' } }) }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
    await until(() => c.got.length > 0);
    expect(c.got[0]).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'Unsupported protocol version' } });
  });

  it('an HTTP error with a plain body gives -32603 with the status; -32000 is kept for no answer at all', async () => {
    const u = await rawUpstream(() => ({ status: 500, type: 'text/plain', body: 'boom' }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    await until(() => c.got.length > 0);
    expect(c.got[0]).toMatchObject({ id: 4, error: { code: -32603, message: expect.stringContaining('HTTP 500') } });
  });

  it('a request past the timeout gets -32000, not a hang', async () => {
    const c = rawClient(new HttpEndpoint(new URL(up.url), {}, 300));
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await until(() => c.got.length === 1);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: { ms: 3000 } } });
    await until(() => c.got.length === 2, 3000);
    expect(c.got[1]).toMatchObject({ id: 2, error: { code: -32000, message: expect.stringContaining('no answer within') } });
  });
});

describe('expired upstream session', () => {
  it('after the upstream restarts, the proxy opens a new session and the call still works', async () => {
    const http_ = new HttpEndpoint(new URL(up.url), {});
    const c2p = new PassThrough();
    const p2c = new PassThrough();
    const done = runProxy({ client: new LineEndpoint(c2p, p2c), upstream: http_, upstreamName: 'mock', capture: () => {} });
    const client = new Client({ name: 'desktop-test', version: '1.0.0' });
    cleanup.push(async () => { await client.close().catch(() => {}); c2p.end(); await done; });
    await client.connect(new LineEndpoint(p2c, c2p) as unknown as Transport);
    const first = await client.callTool({ name: 'echo', arguments: { text: 'one' } });
    const oldSession = http_.sessionId;
    // The client's notifications/initialized is forwarded without waiting; let it land before the log is cleared.
    await until(() => up.rpc.some((r) => r.method === 'notifications/initialized'));
    up.rpc.length = 0;
    await up.restart();
    const second = await client.callTool({ name: 'echo', arguments: { text: 'two' } });
    expect(second.structuredContent).toEqual({ echo: 'two' });
    expect(first.structuredContent).toEqual({ echo: 'one' });
    expect(http_.sessionId).not.toBe(oldSession);
    // The replayed initialize used an internal id, then the original call was retried once.
    expect(up.rpc.map((r) => r.method)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
    expect(String(up.rpc[1].id)).toMatch(/^livemap-proxy-reinit-/);
  });

  it('closing ends the upstream session with a DELETE', async () => {
    const http_ = new HttpEndpoint(new URL(up.url), {});
    const c2p = new PassThrough();
    const p2c = new PassThrough();
    const done = runProxy({ client: new LineEndpoint(c2p, p2c), upstream: http_, upstreamName: 'mock', capture: () => {} });
    const client = new Client({ name: 'desktop-test', version: '1.0.0' });
    await client.connect(new LineEndpoint(p2c, c2p) as unknown as Transport);
    up.methods.length = 0;
    await client.close();
    c2p.end();
    await done;
    await until(() => up.methods.includes('DELETE'));
  });
});

describe('capture after forwarding', () => {
  it('the client has the answer before the capture runs; a large write result is not parsed', async () => {
    const order: string[] = [];
    const c2p = new PassThrough();
    const p2c = new PassThrough();
    p2c.on('data', () => order.push('client'));
    const done = runProxy({ client: new LineEndpoint(c2p, p2c), upstream: new HttpEndpoint(new URL(up.url), {}), upstreamName: 'mock', capture: (e) => { order.push('capture'); caps.push(e); } });
    const caps: CaptureEvent[] = [];
    const client = new Client({ name: 'desktop-test', version: '1.0.0' });
    cleanup.push(async () => { await client.close().catch(() => {}); c2p.end(); await done; });
    await client.connect(new LineEndpoint(p2c, c2p) as unknown as Transport);
    order.length = 0;
    await client.callTool({ name: 'sn_push_artifact', arguments: { table: 'sp_widget', sys_id: 'b'.repeat(32) } });
    await settle();
    expect(order.indexOf('client')).toBeLessThan(order.indexOf('capture'));
    expect(caps[0]).toMatchObject({ tool: 'sn_push_artifact', ok: true, resultSysIds: [] });
    expect(caps[0].resultSysIds).not.toContain(SYS_ID_NEW);
  });
});

describe('stdio upstream', () => {
  it("a child's last message before it exits still reaches the client", async () => {
    const note = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'bye' } };
    const script = `process.stdout.write(${JSON.stringify(`${JSON.stringify(note)}\n`)}); process.exit(0);`;
    const c = rawClient(new ChildEndpoint(process.execPath, ['-e', script]));
    await c.done;
    expect(c.got).toEqual([note]);
  });
});

describe('re-review fixes', () => {
  const ok = (id: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result: {} });
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

  it('an SSE answer that ends without the response gets an error, after the messages it did carry', async () => {
    const note = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } };
    const u = await rawUpstream(() => ({ status: 200, type: 'text/event-stream', body: `data: ${JSON.stringify(note)}\n\n` }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x' } });
    await until(() => c.got.length === 2);
    expect(c.got[0]).toEqual(note);
    expect(c.got[1]).toMatchObject({ id: 9, error: { code: -32603, message: expect.stringContaining('without a response') } });
  });

  it('an empty JSON body gets an error too', async () => {
    const u = await rawUpstream(() => ({ status: 200, type: 'application/json', body: '' }));
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send({ jsonrpc: '2.0', id: 10, method: 'ping' });
    await until(() => c.got.length === 1);
    expect(c.got[0]).toMatchObject({ id: 10, error: { code: -32603 } });
  });

  it('a 30 MB SSE event read in 64 KB chunks is passed on in linear time', async () => {
    const big = { jsonrpc: '2.0', id: 1, result: { t: 'x'.repeat(30 * 1024 * 1024) } };
    const event = `data: ${JSON.stringify(big)}\n\n`;
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let at = 0;
        const step = () => {
          while (at < event.length) {
            const part = event.slice(at, at + 65_536);
            at += part.length;
            if (!res.write(part)) { res.once('drain', step); return; }
          }
          res.end();
        };
        step();
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    cleanup.push(() => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }));
    const ep = new HttpEndpoint(new URL(`http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`), {});
    let bytes = 0;
    ep.onmessage = (_m, n) => { bytes = n; };
    const t = Date.now();
    await ep.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(bytes).toBeGreaterThan(30 * 1024 * 1024);
    expect(Date.now() - t).toBeLessThan(4000 * TIME_SCALE);
  }, 30_000);

  it('a failed re-init keeps the old session id, so the next request re-inits again and works', async () => {
    let valid = new Set<string>();
    let next = 0;
    let failInit = 0;
    const inits: unknown[] = [];
    const u = await rawUpstream((body, h) => {
      const m = body as { id?: unknown; method?: string };
      const sid = h['mcp-session-id'] as string | undefined;
      if (m.method === 'initialize') {
        inits.push(m.id);
        if (failInit > 0) { failInit--; return { status: 500, type: 'text/plain', body: 'starting up' }; }
        const id = `s${++next}`;
        valid.add(id);
        return { status: 200, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'u', version: '1' } } }), headers: { 'mcp-session-id': id } };
      }
      if (!sid || !valid.has(sid)) return { status: 404, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }) };
      if (m.id === undefined) return { status: 202, body: '' };
      return { status: 200, type: 'application/json', body: ok(m.id) };
    });
    const ep = new HttpEndpoint(u.url, {});
    const c = rawClient(ep);
    c.send(init);
    await until(() => c.got.length === 1);
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    valid = new Set();
    failInit = 1;
    c.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await until(() => c.got.length === 2);
    expect(c.got[1]).toMatchObject({ id: 2, error: { code: -32603 } });
    expect(ep.sessionId).toBe('s1');
    c.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await until(() => c.got.length === 3);
    expect(c.got[2]).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(ep.sessionId).toBe('s2');
    expect(inits.slice(1).every((id) => String(id).startsWith('livemap-proxy-reinit-'))).toBe(true);
  });

  it('two requests that both hit the stale session start one re-init', async () => {
    let valid = new Set<string>();
    let next = 0;
    const replays: unknown[] = [];
    const u = await rawUpstream((body, h) => {
      const m = body as { id?: unknown; method?: string };
      if (m.method === 'initialize') {
        if (String(m.id).startsWith('livemap')) replays.push(m.id);
        const id = `s${++next}`;
        valid.add(id);
        return { status: 200, type: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }), headers: { 'mcp-session-id': id } };
      }
      if (!valid.has(h['mcp-session-id'] as string)) return { status: 404, body: '' };
      return m.id === undefined ? { status: 202, body: '' } : { status: 200, type: 'application/json', body: ok(m.id) };
    });
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send(init);
    await until(() => c.got.length === 1);
    valid = new Set();
    c.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    c.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await until(() => c.got.length === 3);
    expect(c.got.slice(1).map((g) => (g as { id: number }).id).sort()).toEqual([2, 3]);
    expect(replays).toHaveLength(1);
  });

  it('server requests on the re-init answer reach the client', async () => {
    let valid = new Set<string>();
    let next = 0;
    const ask = { jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' };
    const u = await rawUpstream((body, h) => {
      const m = body as { id?: unknown; method?: string };
      if (m.method === 'initialize') {
        const id = `s${++next}`;
        valid.add(id);
        const res = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } });
        const replay = String(m.id).startsWith('livemap');
        return replay
          ? { status: 200, type: 'text/event-stream', body: `data: ${JSON.stringify(ask)}\n\ndata: ${res}\n\n`, headers: { 'mcp-session-id': id } }
          : { status: 200, type: 'application/json', body: res, headers: { 'mcp-session-id': id } };
      }
      if (!valid.has(h['mcp-session-id'] as string)) return { status: 404, body: '' };
      return m.id === undefined ? { status: 202, body: '' } : { status: 200, type: 'application/json', body: ok(m.id) };
    });
    const c = rawClient(new HttpEndpoint(u.url, {}));
    c.send(init);
    await until(() => c.got.length === 1);
    valid = new Set();
    c.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await until(() => c.got.length === 3);
    expect(c.got.slice(1)).toEqual([ask, { jsonrpc: '2.0', id: 2, result: {} }]);
  });

  it('errors for a batch come back as one array', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const c = rawClient(new HttpEndpoint(new URL(`http://127.0.0.1:${port}/mcp`), {}));
    c.send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    await until(() => c.got.length === 1);
    const got = c.got[0] as { id: number; error: { code: number } }[];
    expect(Array.isArray(got)).toBe(true);
    expect(got.map((g) => [g.id, g.error.code])).toEqual([[1, -32000], [2, -32000]]);
  });
});
