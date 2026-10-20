import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HookPoster, liveRuntimes } from '../../src/proxy/poster.js';
import { argNames, buildCapture, isSecretTable, outcome, redact, redactText, REDACTED, SessionContext, type CallInput } from '../../src/proxy/capture.js';
import { escapeCmd, needsShell, quoteForCmd } from '../../src/proxy/proxy.js';
import { parseProxyArgs } from '../../src/proxy/cli.js';
import { captureEvents } from '../../src/agents/capture.js';

const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const call = (over: Partial<CallInput>): CallInput => ({ sessionId: 's', callId: '1', name: 'echo', args: {}, start: 1000, end: 2000, result: text({ success: true }), ...over });
const SYS = 'd'.repeat(32);

describe('redaction', () => {
  it('replaces secret keys at any depth, keeps the rest', () => {
    const out = redact({
      table: 'sys_script', password: 'p1', password2: 'p2', token: 't', client_secret: 'c', secret: 's', api_key: 'k', apiKey: 'k2',
      Authorization: 'Bearer x', refresh_token: 'r', nested: { db_password: 'p3', list: [{ token: 't2', keep: 'ok' }] },
    });
    expect(out).toEqual({
      table: 'sys_script', password: REDACTED, password2: REDACTED, token: REDACTED, client_secret: REDACTED, secret: REDACTED, api_key: REDACTED, apiKey: REDACTED,
      Authorization: REDACTED, refresh_token: REDACTED, nested: { db_password: REDACTED, list: [{ token: REDACTED, keep: 'ok' }] },
    });
  });

  it('redacts every header value, keeping header names', () => {
    expect(redact({ url: 'u', headers: { 'X-SN-Instance': 'devtest', Cookie: 'c=1' } })).toEqual({ url: 'u', headers: { 'X-SN-Instance': REDACTED, Cookie: REDACTED } });
  });

  it('a call on a secret table keeps arg names only, and drops the target name', () => {
    for (const t of ['sys_auth_profile_basic', 'oauth_entity_profile', 'discovery_credentials', 'sys_properties']) expect(isSecretTable(t)).toBe(true);
    expect(isSecretTable('sys_script')).toBe(false);
    const e = buildCapture(call({ name: 'sn_record_manage', args: { action: 'update', table: 'sys_properties', sys_id: SYS, name: 'glide.x', data: { value: 'hidden' } } }), new SessionContext());
    expect(e.args).toEqual({ action: REDACTED, table: REDACTED, sys_id: REDACTED, name: REDACTED, data: { value: REDACTED } });
    expect(e.targets).toEqual([{ kind: 'record', instance: '', table: 'sys_properties', sysId: SYS }]);
    expect(JSON.stringify(e)).not.toContain('hidden');
  });

  it('a gateway call on a secret table is caught by its inner args', () => {
    const e = buildCapture(call({ name: 'tool_execute', args: { tool: 'sn_record_manage', args: { action: 'create', table: 'oauth_entity', data: { client_secret: 'zz', name: 'n' } } } }), new SessionContext());
    expect(JSON.stringify(e.args)).not.toMatch(/zz|"n"/);
  });

  it('cleans key=value secrets out of error text', () => {
    expect(redactText('login failed: password=hunter2; token: abc123 user=admin')).toBe(`login failed: password=${REDACTED}; token: ${REDACTED} user=admin`);
    expect(redactText('{"api_key":"k-1","x":1}')).toBe(`{"api_key":"${REDACTED}","x":1}`);
  });

  it('debug lines get arg names only', () => {
    expect(argNames({ tool: 'sn_record_manage', args: { table: 't', password: 'p' } })).toEqual(['tool', 'args', 'args.table', 'args.password']);
  });
});

