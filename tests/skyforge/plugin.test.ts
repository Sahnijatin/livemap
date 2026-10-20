/**
 * The SkyForge plugin, loaded from the committed bundle the way SkyForge loads it, driven through its hooks.
 * Captures go to a fake `livemap sn` found through a run file, as in real use.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCapture, buildText, SessionContext } from '../../src/proxy/capture.js';
import { captureEvents } from '../../src/agents/capture.js';
import { buildOnce } from '../build.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMITTED = path.join(repo, 'plugins', 'servicenow', 'skyforge-plugin', 'livemap-skyforge.js');
const BUILT = path.join(repo, 'dist', 'livemap-skyforge.js');
const STATE = Symbol.for('livemap.skyforge-plugin.v1');
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;
const NEXUS = 'nexus_ses_ebf63bf49ffeGGE3hEhWQuinBE_';
const SYS = 'a'.repeat(32);

type Hooks = Record<string, (input: unknown, output?: unknown) => Promise<void>>;
type PluginModule = { LivemapSkyforge: () => Promise<Hooks> };

let mod: PluginModule;
let home: string;
let hook: http.Server;
const bodies: Record<string, unknown>[] = [];
const prevHome = process.env.LIVEMAP_HOME;

const reset = () => { delete (globalThis as Record<symbol, unknown>)[STATE]; bodies.length = 0; };
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const quiet = () => new Promise((r) => setTimeout(r, 150));
const text = (v: unknown) => JSON.stringify(v);

beforeAll(async () => {
  mod = await import(pathToFileURL(COMMITTED).href) as PluginModule;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sfplugin-'));
  hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['x-livemap-token'] === 'tok') bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"block":null}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'run', 'a.json'), JSON.stringify({ root: path.join(home, 'proj', '.livemap', 'sn'), port: (hook.address() as AddressInfo).port, token: 'tok', pid: process.pid }));
  process.env.LIVEMAP_HOME = home;
});

afterAll(async () => {
  if (prevHome === undefined) delete process.env.LIVEMAP_HOME; else process.env.LIVEMAP_HOME = prevHome;
  reset();
  await new Promise<void>((r) => hook.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(reset);

/** One tool call through the hooks, as SkyForge makes it. */
async function call(h: Hooks, sessionID: string, callID: string, tool: string, args: unknown, output: string) {
  await h['tool.execute.before']({ tool, sessionID, callID }, { args });
  await h['tool.execute.after']({ tool, sessionID, callID, args }, { title: tool, output, metadata: {} });
}

