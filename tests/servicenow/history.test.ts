import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullScope, resolveScope } from '../../plugins/servicenow/backfill.js';
import { importHistory, parsePayload, snTime, type HistoryEvent } from '../../plugins/servicenow/history.js';
import { layoutMirror } from '../../plugins/servicenow/mirror.js';
import { NexusClient } from '../../plugins/servicenow/nexus.js';
import { DEFAULT_LOG_WINDOW_MS, matchHistory, parseArgs, parseLog, toCall, type LogCall } from '../../plugins/servicenow/skyforge-log.js';
import { buildTimeline } from '../../plugins/servicenow/timeline.js';
import { historyPath, readHistory, snRoot, writeHistory, writeMirror } from '../../plugins/servicenow/writer.js';
import { rmTree } from '../helpers/platform.js';
import { loadFixture, startMockNexus, type MockNexus } from '../helpers/mock-nexus.js';

const fx = loadFixture();
const open: { close(): Promise<void> }[] = [];
let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-snh-'))); });
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  rmTree(dir);
});
async function setup(opts: Parameters<typeof startMockNexus>[0] = {}): Promise<{ m: MockNexus; c: NexusClient }> {
  const m = await startMockNexus(opts);
  open.push(m);
  const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', backoffMs: 1 });
  open.push(c);
  return { m, c };
}
async function pull(c: NexusClient) {
  const scope = await resolveScope(c, 'x_snc_cc_offering');
  const pulled = await pullScope(c, scope);
  const { manifest, files } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: snRoot(dir) });
  return { scope, pulled, manifest, files };
}
/** The fixture's 400 SkyForge log lines as a log file. */
function logFile(): string {
  const f = path.join(dir, 'skyforge-mcp.log');
  fs.writeFileSync(f, `${fx.mcpLogExcerpt.lines.join('\n')}\n`);
  return f;
}
const queriesOf = (m: MockNexus, table: string) => m.calls.filter(x => (x.inner ?? x.tool) === 'sn_query_table' && x.args.table === table);