describe('capture events', () => {
  it('reads the outcome from isError, success:false and JSON-RPC errors', () => {
    expect(outcome(text({ success: true }))).toEqual({ ok: true });
    expect(outcome(text({ success: false, error: 'No such table' }))).toEqual({ ok: false, error: 'No such table' });
    expect(outcome({ ...text({ message: 'denied' }), isError: true })).toEqual({ ok: false, error: 'denied' });
    expect(outcome(undefined, { code: -32602, message: 'bad' })).toEqual({ ok: false, error: 'bad' });
  });

  it('takes result sys_ids from data and result.data', () => {
    const ctx = new SessionContext('devtest');
    const a = buildCapture(call({ name: 'sn_record_manage', args: { action: 'create', table: 'sys_script' }, result: text({ success: true, data: { sys_id: SYS } }) }), ctx);
    expect(a.resultSysIds).toEqual([SYS]);
    expect(a.targets).toContainEqual({ kind: 'record', instance: 'devtest', table: 'sys_script', sysId: SYS });
    const b = buildCapture(call({ name: 'tool_execute', args: { tool: 'sn_push_artifact', args: { table: 'sp_widget' } }, result: text({ success: true, tool: 'sn_push_artifact', result: { success: true, data: { sys_id: SYS } } }) }), ctx);
    expect(b.resultSysIds).toEqual([SYS]);
    expect(b.innerTool).toBe('sn_push_artifact');
  });

  it('tracks the update set a session makes current, and the session user', () => {
    const ctx = new SessionContext();
    buildCapture(call({ name: 'sn_session_context', result: text({ success: true, data: { user_name: 'agent.user' } }) }), ctx);
    buildCapture(call({ name: 'sn_update_set_manage', args: { action: 'create', name: 'Card offers v2' }, result: text({ success: true, data: { sys_id: SYS } }) }), ctx);
    const e = buildCapture(call({ name: 'sn_execute_background_script', args: { script: 'gs.info(1)' } }), ctx);
    expect(e).toMatchObject({ user: 'agent.user', updateSet: { sysId: SYS, name: 'Card offers v2' } });
    // A list does not change it; a failed switch does not either.
    buildCapture(call({ name: 'sn_update_set_manage', args: { action: 'list' } }), ctx);
    buildCapture(call({ name: 'sn_update_set_manage', args: { action: 'set_current', name: 'Other' }, result: text({ success: false, error: 'x' }) }), ctx);
    expect(ctx.updateSet).toEqual({ sysId: SYS, name: 'Card offers v2' });
  });

  it('marks a cancelled call and LiveMap\'s own calls', () => {
    expect(buildCapture(call({ cancelled: true, result: undefined }), new SessionContext())).toMatchObject({ ok: false, error: 'cancelled' });
    expect(buildCapture(call({ own: true }), new SessionContext()).own).toBe(true);
  });

  it('the server re-classifies: a capture cannot turn a read into a write, and own calls are dropped', () => {
    const read = captureEvents({ source: 'mcp-proxy', sessionId: 's', callId: '1', tool: 'sn_query_table', args: { table: 'sys_script' }, targets: [{ table: 'sys_script', sysId: SYS }], resultSysIds: [SYS], start: 1, end: 2, ok: true }, 10);
    expect(read[0].tool).toMatchObject({ access: 'read' });
    expect(read[0].tool?.targets).toBeUndefined();
    expect(captureEvents({ source: 'mcp-proxy', sessionId: 's', callId: '1', tool: 'echo', args: {}, start: 1, end: 2, own: true }, 10)).toEqual([]);
    expect(captureEvents({ source: 'mcp-proxy', sessionId: 's', tool: 'echo', start: 1, end: 2 }, 10)).toEqual([]);
  });
});