describe('the bundle', () => {
  it('is up to date with the source (run npm run build, then npm run plugin:sync)', async () => {
    await buildOnce();
    const norm = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(COMMITTED) === norm(BUILT), 'plugins/servicenow/skyforge-plugin/livemap-skyforge.js is stale: run npm run build && npm run plugin:sync').toBe(true);
  }, 180_000);

  it('imports Node built-ins only, and exports only the plugin', () => {
    const src = fs.readFileSync(COMMITTED, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual([]);
    expect(src).not.toMatch(/\brequire\(/);
    expect(Object.keys(mod)).toEqual(['LivemapSkyforge']);
  });
});

describe('tool calls', () => {
  it('strips the nexus_ses_ prefix and unwraps tool_execute', async () => {
    const h = await mod.LivemapSkyforge();
    await call(h, 'ses_1', 'c1', `${NEXUS}tool_execute`, { tool: 'sn_record_manage', args: { action: 'create', table: 'sys_script', data: { name: 'Set priority' } } },
      text({ success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS } } }));
    await until(() => bodies.length === 1);
    expect(bodies[0]).toMatchObject({ source: 'skyforge-plugin', sessionId: 'ses_1', callId: 'c1', tool: 'tool_execute', innerTool: 'sn_record_manage', ok: true, resultSysIds: [SYS] });
    expect(bodies[0].targets).toContainEqual({ kind: 'record', instance: '', table: 'sys_script', sysId: SYS, name: 'Set priority' });
    const evs = captureEvents(bodies[0], Date.now());
    expect(evs.map((e) => [e.agent, e.type])).toEqual([['skyforge', 'tool_start'], ['skyforge', 'tool_end']]);
    expect(evs[0].tool).toMatchObject({ name: 'tool_execute', inner: 'sn_record_manage', access: 'write' });
  });

  it('a gateway read stays a read', async () => {
    const h = await mod.LivemapSkyforge();
    await call(h, 'ses_2', 'c1', `${NEXUS}tool_execute`, { tool: 'sn_record_manage', args: { action: 'get', table: 'sys_script', sys_id: SYS } }, text({ success: true, data: { sys_id: SYS } }));
    await until(() => bodies.length === 1);
    expect(captureEvents(bodies[0], Date.now())[0].tool).toMatchObject({ access: 'read' });
  });

  it('other SkyForge tools (bash, edit, read) are not sent', async () => {
    const h = await mod.LivemapSkyforge();
    await call(h, 'ses_3', 'c1', 'bash', { command: 'ls' }, 'a\nb');
    await call(h, 'ses_3', 'c2', 'edit', { filePath: '/x', oldString: 'a', newString: 'b' }, 'ok');
    await quiet();
    expect(bodies).toEqual([]);
  });

  it('repeated init does not post twice', async () => {
    const hooks = await Promise.all([mod.LivemapSkyforge(), mod.LivemapSkyforge(), mod.LivemapSkyforge()]);
    const args = { table: 'sys_script', query: 'active=true' };
    for (const h of hooks) await h['tool.execute.before']({ tool: `${NEXUS}sn_query_table`, sessionID: 'ses_4', callID: 'c1' }, { args });
    for (const h of hooks) await h['tool.execute.after']({ tool: `${NEXUS}sn_query_table`, sessionID: 'ses_4', callID: 'c1', args }, { title: '', output: text({ success: true }), metadata: {} });
    await until(() => bodies.length >= 1);
    await quiet();
    expect(bodies).toHaveLength(1);
    expect((globalThis as Record<symbol, { inits: number }>)[STATE].inits).toBe(3);
  });

  it('redacts before sending', async () => {
    const h = await mod.LivemapSkyforge();
    await call(h, 'ses_5', 'c1', `${NEXUS}tool_execute`, { tool: 'sn_record_manage', args: JSON.stringify({ action: 'update', table: 'sys_script', sys_id: SYS, password: 'hunter2', data: { script: 'var pw = "s3cret";', clientSecret: 'cs' } }) }, text({ success: true }));
    await until(() => bodies.length === 1);
    const s = JSON.stringify(bodies[0]);
    for (const secret of ['hunter2', 's3cret', '"cs"']) expect(s).not.toContain(secret);
    expect(bodies[0].args).toMatchObject({ tool: 'sn_record_manage', args: { password: '[redacted]', data: { script: '[redacted]', clientSecret: '[redacted]' } } });
  });

  it('tracks the update set the session made current, as the proxy does', async () => {
    const h = await mod.LivemapSkyforge();
    const set = '1'.repeat(32);
    await call(h, 'ses_6', 'c1', `${NEXUS}tool_execute`, { tool: 'sn_ensure_active_update_set', args: { name: 'CC offers', sync_with_user: true } }, text({ success: true, tool: 'sn_ensure_active_update_set', result: { success: true, data: { sys_id: set } } }));
    await call(h, 'ses_6', 'c2', `${NEXUS}tool_execute`, { tool: 'sn_execute_background_script', args: { script: 'x' } }, text({ success: true }));
    await until(() => bodies.length === 2);
    expect(bodies[1]).toMatchObject({ innerTool: 'sn_execute_background_script', updateSet: { sysId: set, name: 'CC offers' } });
  });
});

describe('parity with the shared classifier', () => {
  const cases: { name: string; args: unknown; output: unknown }[] = [
    { name: `${NEXUS}tool_execute`, args: { tool: 'sn_record_manage', args: { action: 'create', table: 'sp_widget', data: { name: 'Offer card', template: '<div/>' } } }, output: { success: true, tool: 'sn_record_manage', result: { success: true, data: { sys_id: SYS } } } },
    { name: `${NEXUS}sn_query_table`, args: { table: 'sys_script', query: 'active=true', limit: 5 }, output: { success: true, data: { records: [], count: 0, total: '100+', has_more: true } } },
    { name: `${NEXUS}sn_record_manage`, args: { action: 'update', table: 'sys_properties', sys_id: SYS, data: { value: 'secret' } }, output: { success: true, data: { sys_id: SYS } } },
    { name: `${NEXUS}tool_execute`, args: { tool: 'sn_update_set_manage', args: { action: 'create', name: 'CC offers' } }, output: { success: true, tool: 'sn_update_set_manage', result: { success: true, data: { sys_id: '2'.repeat(32), name: 'CC offers' } } } },
    { name: `${NEXUS}tool_execute`, args: { tool: 'sn_update_set_query', args: { action: 'current' } }, output: { success: true, tool: 'sn_update_set_query', result: { success: true, data: { active: true, sys_id: '3'.repeat(32), name: 'CC', state: 'in progress' }, metadata: {} } } },
    { name: `${NEXUS}tool_execute`, args: { tool: 'sn_execute_background_script', args: { script: 'gs.info(1)' } }, output: { success: false, error: 'Script error: password=abc' } },
    { name: `${NEXUS}sn_push_artifact`, args: { table: 'sp_widget', sys_id: SYS, file_path: 'C:/work/w.html' }, output: { success: true, data: { sys_id: SYS } } },
  ];

  it('the plugin sends what the shared code builds, case by case', async () => {
    const h = await mod.LivemapSkyforge();
    for (const [i, c] of cases.entries()) {
      bodies.length = 0;
      const sessionID = `ses_parity_${i}`;
      await call(h, sessionID, 'c1', c.name, c.args, JSON.stringify(c.output));
      await until(() => bodies.length === 1);
      const expected = buildCapture({ source: 'skyforge-plugin', client: { name: 'skyforge' }, sessionId: sessionID, callId: 'c1', name: c.name, args: c.args, result: { content: [{ type: 'text', text: JSON.stringify(c.output) }] }, start: 0, end: 0 }, new SessionContext());
      const strip = (o: Record<string, unknown>) => { const { start, end, ...rest } = o; void start; void end; return JSON.parse(JSON.stringify(rest)) as unknown; };
      expect(strip(bodies[0]), c.name).toEqual(strip(expected as unknown as Record<string, unknown>));
    }
  });
});