describe('history import from the BharatBank fixture', () => {
  it('turns every sys_update_xml row into a dated event when the scope has no version rows', async () => {
    const { m, c } = await setup();
    const { scope, pulled } = await pull(c);
    const h = await importHistory(c, scope, pulled.inventory);
    expect(h.versions).toBe(0);
    expect(h.updateXml).toBe(183);
    expect(h.events).toHaveLength(183);
    expect(h.events.every(e => e.source === 'update_xml' && e.confidence === 'history')).toBe(true);
    expect(h.warnings).toEqual([]);
    // Oldest first, at the record's own save time (from the payload), not the rows' later bulk rewrite.
    const at = h.events.map(e => e.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Date(at[0]).toISOString().slice(0, 10)).toBe('2026-05-29');
    expect(h.events.filter(e => e.kind === 'deleted')).toHaveLength(fx.sys_update_xml.filter(r => r.action === 'DELETE').length);
    // Author is the row's sys_created_by.
    expect(new Set(h.events.map(e => e.author))).toEqual(new Set(fx.sys_update_xml.map(r => r.sys_created_by)));
    // A field created through SkyForge is a creation at 16:01:44 on 3 June, with its label and element as names.
    const field = h.events.find(e => e.table === 'sys_dictionary' && e.keys.includes('bureau pull date'))!;
    expect(field).toMatchObject({ kind: 'created', collection: 'x_snc_cc_offering_credit_card_application', author: 'admin' });
    expect(new Date(field.at).toISOString()).toBe('2026-06-03T16:01:44.000Z');
    expect(field.keys).toContain('bureau_pull_date');
    // Versions were looked up by every update name the scope uses, and none came back.
    expect(queriesOf(m, 'sys_update_version').length).toBeGreaterThan(0);
  });

  it('prefers sys_update_version rows when the instance has them', async () => {
    const { c } = await setup({ versions: true });
    const { scope, pulled } = await pull(c);
    const h = await importHistory(c, scope, pulled.inventory);
    expect(h.versions).toBe(183);
    expect(h.fromUpdateXml).toBe(0);
    expect(h.events).toHaveLength(183);
    expect(h.events.every(e => e.source === 'version')).toBe(true);
  });

  it('pages by short page, not has_more, with {link, value} references flattened', async () => {
    const { m, c } = await setup({ alwaysMore: true });
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    const h = await importHistory(c, scope, pulled.inventory, { pageSize: 50 });
    expect(h.events).toHaveLength(183);
    // 183 rows: pages at 0, 50, 100 and a short one at 150, though every page says has_more.
    const rows = queriesOf(m, 'sys_update_xml').filter(x => x.args.query === `application=${scope.sys_id}`);
    expect(rows.map(x => x.args.offset)).toEqual([0, 50, 100, 150]);
    // The mock wraps references (application, ids) as real nexus does; events only hold strings.
    const raw = await c.call('sn_query_table', { table: 'sys_update_xml', query: `application=${scope.sys_id}`, limit: 1 }) as { data: { records: Record<string, unknown>[] } };
    expect(raw.data.records[0].application).toEqual({ link: expect.any(String), value: scope.sys_id });
    for (const e of h.events) for (const v of [e.table, e.update, e.name, e.author, e.sysId ?? '']) expect(typeof v).toBe('string');
  });

  it('never reads a system property value or anything from a credential table', async () => {
    const prop = fx.tables.sys_metadata.rows.find(r => r[1] === 'sys_properties')!;
    const extra = [
      {
        sys_id: `5e${'0'.repeat(29)}1`, name: `sys_properties_${prop[0]}`, type: 'System Property', target_name: 'x.prop', action: 'INSERT_OR_UPDATE',
        update_set: '', sys_created_by: 'admin', sys_updated_on: '2026-06-20 10:00:00',
        payload: `<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><sys_id>${prop[0]}</sys_id><name>x.prop</name><value>PROPERTY-VALUE-1</value><sys_updated_on>2026-06-20 10:00:00</sys_updated_on></sys_properties></record_update>`,
      },
      {
        sys_id: `5e${'0'.repeat(29)}2`, name: `sys_auth_profile_basic_${'5e'.padEnd(32, '3')}`, type: 'Basic Auth', target_name: 'creds', action: 'INSERT_OR_UPDATE',
        update_set: '', sys_created_by: 'admin', sys_updated_on: '2026-06-20 10:00:00',
        payload: '<record_update table="sys_auth_profile_basic"><sys_auth_profile_basic action="INSERT_OR_UPDATE"><password2>CREDENTIAL-VALUE-2</password2></sys_auth_profile_basic></record_update>',
      },
    ];
    const { m, c } = await setup({ extraUpdateXml: extra, versions: false });
    const { scope, pulled, manifest } = await pull(c);
    m.calls.length = 0;
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: null });
    // The property's change is in the timeline (dates and author only); the credential record is not.
    expect(t.doc.events.some(e => e.update === extra[0].name)).toBe(true);
    expect(t.doc.events.some(e => e.update === extra[1].name || e.table.startsWith('sys_auth'))).toBe(false);
    // Neither payload was asked for, and no version query names the credential record.
    // (A chunk of ids is read in pages, so the same query appears once per page.)
    const payloadIds = new Set(queriesOf(m, 'sys_update_xml').filter(x => (x.args.fields as string[]).includes('payload')).flatMap(x => String(x.args.query).replace(/^sys_idIN/, '').split(',')));
    expect(payloadIds.has(extra[0].sys_id)).toBe(false);
    expect(payloadIds.has(extra[1].sys_id)).toBe(false);
    expect(payloadIds.size).toBe(183);
    for (const x of queriesOf(m, 'sys_update_version')) expect(String(x.args.query)).not.toContain('sys_auth_profile');
    // No query asked sys_properties for its value.
    for (const x of m.calls.filter(x => x.args.table === 'sys_properties')) expect(x.args.fields).not.toContain('value');
    // Nothing secret is stored.
    writeHistory(snRoot(dir), scope.scope, t.doc);
    const text = fs.readFileSync(historyPath(snRoot(dir), scope.scope), 'utf8');
    expect(text).not.toContain('PROPERTY-VALUE-1');
    expect(text).not.toContain('CREDENTIAL-VALUE-2');
    expect(text).not.toContain('password2');
  });
});

describe('payloads and times', () => {
  it('reads ServiceNow UTC times', () => {
    expect(new Date(snTime('2026-06-03 16:01:44')).toISOString()).toBe('2026-06-03T16:01:44.000Z');
    expect(snTime('')).toBeNaN();
    expect(snTime(undefined)).toBeNaN();
  });
  it('keeps only ids, times and names from a payload', () => {
    const p = parsePayload('<?xml version="1.0"?><record_update table="sp_widget"><sp_widget action="INSERT_OR_UPDATE"><sys_id>abc</sys_id><id>w-1</id><name>A &amp; B</name><script>var x = 1;</script><password2>p</password2><sys_updated_on>2026-06-01 00:00:00</sys_updated_on></sp_widget></record_update>');
    expect(p).toEqual({ table: 'sp_widget', fields: { sys_id: 'abc', id: 'w-1', name: 'A & B', sys_updated_on: '2026-06-01 00:00:00' } });
  });
});