describe('mcp-proxy command line', () => {
  const err = (m: string): never => { throw new Error(m); };
  it('takes an HTTP upstream with headers, or a command', () => {
    expect(parseProxyArgs(['--upstream', 'http://127.0.0.1:3006/mcp', '--header', 'X-SN-Instance=devtest'], err)).toMatchObject({ upstream: 'http://127.0.0.1:3006/mcp', headers: { 'X-SN-Instance': 'devtest' } });
    expect(parseProxyArgs(['--upstream-cmd', 'skyforge mcp serve'], err)).toMatchObject({ upstreamCmd: 'skyforge mcp serve' });
  });
  it('refuses both, neither, bad URLs and stray options', () => {
    expect(() => parseProxyArgs([], err)).toThrow(/exactly one/);
    expect(() => parseProxyArgs(['--upstream', 'http://x/mcp', '--upstream-cmd', 'x'], err)).toThrow(/exactly one/);
    expect(() => parseProxyArgs(['--upstream', 'ftp://x'], err)).toThrow(/http/);
    expect(() => parseProxyArgs(['--upstream', 'http://x/mcp', '--header', 'novalue'], err)).toThrow(/NAME=VALUE/);
    expect(() => parseProxyArgs(['--upstream', 'http://x/mcp', '--nope'], err)).toThrow(/unknown/);
  });
  it('on Windows, only bare names and .cmd scripts run through a shell', () => {
    expect(needsShell('npx')).toBe(true);
    expect(needsShell('skyforge.cmd')).toBe(true);
    expect(needsShell('C:\\Program Files\\nodejs\\node.exe')).toBe(false);
    expect(needsShell('/usr/bin/node')).toBe(false);
    // Quoted for the program, then every cmd.exe special character (quotes, spaces, & | < > ^ %) escaped with ^.
    expect(quoteForCmd('C:\\Program Files\\x')).toBe('^"C:\\Program^ Files\\x^"');
    expect(quoteForCmd('a&b|c<d>e^f%g')).toBe('^"a^&b^|c^<d^>e^^f^%g^"');
    expect(quoteForCmd('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmd('my tool&x')).toBe('my^ tool^&x');
  });
});

describe('review fixes: gateway reads, redaction gaps', () => {
  const viaServer = (name: string, args: unknown, result: unknown = text({ success: true })) =>
    captureEvents(JSON.parse(JSON.stringify(buildCapture(call({ name, args, result }), new SessionContext()))) as Record<string, unknown>, 10_000);

  it('tool_execute(sn_record_manage) with a read action is stored as a read on the server', () => {
    for (const action of ['get', 'list', 'query']) {
      const evs = viaServer('tool_execute', { tool: 'sn_record_manage', args: { action, table: 'sys_script', sys_id: SYS } });
      expect(evs[0].tool, action).toMatchObject({ name: 'tool_execute', inner: 'sn_record_manage', access: 'read' });
      expect(evs[0].tool?.targets).toBeUndefined();
      expect(evs[0].tool?.input).toEqual({ tool: 'sn_record_manage', args: { action, table: 'sys_script', sys_id: SYS } });
    }
    expect(viaServer('tool_execute', { tool: 'sn_record_manage', args: { action: 'update', table: 'sys_script', sys_id: SYS } })[0].tool).toMatchObject({ access: 'write' });
  });

  it('inner args sent as a JSON string are redacted in parsed form; a string that does not parse is names only', () => {
    const e = buildCapture(call({ name: 'tool_execute', args: { tool: 'sn_record_manage', args: JSON.stringify({ action: 'update', table: 't', password: 'p', data: { accessToken: 'a' } }) } }), new SessionContext());
    expect(e.args).toEqual({ tool: 'sn_record_manage', args: { action: 'update', table: 't', password: REDACTED, data: { accessToken: REDACTED } } });
    const bad = buildCapture(call({ name: 'tool_execute', args: { tool: 'sn_record_manage', args: '{"password":"p", oops' } }), new SessionContext());
    expect(bad.args).toEqual({ tool: 'sn_record_manage', args: REDACTED });
  });

  it('script bodies are names only', () => {
    const out = redact({ script: 'var pw = "hunter2";', condition: 'x', client_script: 'y', data: { server_script: 'z', template: '<div/>' } });
    expect(out).toEqual({ script: REDACTED, condition: REDACTED, client_script: REDACTED, data: { server_script: REDACTED, template: '<div/>' } });
  });

  it('every string leaf is scrubbed, not only errors', () => {
    expect(redact({ note: 'connect with password=abc and Bearer eyJhbGci.x.y', list: ['token: t1'] })).toEqual({
      note: `connect with password=${REDACTED} and Bearer ${REDACTED}`, list: [`token: ${REDACTED}`],
    });
  });

  it('matches camelCase and other secret spellings', () => {
    const keys = ['accessToken', 'clientSecret', 'refreshToken', 'pwd', 'passphrase', 'cookie', 'Set-Cookie', 'private_key', 'credential', 'credentials', 'X-Api-Key', 'basic_auth', 'password2'];
    const out = redact(Object.fromEntries(keys.map((k) => [k, 'v']))) as Record<string, unknown>;
    for (const k of keys) expect(out[k], k).toBe(REDACTED);
    expect(redact({ author: 'a', tokenizer_name: 'b', table: 'c' })).toEqual({ author: 'a', tokenizer_name: 'b', table: 'c' });
  });

  it('redacts the value of a secret name-value pair', () => {
    expect(redact({ fields: [{ name: 'password', value: 'x' }, { name: 'title', value: 'keep' }, { key: 'clientSecret', default_value: 'y' }] })).toEqual({
      fields: [{ name: 'password', value: REDACTED }, { name: 'title', value: 'keep' }, { key: 'clientSecret', default_value: REDACTED }],
    });
  });

  it('past the depth limit the rest is replaced, not sent raw', () => {
    let deep: Record<string, unknown> = { leaf: 'secret-ish' };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).not.toContain('secret-ish');
    expect(JSON.stringify(redact(deep))).toContain(REDACTED);
  });
});

describe('update sets: shapes seen on the real SkyForge MCP', () => {
  const US_A = '1'.repeat(32);
  const US_B = '2'.repeat(32);
  const learn = (ctx: SessionContext, name: string, args: unknown, result: unknown) => buildCapture(call({ name, args, result: text(result) }), ctx);

  it('create makes the new set current, from the result sys_id; work starts with no switch', () => {
    const ctx = new SessionContext();
    const e = learn(ctx, 'sn_update_set_manage', { action: 'create', name: 'CC offers' }, { success: true, data: { sys_id: US_A, name: 'CC offers' } });
    expect(ctx.updateSet).toEqual({ sysId: US_A, name: 'CC offers' });
    expect(e.updateSet).toEqual({ sysId: US_A, name: 'CC offers' });
  });

  it('switch uses update_set_id', () => {
    const ctx = new SessionContext();
    learn(ctx, 'sn_update_set_manage', { action: 'switch', update_set_id: US_B }, { success: true, data: { sys_id: US_B } });
    expect(ctx.updateSet).toEqual({ sysId: US_B });
  });

  it('current is a read that tells the session its current set', () => {
    const ctx = new SessionContext();
    const e = learn(ctx, 'sn_update_set_manage', { action: 'current' }, { success: true, data: { sys_id: US_A, name: 'CC offers', state: 'in progress' } });
    expect(ctx.updateSet).toEqual({ sysId: US_A, name: 'CC offers' });
    expect(captureEvents(JSON.parse(JSON.stringify(e)) as Record<string, unknown>, 10_000)[0].tool?.access).toBe('read');
  });

  it('reads (list, preview, export) and other writes (add_artifact, force_capture, ignore) leave the current set alone', () => {
    const ctx = new SessionContext();
    learn(ctx, 'sn_update_set_manage', { action: 'switch', update_set_id: US_A }, { success: true });
    for (const action of ['list', 'preview', 'export', 'add_artifact', 'force_capture', 'ignore']) {
      const e = learn(ctx, 'sn_update_set_manage', { action, update_set_id: US_B, table: 'sys_script', sys_id: SYS }, { success: true, data: { sys_id: US_B } });
      expect(ctx.updateSet, action).toEqual({ sysId: US_A });
      const access = captureEvents(JSON.parse(JSON.stringify(e)) as Record<string, unknown>, 10_000)[0].tool?.access;
      expect(access, action).toBe(['list', 'preview', 'export'].includes(action) ? 'read' : 'write');
    }
  });

  it('sn_ensure_active_update_set makes the named set current, with its sys_id from the result', () => {
    const ctx = new SessionContext();
    learn(ctx, 'sn_ensure_active_update_set', { name: 'CC offers', sync_with_user: true }, { success: true, data: { sys_id: US_A, name: 'CC offers', created: false } });
    expect(ctx.updateSet).toEqual({ sysId: US_A, name: 'CC offers' });
    const viaGateway = new SessionContext();
    learn(viaGateway, 'tool_execute', { tool: 'sn_ensure_active_update_set', args: { name: 'CC offers', sync_with_user: true } }, { success: true, tool: 'sn_ensure_active_update_set', result: { success: true, data: { sys_id: US_A } } });
    expect(viaGateway.updateSet).toEqual({ sysId: US_A, name: 'CC offers' });
  });

  it('sn_switch_application_scope leaves the current set unknown until a result or a current read names it', () => {
    for (const create of [true, false]) {
      const ctx = new SessionContext();
      learn(ctx, 'sn_update_set_manage', { action: 'switch', update_set_id: US_A }, { success: true });
      learn(ctx, 'sn_switch_application_scope', { scope: 'x_app', create_update_set: create }, { success: true, data: { scope: 'x_app' } });
      expect(ctx.updateSet, String(create)).toEqual({ unknown: true });
      learn(ctx, 'sn_update_set_manage', { action: 'current' }, { success: true, data: { sys_id: US_B, name: 'x_app work' } });
      expect(ctx.updateSet).toEqual({ sysId: US_B, name: 'x_app work' });
    }
    const named = new SessionContext();
    learn(named, 'sn_switch_application_scope', { scope: 'x_app', create_update_set: true }, { success: true, data: { update_set: { sys_id: US_B, name: 'x_app 1' } } });
    expect(named.updateSet).toEqual({ sysId: US_B, name: 'x_app 1' });
  });

  it('a failed change does not move the current set', () => {
    const ctx = new SessionContext();
    learn(ctx, 'sn_update_set_manage', { action: 'switch', update_set_id: US_A }, { success: true });
    learn(ctx, 'sn_ensure_active_update_set', { name: 'Other' }, { success: false, error: 'no' });
    expect(ctx.updateSet).toEqual({ sysId: US_A });
  });
});

describe('poster safety and instance matching', () => {
  it('a bad port or token never throws, and the event is dropped', async () => {
    const poster = new HookPoster({ runtimes: () => [{ root: '/p/.livemap/sn', port: 70_000, token: 't', pid: 1 }, { root: '/q/.livemap/sn', port: 1234, token: 'bad\ntoken', pid: 1 }] });
    poster.send({ x: 1 });
    await poster.flushed();
    expect(poster.delivered).toBe(0);
  });

  it('liveRuntimes skips run files with a bad port or token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-runs-'));
    try {
      const w = (n: string, o: unknown) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
      w('ok.json', { root: '/a/.livemap/sn', port: 4317, token: 'abc', pid: process.pid });
      w('port.json', { root: '/b/.livemap/sn', port: 0, token: 'abc', pid: process.pid });
      w('token.json', { root: '/c/.livemap/sn', port: 4318, token: 'a b\r\n', pid: process.pid });
      fs.writeFileSync(path.join(dir, 'junk.json'), '{');
      expect(liveRuntimes(dir).map((e) => e.root)).toEqual(['/a/.livemap/sn']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('only runs that mirror the proxy instance get events; a run that cannot tell gets them too', async () => {
    const got: number[] = [];
    const servers = await Promise.all([0, 1, 2].map(async (i) => {
      const s = http.createServer((_req, res) => { got.push(i); res.writeHead(200).end('{}'); });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      return s;
    }));
    try {
      const runs = servers.map((s, i) => ({ root: `/r${i}/.livemap/sn`, port: (s.address() as AddressInfo).port, token: 't', pid: process.pid }));
      const inst: Record<string, string[]> = { '/r0/.livemap/sn': ['devtest'], '/r1/.livemap/sn': ['prod'], '/r2/.livemap/sn': [] };
      const poster = new HookPoster({ runtimes: () => runs, instance: 'DevTest', instancesOf: (e) => inst[e.root] });
      poster.send({ x: 1 });
      await poster.flushed();
      expect(got.sort()).toEqual([0, 2]);
    } finally {
      for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe('mcp-proxy --timeout', () => {
  const err = (m: string): never => { throw new Error(m); };
  it('defaults to 600 s and takes seconds', () => {
    expect(parseProxyArgs(['--upstream', 'http://x/mcp'], err).timeoutMs).toBe(600_000);
    expect(parseProxyArgs(['--upstream', 'http://x/mcp', '--timeout', '1200'], err).timeoutMs).toBe(1_200_000);
    expect(() => parseProxyArgs(['--upstream', 'http://x/mcp', '--timeout', '0'], err)).toThrow(/timeout/);
    expect(() => parseProxyArgs(['--upstream-cmd', 'x', '--timeout', '5'], err)).toThrow(/only apply/);
  });
});
