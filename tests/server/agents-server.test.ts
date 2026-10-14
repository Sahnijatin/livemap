import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { AgentHub } from '../../src/agents/hub.js';
import { Attributor } from '../../src/agents/attribution.js';
import { PAUSE_MESSAGE } from '../../src/agents/control.js';
import { startServer } from '../../src/server/server.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

type Started = Awaited<ReturnType<typeof startServer>>;

let root: string;
let uiDir: string;
let model: ProjectModel;
let watcher: Watcher;
let hub: AgentHub | null;
let attributor: Attributor | null;
let srv: Started | null;
let sockets: WebSocket[];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(10);
  }
}
function put(dir: string, rel: string, data: string): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
}

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }
function request(port: number, method: string, p: string, opts: { headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
    if (opts.body !== undefined && !opts.chunked) headers['content-length'] = String(Buffer.byteLength(opts.body));
    let done = false;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        done = true;
        let json: unknown;
        try { json = JSON.parse(body); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', e => { if (!done) reject(e); });
    if (opts.body === undefined) req.end();
    else if (opts.chunked) {
      const buf = Buffer.from(opts.body);
      const step = 1024 * 1024;
      for (let i = 0; i < buf.length; i += step) req.write(buf.subarray(i, i + step));
      req.end();
    } else req.end(opts.body);
  });
}
const JSON_CT = { 'content-type': 'application/json' };
const hookPost = (s: Started, body: unknown, headers: Record<string, string> = { 'x-livemap-token': s.token, ...JSON_CT }) =>
  request(s.port, 'POST', '/hook', { headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const api = (s: Started, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(s.port, method, p, { headers: { 'x-livemap-token': s.token, ...JSON_CT, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

interface Client { ws: WebSocket; msgs: ServerMessage[] }
function connect(s: Started): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=${s.token}`);
  sockets.push(ws);
  const c: Client = { ws, msgs: [] };
  ws.on('message', d => c.msgs.push(JSON.parse(String(d))));
  ws.on('error', () => {});
  return c;
}
const ofType = <T extends ServerMessage['type']>(c: Client, t: T) =>
  c.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);

async function boot(opts: { agents?: boolean } = {}): Promise<Started> {
  model = new ProjectModel(root);
  await model.scan();
  watcher = new Watcher(model, { debounceMs: 30 });
  await watcher.start();
  if (opts.agents !== false) {
    hub = new AgentHub(root);
    attributor = new Attributor(hub);
  }
  srv = await startServer({ model, watcher, port: 0, uiDir, ...(hub && attributor ? { hub, attributor } : {}) });
  srv.ready();
  return srv;
}
async function hello(s: Started): Promise<Extract<ServerMessage, { type: 'hello' }>> {
  const c = connect(s);
  await waitFor(() => c.msgs.length >= 1);
  const h = c.msgs[0];
  if (h.type !== 'hello') throw new Error('expected hello');
  return h;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-asrv-')));
  uiDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-aui-')));
  put(root, 'src/a.ts', 'export const a = 1;\n');
  put(uiDir, 'index.html', '<!doctype html><title>LiveMap</title>');
  srv = null;
  hub = null;
  attributor = null;
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) s.terminate();
  await srv?.close();
  await watcher?.stop();
  attributor?.stop();
  hub?.stop();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(uiDir, { recursive: true, force: true });
});

const codexPrompt = () => ({ agent: 'codex', event: 'UserPromptSubmit', payload: { session_id: 'c1', cwd: root, prompt: 'Add a widget' } });

describe('POST /hook', () => {
  it('is 401 without the token header, and a query token does not count', async () => {
    const s = await boot();
    expect((await hookPost(s, codexPrompt(), JSON_CT)).status).toBe(401);
    expect((await request(s.port, 'POST', `/hook?t=${s.token}`, { headers: JSON_CT, body: JSON.stringify(codexPrompt()) })).status).toBe(401);
    expect((await hookPost(s, codexPrompt(), { ...JSON_CT, 'x-livemap-token': 'nope' })).status).toBe(401);
    expect(hub!.events()).toHaveLength(0);
  });

  it('is 403 for a foreign Host even with the token', async () => {
    const s = await boot();
    const r = await hookPost(s, codexPrompt(), { 'x-livemap-token': s.token, ...JSON_CT, host: 'evil.example:80' });
    expect(r.status).toBe(403);
  });

  it('rejects malformed JSON, unknown agents and wrong methods', async () => {
    const s = await boot();
    expect((await hookPost(s, '{nope')).status).toBe(400);
    expect((await hookPost(s, { agent: 'git', event: 'x', payload: {} })).status).toBe(400);
    expect((await hookPost(s, { agent: 'codex', payload: {} })).status).toBe(400);
    expect((await request(s.port, 'GET', '/hook', { headers: { 'x-livemap-token': s.token } })).status).toBe(405);
  });

  it('a codex prompt hook broadcasts agentEvent and session and answers {block: null}', async () => {
    const s = await boot();
    const c = connect(s);
    await waitFor(() => c.msgs.length >= 1);
    const r = await hookPost(s, codexPrompt());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ block: null });
    await waitFor(() => ofType(c, 'agentEvent').length >= 1 && ofType(c, 'session').length >= 1);
    expect(ofType(c, 'agentEvent')[0].event).toMatchObject({ agent: 'codex', sessionId: 'c1', type: 'prompt', text: 'Add a widget' });
    expect(ofType(c, 'session').at(-1)!.session).toMatchObject({ id: 'c1', agent: 'codex', title: 'Add a widget' });
  });

  it('pausing via /api/pause makes a claude PreToolUse block and broadcasts control', async () => {
    const s = await boot();
    const c = connect(s);
    await waitFor(() => c.msgs.length >= 1);
    const p = await api(s, 'POST', '/api/pause', { paused: true });
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ paused: true, flags: [] });
    await waitFor(() => ofType(c, 'control').length >= 1);
    expect(ofType(c, 'control')[0].control).toEqual({ paused: true, flags: [] });
    const r = await hookPost(s, { agent: 'claude-code', event: 'PreToolUse', payload: { session_id: 'k1', cwd: root, tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'ls' } } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ block: PAUSE_MESSAGE });
  });

  it('Review Focus 2: a 7 MB body is accepted and its output stored truncated', async () => {
    const s = await boot();
    const big = 'y'.repeat(7 * 1024 * 1024);
    const base = { session_id: 'c1', cwd: root };
    await hookPost(s, { agent: 'codex', event: 'PreToolUse', payload: { ...base, tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'cat big' } } });
    const r = await hookPost(s, { agent: 'codex', event: 'PostToolUse', payload: { ...base, tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'cat big' }, tool_response: big } });
    expect(r.status).toBe(200);
    await hub!.flush();
    const end = hub!.events().find(e => e.type === 'tool_end');
    expect(end?.tool?.output?.length).toBeGreaterThan(0);
    expect(end!.tool!.output!.length).toBeLessThanOrEqual(4000);
  });

  it('R10: a hook payload at the 8 MB stdin cap plus its envelope is accepted, and a paused session still blocks', async () => {
    const s = await boot();
    await api(s, 'POST', '/api/pause', { paused: true });
    const head = JSON.stringify({ session_id: 'k1', cwd: root, tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: 'src/big.ts', content: '' } });
    const fill = 8 * 1024 * 1024 - Buffer.byteLength(head);
    const payload = head.replace('"content":""', `"content":"${'w'.repeat(fill)}"`);
    expect(Buffer.byteLength(payload)).toBe(8 * 1024 * 1024);
    const body = `{"agent":"claude-code","event":"PreToolUse","payload":${payload}}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(8 * 1024 * 1024);
    const r = await request(s.port, 'POST', '/hook', { headers: { 'x-livemap-token': s.token, ...JSON_CT }, body });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ block: PAUSE_MESSAGE });
  });

  it('Review Focus 2: a 9 MB body is 413, with or without content-length', async () => {
    const s = await boot();
    const big = JSON.stringify({ agent: 'codex', event: 'Stop', payload: { session_id: 'c1', last_assistant_message: 'z'.repeat(9 * 1024 * 1024) } });
    const a = await request(s.port, 'POST', '/hook', { headers: { 'x-livemap-token': s.token, ...JSON_CT }, body: big });
    expect(a.status).toBe(413);
    const b = await request(s.port, 'POST', '/hook', { headers: { 'x-livemap-token': s.token, ...JSON_CT }, body: big, chunked: true });
    expect(b.status).toBe(413);
    expect(hub!.events()).toHaveLength(0);
    expect((await api(s, 'GET', '/api/health')).status).toBe(200);
  });
});

