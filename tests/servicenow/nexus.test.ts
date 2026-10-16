import { describe, it, expect, afterEach } from 'vitest';
import { assertReadOnly, NotAllowedError, READ_ONLY_TOOLS } from '../../plugins/servicenow/allowlist.js';
import { NexusClient, NexusOfflineError, NexusToolError, INSTANCE_HEADER, unwrapResult } from '../../plugins/servicenow/nexus.js';
import { loadFixture, matches, startMockNexus, type MockNexus } from '../helpers/mock-nexus.js';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const o of open.splice(0).reverse()) await o.close(); });
async function mock(opts: Parameters<typeof startMockNexus>[0] = {}): Promise<MockNexus> {
  const m = await startMockNexus(opts);
  open.push(m);
  return m;
}
function client(m: MockNexus, opts: ConstructorParameters<typeof NexusClient>[0] = {}): NexusClient {
  const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', backoffMs: 1, ...opts });
  open.push(c);
  return c;
}

describe('read-only allowlist', () => {
  it('allows exactly the read tools, directly and through tool_execute', () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual(['sn_get_instance_info', 'sn_get_table_metadata', 'sn_query_table', 'sn_session_context', 'tool_search']);
    for (const t of READ_ONLY_TOOLS) {
      expect(() => assertReadOnly(t, {})).not.toThrow();
      expect(() => assertReadOnly('tool_execute', { tool: t, args: {} })).not.toThrow();
    }
  });

  it('refuses every other tool name, direct or wrapped', () => {
    const writes = [
      'sn_record_manage', 'sn_execute_background_script', 'sn_update_set_manage', 'sn_push_artifact', 'sn_pull_artifact',
      'sn_intermediate_flow', 'sn_schedule_script_job', 'sn_create_field', 'sn_delete_record', 'sn_load_skill',
      'sn_discover_platform_tables', 'sn_aggregate_metrics', 'SN_QUERY_TABLE', 'sn_query_table ', '', 'tool_execute',
    ];
    for (const t of writes) {
      if (t !== 'tool_execute') expect(() => assertReadOnly(t, {}), t).toThrow(NotAllowedError);
      expect(() => assertReadOnly('tool_execute', { tool: t, args: {} }), `tool_execute(${t})`).toThrow(NotAllowedError);
    }
    expect(() => assertReadOnly('tool_execute', {})).toThrow(NotAllowedError);
    expect(() => assertReadOnly('tool_execute', { tool: 'tool_execute', args: { tool: 'sn_query_table' } })).toThrow(NotAllowedError);
  });

  it('a refused call never reaches nexus', async () => {
    const m = await mock();
    const c = client(m);
    await expect(c.call('sn_record_manage', { table: 'sys_script', action: 'update' })).rejects.toThrow(NotAllowedError);
    await expect(c.execute('sn_execute_background_script', { script: 'gs.info(1)' })).rejects.toThrow(NotAllowedError);
    expect(m.calls).toEqual([]);
  });
});