describe('prompts, messages and idle', () => {
  it('sends the prompt (Goal), finished assistant text (Step) and idle, redacted', async () => {
    const h = await mod.LivemapSkyforge();
    await h['chat.message']({ sessionID: 'ses_7' }, { message: { id: 'msg_u', sessionID: 'ses_7', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'Build the offer widget, password=abc' }, { type: 'text', text: 'hidden', synthetic: true }] });
    await h.event({ event: { type: 'message.updated', properties: { sessionID: 'ses_7', info: { id: 'msg_a', sessionID: 'ses_7', role: 'assistant' } } } });
    await h.event({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_7', part: { id: 'p1', sessionID: 'ses_7', messageID: 'msg_a', type: 'text', text: 'Creating the wid', time: { start: 2000 } } } } });
    await h.event({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_7', part: { id: 'p1', sessionID: 'ses_7', messageID: 'msg_a', type: 'text', text: 'Creating the widget now.', time: { start: 2000, end: 2500 } } } } });
    await h.event({ event: { type: 'message.part.updated', properties: { sessionID: 'ses_7', part: { id: 'p1', sessionID: 'ses_7', messageID: 'msg_a', type: 'text', text: 'Creating the widget now.', time: { start: 2000, end: 2500 } } } } });
    await h.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_7' } } });
    await until(() => bodies.length === 3);
    await quiet();
    expect(bodies.map((b) => [b.kind, b.text])).toEqual([['prompt', 'Build the offer widget, password=[redacted]'], ['message', 'Creating the widget now.'], ['idle', undefined]]);
    expect(bodies[0]).toEqual(buildText('prompt', 'ses_7', 1000, 'Build the offer widget, password=abc'));
    const evs = captureEvents(bodies[0], Date.now());
    expect(evs).toEqual([{ agent: 'skyforge', sessionId: 'ses_7', at: 1000, type: 'prompt', text: 'Build the offer widget, password=[redacted]' }]);
  });

  it('user text parts that arrive as events are not sent twice', async () => {
    const h = await mod.LivemapSkyforge();
    await h.event({ event: { type: 'message.updated', properties: { info: { id: 'msg_u2', role: 'user' } } } });
    await h.event({ event: { type: 'message.part.updated', properties: { part: { id: 'p9', sessionID: 'ses_8', messageID: 'msg_u2', type: 'text', text: 'hello', time: { start: 1, end: 2 } } } } });
    await quiet();
    expect(bodies).toEqual([]);
  });
});

describe('fail open', () => {
  it('with no LiveMap running, hooks return at once and send nothing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sfplugin-none-'));
    process.env.LIVEMAP_HOME = empty;
    try {
      const h = await mod.LivemapSkyforge();
      const t = performance.now();
      for (let i = 0; i < 50; i++) await call(h, 'ses_9', `c${i}`, `${NEXUS}sn_query_table`, { table: 'x' }, text({ success: true }));
      expect((performance.now() - t) / 50).toBeLessThan(5 * TIME_SCALE);
      await quiet();
      expect(bodies).toEqual([]);
    } finally {
      process.env.LIVEMAP_HOME = home;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('with LiveMap hanging, hooks still return at once', async () => {
    const hang = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sfplugin-hang-'));
    fs.mkdirSync(path.join(dir, 'run'));
    fs.writeFileSync(path.join(dir, 'run', 'h.json'), JSON.stringify({ root: path.join(dir, 'p', '.livemap', 'sn'), port: (hang.address() as AddressInfo).port, token: 't', pid: process.pid }));
    process.env.LIVEMAP_HOME = dir;
    try {
      const h = await mod.LivemapSkyforge();
      const t = performance.now();
      for (let i = 0; i < 50; i++) await call(h, 'ses_10', `c${i}`, `${NEXUS}sn_query_table`, { table: 'x' }, text({ success: true }));
      expect((performance.now() - t) / 50).toBeLessThan(5 * TIME_SCALE);
    } finally {
      process.env.LIVEMAP_HOME = home;
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws, whatever SkyForge passes', async () => {
    const h = await mod.LivemapSkyforge();
    const junk: unknown[] = [undefined, null, 1, 'x', {}, { tool: 42 }, { tool: `${NEXUS}sn_query_table` }];
    for (const name of Object.keys(h)) {
      for (const a of junk) for (const b of junk) await expect(h[name](a as never, b as never)).resolves.toBeUndefined();
    }
  });
});