describe('/api control routes', () => {
  it('GET /api/control returns the state; flags are added (201) and removed', async () => {
    const s = await boot();
    const c = connect(s);
    await waitFor(() => c.msgs.length >= 1);
    expect((await api(s, 'GET', '/api/control')).json).toEqual({ paused: false, flags: [] });
    const f = await api(s, 'POST', '/api/flags', { target: 'src/a.ts', note: 'Use the helper' });
    expect(f.status).toBe(201);
    expect(f.json).toMatchObject({ id: 1, target: 'src/a.ts', note: 'Use the helper' });
    const g = await api(s, 'POST', '/api/flags', { note: 'Whole project' });
    expect(g.json).toMatchObject({ target: null });
    await waitFor(() => ofType(c, 'control').length >= 2);
    expect((await api(s, 'GET', '/api/control')).json.flags).toHaveLength(2);
    const d = await api(s, 'DELETE', `/api/flags/${f.json.id}`);
    expect(d.status).toBe(200);
    expect((await api(s, 'GET', '/api/control')).json.flags.map((x: { id: number }) => x.id)).toEqual([g.json.id]);
    expect((await api(s, 'DELETE', '/api/flags/999')).status).toBe(404);
    expect((await api(s, 'DELETE', '/api/flags/abc')).status).toBe(404);
  });

  it('validates bodies with 400 JSON errors', async () => {
    const s = await boot();
    const empty = await api(s, 'POST', '/api/flags', { target: null, note: '   ' });
    expect(empty.status).toBe(400);
    expect(typeof empty.json.error).toBe('string');
    expect((await api(s, 'POST', '/api/flags', { target: 3, note: 'x' })).status).toBe(400);
    expect((await api(s, 'POST', '/api/pause', { paused: 'yes' })).status).toBe(400);
    expect((await request(s.port, 'POST', '/api/pause', { headers: { 'x-livemap-token': s.token, ...JSON_CT }, body: '{bad' })).status).toBe(400);
  });

  it('requires auth, a JSON content type and a same Origin for state changes', async () => {
    const s = await boot();
    expect((await request(s.port, 'POST', '/api/pause', { headers: JSON_CT, body: '{"paused":true}' })).status).toBe(401);
    const form = await request(s.port, 'POST', '/api/pause', { headers: { 'x-livemap-token': s.token, 'content-type': 'text/plain' }, body: '{"paused":true}' });
    expect(form.status).toBe(415);
    const cross = await api(s, 'POST', '/api/pause', { paused: true }, { origin: 'http://evil.example' });
    expect(cross.status).toBe(403);
    expect((await api(s, 'GET', '/api/control')).json.paused).toBe(false);
    expect((await api(s, 'PUT', '/api/pause', { paused: true })).status).toBe(405);
  });

  it('caps API bodies at 64 KB', async () => {
    const s = await boot();
    const r = await api(s, 'POST', '/api/flags', { note: 'n'.repeat(70 * 1024) });
    expect(r.status).toBe(413);
  });

  it('agent routes are 503 and hello has empty agent fields without a hub', async () => {
    const s = await boot({ agents: false });
    expect((await hookPost(s, codexPrompt())).status).toBe(503);
    expect((await api(s, 'GET', '/api/control')).status).toBe(503);
    expect((await api(s, 'POST', '/api/pause', { paused: true })).status).toBe(503);
    const h = await hello(s);
    expect(h).toMatchObject({ events: [], sessions: [], control: { paused: false, flags: [] } });
  });
});