describe('SkyForge log parsing', () => {
  const T = '2026-06-03T16:01:29.115Z';
  it('splits k=v pairs where a value holds a comma', () => {
    expect(parseArgs('tool=sn_create_sp_widget, name=<redacted>, id=w-a, option_schema=[{"a":1}, {"b":2}]..., ...+4 more'))
      .toEqual({ tool: 'sn_create_sp_widget', name: '<redacted>', id: 'w-a', option_schema: '[{"a":1}, {"b":2}]..., ...+4 more' });
  });
  it('keeps writes, with the record table, its collection and full names only', () => {
    const at = Date.parse(T);
    expect(toCall(1, at, 'tool_execute', parseArgs('tool=sn_create_field, table=x_app_t, column_name=<redacted>, column_label=Credit Score, internal_type=integer')))
      .toEqual({ line: 1, at, tool: 'sn_create_field', kind: 'create', table: 'sys_dictionary', collection: 'x_app_t', names: ['credit score'] });
    expect(toCall(2, at, 'tool_execute', parseArgs('tool=sn_create_sp_page, short_description=<redacted>, id=home, title=A very long title tha..., public=true')))
      .toMatchObject({ table: 'sp_page', names: ['home'] });
    expect(toCall(3, at, 'tool_execute', parseArgs(`tool=sn_record_manage, table=sp_instance, action=delete, sys_id=${'ab'.repeat(16)}`)))
      .toMatchObject({ kind: 'delete', table: 'sp_instance', sysId: 'ab'.repeat(16) });
    expect(toCall(4, at, 'tool_execute', parseArgs(`tool=sn_push_artifact, sys_id=${'cd'.repeat(16)}, directory=D:/work/artifacts/app/sp_widget/My Widget, validate=true`)))
      .toMatchObject({ kind: 'update', table: 'sp_widget', sysId: 'cd'.repeat(16), names: ['my widget'] });
    for (const read of ['tool=sn_query_table, table=sys_dictionary, limit=50', 'tool=sn_pull_artifact, table=sp_widget', 'tool=sn_update_set_manage, action=current']) {
      expect(toCall(5, at, 'tool_execute', parseArgs(read)), read).toBeNull();
    }
    expect(toCall(6, at, 'sn_query_table', parseArgs('table=x'))).toBeNull();
  });
  it('pairs a completion line with the start it ends', () => {
    const scan = parseLog([
      `[2026-06-03T16:01:29.107Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=A`,
      `[2026-06-03T16:01:29.115Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=B`,
      `[2026-06-03T16:01:30.871Z] [INFO] [Tool] sn_create_field ✅ 1756ms`,
      'not a log line',
    ].join('\n'));
    expect(scan.lines).toBe(4);
    expect(scan.parsed).toBe(3);
    expect(scan.calls.map(c => [c.names[0], c.ms])).toEqual([['a', undefined], ['b', 1756]]);
    expect(scan.calls[1].end).toBe(Date.parse('2026-06-03T16:01:30.871Z'));
  });
  it('reads every line of the fixture log', () => {
    const scan = parseLog(fx.mcpLogExcerpt.lines.join('\n'));
    expect(scan.lines).toBe(400);
    expect(scan.parsed).toBe(400);
    expect(scan.calls.length).toBeGreaterThan(0);
    expect(scan.calls.every(c => c.kind === 'create' || c.kind === 'update' || c.kind === 'delete')).toBe(true);
  });
});