describe('NexusClient', () => {
  it('connects over Streamable HTTP and sends the instance header', async () => {
    const m = await mock();
    const c = client(m);
    const body = await c.call('sn_query_table', { table: 'sp_portal', limit: 1 }) as { data: { records: { url_suffix: string }[] } };
    expect(body.data.records[0].url_suffix).toBe('bharatbank-cc');
    expect(c.transport).toBe('http');
    expect(c.state).toBe('online');
    expect(m.headers.some(h => h[INSTANCE_HEADER.toLowerCase()] === 'inmorphisdemo3')).toBe(true);
  });

  it('falls back to SSE when Streamable HTTP is refused, and still sends the header', async () => {
    const m = await mock({ sseOnly: true });
    const c = client(m);
    const recs = await c.query('sp_page', { query: 'id=cc_documents' });
    expect(recs.map(r => r.id)).toEqual(['cc_documents']);
    expect(c.transport).toBe('sse');
    expect(m.sessions).toContain('sse');
    expect(m.headers.filter(h => h.accept === 'text/event-stream').every(h => h[INSTANCE_HEADER.toLowerCase()] === 'inmorphisdemo3')).toBe(true);
  });

  it('pages by has_more, not by total (which can read "100+")', async () => {
    const m = await mock({ plusTotals: true });
    const c = client(m);
    const fx = loadFixture();
    const recs = await c.query('sys_metadata', { query: `sys_scope=${fx.scope.sys_id}`, pageSize: 200 });
    expect(recs).toHaveLength(1683);
    const pages = m.calls.filter(x => x.tool === 'sn_query_table');
    expect(pages).toHaveLength(9);
    expect(pages.map(p => p.args.offset)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600]);
    expect(pages.every(p => p.args.truncate_output === false && p.args.limit === 200)).toBe(true);
  });

  it('stops on a short page, since nexus says has_more for every full page', async () => {
    const m = await mock();
    const c = client(m);
    const fx = loadFixture();
    // 1,683 = 3 x 561: three full pages each say has_more, so a fourth, empty page ends it.
    expect(await c.query('sys_metadata', { query: `sys_scope=${fx.scope.sys_id}`, pageSize: 561 })).toHaveLength(1683);
    expect(m.calls.filter(x => x.tool === 'sn_query_table').map(p => p.args.offset)).toEqual([0, 561, 1122, 1683]);
    m.calls.length = 0;
    // One short page: no second query.
    expect(await c.query('sp_portal')).toHaveLength(1);
    expect(m.calls.filter(x => x.tool === 'sn_query_table')).toHaveLength(1);
  });

  it('stops on a short page even when has_more is still true', async () => {
    const m = await mock({ alwaysMore: true });
    const c = client(m);
    expect(await c.query('sp_portal')).toHaveLength(1);
    expect(m.calls.filter(x => x.tool === 'sn_query_table')).toHaveLength(1);
  });

  it('retries a failing call with backoff and then answers', async () => {
    const m = await mock({ failCalls: 2 });
    const waits: number[] = [];
    const c = client(m, { backoffMs: 100, sleep: async (ms) => { waits.push(ms); } });
    const recs = await c.query('sp_portal');
    expect(recs).toHaveLength(1);
    expect(waits).toEqual([100, 200]);
  });

  it('is offline after the last failed attempt, and online again once nexus answers', async () => {
    const m = await mock({ failCalls: 3 });
    const c = client(m, { attempts: 3 });
    await expect(c.query('sp_portal')).rejects.toThrow(NexusOfflineError);
    expect(c.state).toBe('offline');
    expect(await c.query('sp_portal')).toHaveLength(1);
    expect(c.state).toBe('online');
  });

  it('is offline when nexus is down', async () => {
    const m = await mock();
    const url = m.url;
    await m.close();
    open.splice(open.indexOf(m), 1);
    const c = new NexusClient({ url, attempts: 2, backoffMs: 1 });
    open.push(c);
    await expect(c.query('sp_portal')).rejects.toThrow(NexusOfflineError);
    expect(c.state).toBe('offline');
  });

  it('does not retry a tool error', async () => {
    const m = await mock({ failTables: ['sys_auth_profile'] });
    const c = client(m);
    await expect(c.query('sys_auth_profile')).rejects.toThrow(NexusToolError);
    expect(m.calls.filter(x => x.tool === 'sn_query_table')).toHaveLength(1);
  });

  it('enables a tool with tool_search when tool_execute refuses it, then runs it', async () => {
    const m = await mock({ needsSearch: ['sn_get_instance_info'] });
    const c = client(m);
    expect(await c.execute('sn_get_instance_info')).toMatchObject({ data: { instance_name: 'inmorphisdemo3' } });
    expect(m.calls.map(x => x.inner ?? x.tool)).toEqual(['sn_get_instance_info', 'tool_search', 'sn_get_instance_info']);
  });
});

describe('unwrapResult', () => {
  const t = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  it('reads direct and tool_execute shapes', () => {
    expect(unwrapResult('x', t({ success: true, data: { a: 1 } }))).toEqual({ success: true, data: { a: 1 } });
    expect(unwrapResult('x', t({ success: true, tool: 'y', result: { success: true, data: { b: 2 } } }))).toEqual({ success: true, data: { b: 2 } });
  });
  it('turns success:false and isError into NexusToolError', () => {
    expect(() => unwrapResult('x', t({ success: false, error: 'Insufficient rights' }))).toThrow(/Insufficient rights/);
    expect(() => unwrapResult('x', { ...t('boom'), isError: true })).toThrow(NexusToolError);
  });
});

describe('mock encoded queries', () => {
  it('matches =, !=, >, IN and STARTSWITH terms', () => {
    const r = { a: 'x', d: '2026-06-01 10:00:00', n: 'abc' };
    expect(matches(r, 'a=x^d>2026-05-31 00:00:00')).toBe(true);
    expect(matches(r, 'a!=x')).toBe(false);
    expect(matches(r, 'aINy,x^nSTARTSWITHab')).toBe(true);
  });
});