describe('attribution and hello', () => {
  it('a change right after a codex tool_start on the file carries exact attribution', async () => {
    const s = await boot();
    const c = connect(s);
    await waitFor(() => c.msgs.length >= 1);
    await hookPost(s, codexPrompt());
    await hookPost(s, { agent: 'codex', event: 'PreToolUse', payload: { session_id: 'c1', cwd: root, tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } } });
    await hub!.flush();
    put(root, 'src/a.ts', 'export const a = 2;\n');
    await waitFor(() => ofType(c, 'change').length >= 1);
    const change = ofType(c, 'change')[0].change;
    expect(change.attribution).toMatchObject({ agent: 'codex', sessionId: 'c1', confidence: 'exact', intent: 'Asked: Add a widget' });
    const h = await hello(s);
    expect(h.changes.at(-1)!.attribution?.confidence).toBe('exact');
  });

  it('a late tool event broadcasts attribution and updates the stored change', async () => {
    const s = await boot();
    const c = connect(s);
    await waitFor(() => c.msgs.length >= 1);
    put(root, 'src/a.ts', 'export const a = 3;\n');
    await waitFor(() => ofType(c, 'change').length >= 1);
    const change = ofType(c, 'change')[0].change;
    expect(change.attribution).toBeUndefined();
    await hookPost(s, { agent: 'codex', event: 'PreToolUse', payload: { session_id: 'c1', cwd: root, tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: '*** Update File: src/a.ts\n' } } });
    await waitFor(() => ofType(c, 'attribution').length >= 1);
    const late = ofType(c, 'attribution')[0];
    expect(late.changeId).toBe(change.id);
    expect(late.attribution).toMatchObject({ agent: 'codex', confidence: 'exact' });
    const h = await hello(s);
    expect(h.changes.find(x => x.id === change.id)?.attribution?.confidence).toBe('exact');
  });

  it('hello carries events, sessions and control', async () => {
    const s = await boot();
    await hookPost(s, codexPrompt());
    await api(s, 'POST', '/api/flags', { note: 'Check this' });
    const h = await hello(s);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'prompt', agent: 'codex' });
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]).toMatchObject({ id: 'c1', agent: 'codex' });
    expect(h.control.flags).toHaveLength(1);
  });

  it('close() detaches hub, control and attributor listeners', async () => {
    const s = await boot();
    const before = { e: hub!.listenerCount('event'), c: hub!.control.listenerCount('change'), l: attributor!.listenerCount('late') };
    await s.close();
    srv = null;
    expect(hub!.listenerCount('event')).toBe(before.e - 1);
    expect(hub!.listenerCount('session')).toBe(0);
    expect(hub!.control.listenerCount('change')).toBe(before.c - 1);
    expect(attributor!.listenerCount('late')).toBe(before.l - 1);
  });
});
