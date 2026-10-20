import { describe, it, expect } from 'vitest';
import { argNames, buildCapture, isSecretTable, outcome, redact, redactText, REDACTED, SessionContext, type CallInput } from '../../src/proxy/capture.js';
import { needsShell, quoteForCmd } from '../../src/proxy/proxy.js';
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
    expect(quoteForCmd('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(quoteForCmd('plain')).toBe('plain');
  });
});