describe('matching history to the log', () => {
  const at0 = Date.parse('2026-06-03T16:01:44Z');
  const ev = (over: Partial<HistoryEvent>): HistoryEvent => ({
    at: at0, kind: 'modified', table: 'sp_widget', update: 'u', name: 'n', keys: [], author: 'admin', source: 'version', confidence: 'history', ...over,
  });
  const call = (over: Partial<LogCall>): LogCall => ({ line: 1, at: at0 - 2000, tool: 'sn_record_manage', kind: 'update', table: 'sp_widget', names: [], ...over });
  const id = 'ef'.repeat(16);

  it('matches an update by sys_id and a create by table and name: log', () => {
    const upd = ev({ sysId: id });
    const crt = ev({ kind: 'created', table: 'sys_dictionary', keys: ['credit score'], collection: 'x_app_t' });
    const counts = matchHistory([upd, crt], [
      call({ sysId: id }),
      call({ line: 2, tool: 'sn_create_field', kind: 'create', table: 'sys_dictionary', collection: 'x_app_t', names: ['credit score'] }),
    ]);
    expect(counts).toEqual({ events: 2, matched: 2, ambiguous: 0, timeOnly: 0, unmatched: 0 });
    expect(upd).toMatchObject({ confidence: 'log', log: [{ line: 1, tool: 'sn_record_manage' }] });
    expect(crt).toMatchObject({ confidence: 'log', log: [{ line: 2, tool: 'sn_create_field' }] });
  });

  it('keeps every candidate when two calls name the record: likely', () => {
    const e = ev({ keys: ['w-a'] });
    const counts = matchHistory([e], [call({ names: ['w-a'] }), call({ line: 2, names: ['w-a'], at: at0 + 5000 })]);
    expect(counts.ambiguous).toBe(1);
    expect(e.confidence).toBe('likely');
    expect(e.log?.map(r => r.line)).toEqual([1, 2]);
  });

  it('never makes a table and time match more than likely', () => {
    const e = ev({ sysId: id, keys: ['w-a'] });
    const counts = matchHistory([e], [call({ sysId: 'aa'.repeat(16) }), call({ line: 2 })]);
    expect(counts).toMatchObject({ matched: 0, timeOnly: 1 });
    expect(e.confidence).toBe('likely');
    expect(e.log).toHaveLength(2);
  });

  it('leaves events outside the window, on another table or collection, or of another kind as history', () => {
    const e = [
      ev({ sysId: id, at: at0 + DEFAULT_LOG_WINDOW_MS + 5000 }),
      ev({ sysId: id, table: 'sp_page' }),
      ev({ kind: 'created', table: 'sys_dictionary', keys: ['credit score'], collection: 'x_other' }),
      ev({ kind: 'deleted', sysId: id }),
    ];
    const calls = [
      call({ sysId: id }),
      call({ line: 2, tool: 'sn_create_field', kind: 'create', table: 'sys_dictionary', collection: 'x_app_t', names: ['credit score'] }),
    ];
    expect(matchHistory(e, calls)).toMatchObject({ matched: 0, ambiguous: 0, timeOnly: 0, unmatched: 4 });
    expect(e.every(x => x.confidence === 'history' && x.log === undefined)).toBe(true);
    // A wider window reaches the first one.
    expect(matchHistory([e[0]], calls, DEFAULT_LOG_WINDOW_MS + 10_000).matched).toBe(1);
  });

  it('measures the match rate on the fixture (183 rows, 400 log lines)', async () => {
    const { c } = await setup();
    const { scope, pulled, manifest, files } = await pull(c);
    writeMirror(snRoot(dir), files, manifest);
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: logFile() });
    expect(t.doc.log).toMatchObject({ found: true, lines: 400, parsed: 400, windowMs: 60_000 });
    expect(t.doc.counts).toEqual({ events: 183, matched: 30, ambiguous: 0, timeOnly: 12, unmatched: 141 });
    // Every log match names its record; every likely one keeps its candidates.
    for (const e of t.doc.events) {
      if (e.confidence === 'log') expect(e.log).toHaveLength(1);
      if (e.confidence === 'likely') expect(e.log!.length).toBeGreaterThan(0);
      if (e.confidence === 'history') expect(e.log).toBeUndefined();
    }
    const byTable = (conf: string) => [...new Set(t.doc.events.filter(e => e.confidence === conf).map(e => e.table))].sort();
    expect(byTable('log')).toEqual(['sp_page', 'sp_widget', 'sys_dictionary']);
    // Events of mirrored records point at their file.
    const withPath = t.doc.events.filter(e => e.path);
    expect(withPath.length).toBeGreaterThan(100);
    for (const e of withPath) expect(files.has(e.path!), e.path).toBe(true);
    // Stored next to the manifest, and the mirror's .gitignore hides it from the map.
    writeHistory(snRoot(dir), scope.scope, t.doc);
    expect(readHistory<typeof t.doc>(snRoot(dir), scope.scope)?.counts.matched).toBe(30);
    expect(fs.readFileSync(path.join(snRoot(dir), '.gitignore'), 'utf8')).toContain('*.history.json');
  });

  it('skips attribution when there is no log', async () => {
    const { c } = await setup();
    const { scope, pulled, manifest } = await pull(c);
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: path.join(dir, 'missing.log') });
    expect(t.log).toBeNull();
    expect(t.doc.log).toMatchObject({ found: false, lines: 0 });
    expect(t.doc.counts).toMatchObject({ events: 183, matched: 0, unmatched: 183 });
  });
});
