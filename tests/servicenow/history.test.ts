import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullScope, resolveScope, sessionUser } from '../../plugins/servicenow/backfill.js';
import { importHistory, parsePayload, snTime, type HistoryEvent } from '../../plugins/servicenow/history.js';
import { layoutMirror } from '../../plugins/servicenow/mirror.js';
import { NexusClient, NexusDeadlineError } from '../../plugins/servicenow/nexus.js';
import { DEFAULT_LOG_WINDOW_MS, LOG_LEAD_MS, instanceName, matchHistory, parseArgs, parseLog, toCall, toolRole, type LogCall } from '../../plugins/servicenow/skyforge-log.js';
import { buildTimeline, homeRelative } from '../../plugins/servicenow/timeline.js';
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
/** The connect line SkyForge writes when it signs in to an instance. */
const AUTH_LINE = '[2026-05-29T00:00:00.000Z] [INFO] [Auth] ✅ Connected to inmorphisdemo3.service-now.com';
/** The fixture's 400 SkyForge log lines as a log file, after a connect line unless `connected` is false. */
function logFile(connected = true): string {
  const f = path.join(dir, 'skyforge-mcp.log');
  fs.writeFileSync(f, `${[...(connected ? [AUTH_LINE] : []), ...fx.mcpLogExcerpt.lines].join('\n')}\n`);
  return f;
}
const saves = (es: HistoryEvent[]) => es.filter(e => e.kind !== 'captured');
const queriesOf = (m: MockNexus, table: string) => m.calls.filter(x => (x.inner ?? x.tool) === 'sn_query_table' && x.args.table === table);

const xmlRow = (over: Record<string, string>) => ({
  sys_id: '', name: '', type: 'Widget', target_name: '', action: 'INSERT_OR_UPDATE', update_set: '', sys_created_by: 'admin', sys_updated_on: '2026-06-20 10:00:00', payload: '', ...over,
});
const xid = (n: number) => `5e${String(n).padStart(30, '0')}`;

describe('history import from the BharatBank fixture', () => {
  it('turns every sys_update_xml row into a dated event when the scope has no version rows', async () => {
    const { m, c } = await setup();
    const { scope, pulled } = await pull(c);
    const h = await importHistory(c, scope, pulled.inventory, { full: pulled.full });
    expect(h).toMatchObject({ versions: 0, updateXml: 183, versionsBy: null, partial: false, warnings: [] });
    expect(h.xmlEvents).toBe(saves(h.events).length);
    expect(h.versionEvents).toBe(0);
    expect(h.events.every(e => e.source === 'update_xml' && e.confidence === 'history')).toBe(true);
    // Oldest first, at the record's own save time (from the payload), not the rows' later bulk rewrite.
    const at = h.events.map(e => e.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Date(at[0]).toISOString().slice(0, 10)).toBe('2026-05-29');
    expect(h.events.filter(e => e.kind === 'deleted')).toHaveLength(fx.sys_update_xml.filter(r => r.action === 'DELETE').length);
    // A field created through SkyForge is a creation at 16:01:44 on 3 June, with its label and element as names.
    const field = h.events.find(e => e.table === 'sys_dictionary' && e.keys.includes('bureau pull date'))!;
    expect(field).toMatchObject({ kind: 'created', collection: 'x_snc_cc_offering_credit_card_application', author: 'admin' });
    expect(new Date(field.at).toISOString()).toBe('2026-06-03T16:01:44.000Z');
    expect(field.keys).toContain('bureau_pull_date');
    // The rows were rewritten in bulk weeks after their saves: each rewrite is a recapture at the row's time.
    expect(h.captured).toBeGreaterThan(0);
    for (const e of h.events.filter(e => e.kind === 'captured')) expect(new Date(e.at).toISOString().slice(0, 7)).toBe('2026-07');
    // No versions by application (the probe reads one row), so they were looked up by update name.
    const v = queriesOf(m, 'sys_update_version');
    expect(v[0].args).toMatchObject({ query: `application=${scope.sys_id}`, limit: 1 });
    expect(v.slice(1).every(x => String(x.args.query).startsWith('nameIN'))).toBe(true);
  });

  it('reads versions by application first, and then fetches no payloads', async () => {
    const { m, c } = await setup({ versions: 'application' });
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    const h = await importHistory(c, scope, pulled.inventory, { full: pulled.full });
    expect(h).toMatchObject({ versions: 183, versionsBy: 'application', fromUpdateXml: 0, xmlEvents: 0, captured: 0 });
    // Every update name had its versions, so nothing more was looked up and there is nothing to warn about.
    expect(h.warnings).toEqual([]);
    // Each version row is its own save, even two of one record in the same second.
    expect(saves(h.events)).toHaveLength(183);
    expect(h.events.every(e => e.source === 'version')).toBe(true);
    expect(queriesOf(m, 'sys_update_version').some(x => String(x.args.query).startsWith('nameIN'))).toBe(false);
    expect(queriesOf(m, 'sys_update_xml').some(x => (x.args.fields as string[]).includes('payload'))).toBe(false);
    // Without payloads, a dictionary entry still finds its record through the pulled records.
    const field = h.events.find(e => e.update.endsWith('_bureau_pull_date'))!;
    expect(field).toMatchObject({ kind: 'created', collection: 'x_snc_cc_offering_credit_card_application' });
    expect(field.sysId).toMatch(/^5f/);
    expect(field.keys).toEqual(expect.arrayContaining(['bureau pull date', 'bureau_pull_date']));
    // Three queries in all: the probe, the versions, the update_xml rows.
    expect(h.queries).toBe(3);
  });

  it('looks up by name only the update names whose versions carry no application', async () => {
    const { m, c } = await setup({ versions: 'some-application' });
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    const h = await importHistory(c, scope, pulled.inventory);
    expect(h).toMatchObject({ versions: 183, versionsBy: 'application', fromUpdateXml: 0 });
    expect(h.warnings).toEqual([expect.stringMatching(/^\d+ version rows carry no application and were found by update name$/)]);
    // Only update_xml names went into the name lookup, never the whole inventory.
    const asked = queriesOf(m, 'sys_update_version').filter(x => String(x.args.query).startsWith('nameIN'))
      .flatMap(x => String(x.args.query).slice(6).split(','));
    expect(asked.every(n => fx.sys_update_xml.some(r => r.name === n))).toBe(true);
  });

  it('falls back to update names when versions carry no application', async () => {
    const { c } = await setup({ versions: true });
    const { scope, pulled } = await pull(c);
    const h = await importHistory(c, scope, pulled.inventory);
    expect(h).toMatchObject({ versions: 183, versionsBy: 'name', fromUpdateXml: 0 });
    // The mock makes one version row per update_xml row, and each version row is a save of its own.
    expect(saves(h.events)).toHaveLength(183);
  });

  it('pages by short page, not has_more, with {link, value} references flattened', async () => {
    const { m, c } = await setup({ alwaysMore: true });
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    const h = await importHistory(c, scope, pulled.inventory, { pageSize: 50 });
    expect(h.updateXml).toBe(183);
    // 183 rows: pages at 0, 50, 100 and a short one at 150, though every page says has_more.
    const rows = queriesOf(m, 'sys_update_xml').filter(x => x.args.query === `application=${scope.sys_id}`);
    expect(rows.map(x => x.args.offset)).toEqual([0, 50, 100, 150]);
    // The mock wraps references (application, ids) as real nexus does; events only hold strings.
    const raw = await c.call('sn_query_table', { table: 'sys_update_xml', query: `application=${scope.sys_id}`, limit: 1 }) as { data: { records: Record<string, unknown>[] } };
    expect(raw.data.records[0].application).toEqual({ link: expect.any(String), value: scope.sys_id });
    for (const e of h.events) for (const v of [e.table, e.update, e.name, e.author, e.sysId ?? '']) expect(typeof v).toBe('string');
  });

  it('never reads a property value, a password class payload, or anything from a credential table', async () => {
    const prop = fx.tables.sys_metadata.rows.find(r => r[1] === 'sys_properties')!;
    const extra = [
      xmlRow({
        sys_id: xid(1), name: `sys_properties_${prop[0]}`, type: 'System Property', target_name: 'x.prop',
        payload: `<record_update table="sys_properties"><sys_properties action="INSERT_OR_UPDATE"><sys_id>${prop[0]}</sys_id><name>x.prop</name><value>PROPERTY-VALUE-1</value><sys_updated_on>2026-06-20 10:00:00</sys_updated_on></sys_properties></record_update>`,
      }),
      xmlRow({
        sys_id: xid(2), name: `sys_auth_profile_basic_${'5e'.padEnd(32, '3')}`, type: 'Basic Auth', target_name: 'creds',
        payload: '<record_update table="sys_auth_profile_basic"><sys_auth_profile_basic action="INSERT_OR_UPDATE"><password2>CREDENTIAL-VALUE-2</password2></sys_auth_profile_basic></record_update>',
      }),
      xmlRow({
        sys_id: xid(3), name: `sys_email_account_${'5e'.padEnd(32, '4')}`, type: 'Email Account', target_name: 'Mailbox',
        payload: '<record_update table="sys_email_account"><sys_email_account action="INSERT_OR_UPDATE"><password>MAIL-VALUE-3</password></sys_email_account></record_update>',
      }),
    ];
    const { m, c } = await setup({ extraUpdateXml: extra, versions: false });
    const { scope, pulled, manifest } = await pull(c);
    m.calls.length = 0;
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: null });
    // The property's and mailbox's changes are in the timeline (dates and author only); the credential record is not.
    expect(t.doc.events.some(e => e.update === extra[0].name)).toBe(true);
    expect(t.doc.events.some(e => e.update === extra[2].name)).toBe(true);
    expect(t.doc.events.some(e => e.update === extra[1].name || e.table.startsWith('sys_auth'))).toBe(false);
    // None of their payloads was asked for, and no version query names the credential record.
    // (A chunk of ids is read in pages, so the same query appears once per page.)
    const payloadIds = new Set(queriesOf(m, 'sys_update_xml').filter(x => (x.args.fields as string[]).includes('payload')).flatMap(x => String(x.args.query).replace(/^sys_idIN/, '').split(',')));
    for (const r of extra) expect(payloadIds.has(r.sys_id)).toBe(false);
    expect(payloadIds.size).toBe(183);
    for (const x of queriesOf(m, 'sys_update_version')) expect(String(x.args.query)).not.toContain('sys_auth_profile');
    // No query asked sys_properties for its value.
    for (const x of m.calls.filter(x => x.args.table === 'sys_properties')) expect(x.args.fields).not.toContain('value');
    // Nothing secret is stored.
    writeHistory(snRoot(dir), scope.scope, t.doc);
    const text = fs.readFileSync(historyPath(snRoot(dir), scope.scope), 'utf8');
    for (const secret of ['PROPERTY-VALUE-1', 'CREDENTIAL-VALUE-2', 'MAIL-VALUE-3', 'password2', '<payload>']) expect(text).not.toContain(secret);
  });

  it('dedupes recaptures, takes the author from the payload, and dates a late row as a recapture', async () => {
    const id = '5e'.padEnd(32, '5');
    const payload = (on: string, by: string) => `<record_update table="sp_widget"><sp_widget action="INSERT_OR_UPDATE"><sys_id>${id}</sys_id><id>w-re</id><name>Recaptured</name><sys_updated_on>${on}</sys_updated_on><sys_updated_by>${by}</sys_updated_by></sp_widget></record_update>`;
    const name = `sp_widget_${id}`;
    const extra = [
      // One save, written into two update sets (or captured twice): the same payload time.
      xmlRow({ sys_id: xid(11), name, target_name: 'Recaptured', sys_created_by: 'admin', sys_updated_by: 'admin', sys_updated_on: '2026-06-20 10:00:05', payload: payload('2026-06-20 10:00:03', 'dev.two') }),
      xmlRow({ sys_id: xid(12), name, target_name: 'Recaptured', sys_created_by: 'admin', sys_updated_by: 'release.mgr', sys_updated_on: '2026-07-01 09:00:00', payload: payload('2026-06-20 10:00:03', 'dev.two') }),
    ];
    const { c } = await setup({ extraUpdateXml: extra });
    const { scope, pulled } = await pull(c);
    const h = await importHistory(c, scope, pulled.inventory);
    const mine = h.events.filter(e => e.update === name);
    expect(mine.map(e => [e.kind, new Date(e.at).toISOString(), e.author])).toEqual([
      ['modified', '2026-06-20T10:00:03.000Z', 'dev.two'],
      ['captured', '2026-07-01T09:00:00.000Z', 'release.mgr'],
    ]);
  });

  it('keeps the versions source when the budget runs out while reading them', async () => {
    const { m, c } = await setup({ versions: 'application' });
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    // Each nexus call takes a simulated 10 s. The probe and two version pages fit; the third does not.
    const h = await importHistory(c, scope, pulled.inventory, { budgetMs: 25_000, pageSize: 50, now: () => m.calls.length * 10_000 });
    expect(m.calls).toHaveLength(3);
    expect(h).toMatchObject({ partial: true, versionsBy: 'application' });
  });

  it('checks the deadline between pages of one query', async () => {
    const { m, c } = await setup();
    m.calls.length = 0;
    // Each call takes a simulated second; the deadline falls during the first page.
    await expect(c.query('sys_metadata', { pageSize: 100, deadline: { at: 500, now: () => m.calls.length * 1000 } })).rejects.toBeInstanceOf(NexusDeadlineError);
    expect(m.calls.filter(x => (x.inner ?? x.tool) === 'sn_query_table')).toHaveLength(1);
  });

  it('stops at its time budget with a warning and a partial result', async () => {
    const { m, c } = await setup();
    const { scope, pulled } = await pull(c);
    m.calls.length = 0;
    // Each nexus call takes a simulated 10 s. The run reads the rows and versions, then runs out in the payloads.
    const full = await importHistory(c, scope, pulled.inventory);
    const firstPayload = m.calls.findIndex(x => Array.isArray(x.args.fields) && (x.args.fields as string[]).includes('payload'));
    expect(full.partial).toBe(false);
    m.calls.length = 0;
    const budget = (firstPayload + 1) * 10_000 + 5_000;
    const h = await importHistory(c, scope, pulled.inventory, { budgetMs: budget, now: () => m.calls.length * 10_000 });
    expect(h.partial).toBe(true);
    expect(h.warnings.join('\n')).toMatch(/stopped after \d+ s .*partial/);
    // Rows whose payload was not read are left out rather than dated by their rewritten row time.
    expect(h.warnings.join('\n')).toMatch(/update_xml rows left out/);
    for (const e of saves(h.events)) if (e.kind !== 'deleted') expect(new Date(e.at).toISOString().slice(0, 7)).not.toBe('2026-07');
  });
});

describe('payloads and times', () => {
  it('reads ServiceNow UTC times', () => {
    expect(new Date(snTime('2026-06-03 16:01:44')).toISOString()).toBe('2026-06-03T16:01:44.000Z');
    expect(snTime('')).toBeNaN();
    expect(snTime(undefined)).toBeNaN();
  });
  it('keeps only ids, times, author and names from a payload', () => {
    const p = parsePayload('<?xml version="1.0"?><record_update table="sp_widget"><sp_widget action="INSERT_OR_UPDATE"><sys_id>abc</sys_id><id>w-1</id><name>A &amp; B</name><script>var x = 1;</script><password2>p</password2><sys_updated_on>2026-06-01 00:00:00</sys_updated_on><sys_updated_by>dev.one</sys_updated_by></sp_widget></record_update>');
    expect(p).toEqual({ table: 'sp_widget', fields: { sys_id: 'abc', id: 'w-1', name: 'A & B', sys_updated_on: '2026-06-01 00:00:00', sys_updated_by: 'dev.one' } });
  });
  it('reads only direct children of the record element, never CDATA text or sibling records', () => {
    const p = parsePayload([
      '<?xml version="1.0" encoding="UTF-8"?><record_update table="sp_widget">',
      '<sp_widget action="INSERT_OR_UPDATE">',
      '<template><![CDATA[<div><id>template-id</id><label>Template label</label><title>T</title></div>]]></template>',
      '<script><![CDATA[var s = "<name>script-name</name>";]]></script>',
      '<option_schema><option><label>Nested label</label></option></option_schema>',
      '<id>real-id</id><name>Real name</name><sys_id>abc</sys_id>',
      '<sys_scope display_value="App">5f01</sys_scope>',
      '<sys_updated_on>2026-06-01 00:00:00</sys_updated_on>',
      '</sp_widget>',
      '<sys_documentation action="INSERT_OR_UPDATE"><label>Doc label</label><name>doc-name</name></sys_documentation>',
      '</record_update>',
    ].join(''));
    expect(p).toEqual({ table: 'sp_widget', fields: { id: 'real-id', name: 'Real name', sys_id: 'abc', sys_updated_on: '2026-06-01 00:00:00' } });
    expect(parsePayload('<record_update table="x"><x action="DELETE"/></record_update>')).toEqual({ table: 'x', fields: {} });
    expect(parsePayload('not xml')).toEqual({ fields: {} });
  });
});

describe('SkyForge log parsing', () => {
  const T = '2026-06-03T16:01:29.115Z';
  const at = Date.parse(T);
  const id = 'ab'.repeat(16);
  it('splits k=v pairs where a value holds a comma, and drops "...+N more"', () => {
    expect(parseArgs('tool=sn_create_sp_widget, name=Hero Banner, id=w-a, option_schema=[{"a":1}, {"b":2}]..., ...+4 more'))
      .toEqual({ tool: 'sn_create_sp_widget', name: 'Hero Banner', id: 'w-a', option_schema: '[{"a":1}, {"b":2}]...' });
    // The tool name of a background script survives the elided arguments.
    expect(parseArgs('tool=sn_execute_background_script, ...+2 more')).toEqual({ tool: 'sn_execute_background_script' });
  });
  it('reads instance names from hosts and URLs', () => {
    expect(instanceName('https://Acme.service-now.com/')).toBe('acme');
    expect(instanceName('acme.service-now.com')).toBe('acme');
    expect(instanceName('acme')).toBe('acme');
    expect(instanceName('snow.example.com:443')).toBeNull();
    expect(instanceName('https://10.0.0.5/')).toBeNull();
  });

  // The tools seen in SkyForge's log, and what a start line of each becomes (null: not a write).
  const TOOLS: [string, Partial<LogCall> | null][] = [
    ['tool=sn_query_table, table=sys_dictionary, limit=50', null],
    ['tool=sn_get_table_metadata, table=sp_widget', null],
    ['tool=sn_get_instance_info', null],
    ['tool=sn_session_context', null],
    ['tool=sn_pull_artifact, table=sp_widget, sys_id=' + id, null],
    ['tool=sn_get_current_scope', null],
    ['tool=sn_switch_application_scope, scope=x_app', null],
    ['tool=sn_validate_widget_coherence, widget_id=w-a', null],
    ['tool=sn_update_set_manage, action=switch, update_set_id=' + id, null],
    ['tool=sn_update_set_manage, action=current', null],
    ['tool=sn_update_set_manage, action=create, name=Release 2', null],
    ['tool=sn_update_set_query, action=list', null],
    ['tool=sn_update_set_query, action=current', null],
    ['tool=sn_ensure_active_update_set, name=Release 2', null],
    ['tool=sn_update_set_manage, action=add_artifact, artifact_type=script_include, artifact_sys_id=' + id, { kind: 'capture', tables: ['sys_script_include'], sysId: id }],
    ['tool=sn_update_set_manage, action=add_artifact, artifact_type=script_action, artifact_sys_id=' + id, { kind: 'capture', tables: ['sysevent_script_action'] }],
    ['tool=sn_update_set_manage, action=add_artifact, artifact_type=ui_action, artifact_sys_id=' + id, { kind: 'capture', tables: ['sys_ui_action'] }],
    ['tool=sn_update_set_manage, action=add_artifact, update_set_id=' + 'cd'.repeat(16) + ', artifact_table=sp_widget, artifact_sys_id=' + id, { kind: 'capture', tables: ['sp_widget'], sysId: id }],
    ['tool=sn_update_set_manage, action=add_artifact, artifact_type=sp_page, artifact_sys_id=' + id + ', artifact_name=Home', { kind: 'capture', tables: ['sp_page'], sysId: id, names: ['home'] }],
    ['tool=sn_create_field, table=x_app_t, column_name=credit_score, column_label=Credit Score, internal_type=integer',
      { kind: 'create', tables: ['sys_dictionary'], collection: 'x_app_t', names: ['credit score', 'credit_score'] }],
    ['tool=sn_create_choice, table=x_app_t, element=status, label=Open, value=open', { kind: 'create', tables: ['sys_choice'], collection: 'x_app_t' }],
    ['tool=sn_create_table, name=x_app_t, label=Thing', { kind: 'create', tables: ['sys_db_object'], names: ['x_app_t', 'thing'] }],
    ['tool=sn_create_sp_page, short_description=Home page, id=home, title=A very long title tha..., public=true, ...+1 more', { kind: 'create', tables: ['sp_page'], names: ['home'] }],
    ['tool=sn_create_sp_widget, name=Hero Banner, id=w-a, ...+4 more', { kind: 'create', tables: ['sp_widget'], names: ['w-a', 'hero banner'] }],
    ['tool=sn_create_portal, url_suffix=cc, title=Cards', { kind: 'create', tables: ['sp_portal'], names: ['cards', 'cc'] }],
    ['tool=sn_create_portal_theme, name=Theme', { tables: ['sp_theme'] }],
    ['tool=sn_create_portal_menu, title=Main', { tables: ['sp_instance_menu'] }],
    ['tool=sn_create_script_include, name=Helper, api_name=x_app.Helper', { tables: ['sys_script_include'], names: ['helper', 'x_app.helper'] }],
    ['tool=sn_create_business_rule, table=x_app_t, name=Set state, when=before', { tables: ['sys_script'], collection: 'x_app_t', names: ['set state'] }],
    ['tool=sn_create_client_script, table=x_app_t, name=On load', { tables: ['sys_script_client'], collection: 'x_app_t' }],
    ['tool=sn_create_ui_action, table=x_app_t, name=Approve', { tables: ['sys_ui_action'], collection: 'x_app_t' }],
    ['tool=sn_create_ui_policy, table=x_app_t, short_description=Hide', { tables: ['sys_ui_policy'] }],
    ['tool=sn_create_form_section, table=x_app_t, caption=Details', { tables: ['sys_ui_section'] }],
    ['tool=sn_create_notification, table=x_app_t, name=Approved', { tables: ['sysevent_email_action'] }],
    ['tool=sn_create_access_control, name=x_app_t.*, operation=read', { kind: 'create', tables: ['sys_security_acl'] }],
    ['tool=sn_create_catalog_variable, name=reason, question_text=Reason', { tables: ['item_option_new'] }],
    ['tool=sn_create_ai_agent, name=Triage', { tables: ['sn_aia_agent'] }],
    ['tool=sn_create_ux_app_route, route=home, ...+3 more', { tables: ['sys_ux_app_route'] }],
    ['tool=sn_create_quick_link, title=Apply', { kind: 'create', tables: [], anyTable: true, names: ['apply'] }],
    ['tool=sn_record_manage, table=sp_instance, action=delete, sys_id=' + id, { kind: 'delete', tables: ['sp_instance'], sysId: id }],
    ['tool=sn_record_manage, table=sp_widget, action=update, sys_id=' + id + ', data={3 keys}', { kind: 'update', tables: ['sp_widget'], sysId: id }],
    ['tool=sn_record_manage, table=x_app_t, action=create, data={12 keys}', { kind: 'create', tables: ['x_app_t'], names: [] }],
    ['tool=sn_record_manage, table=x_app_t, action=get, sys_id=' + id, null],
    ['tool=sn_edit_by_sysid, table=sp_page, sys_id=' + id + ', field=css, value=body { color: red...', { kind: 'update', tables: ['sp_page'], sysId: id, names: [] }],
    ['tool=sn_push_artifact, sys_id=' + id + ', directory=D:/work/artifacts/app/sp_widget/My Widget, validate=true', { kind: 'update', tables: ['sp_widget'], sysId: id, names: ['my widget'] }],
    ['tool=sn_push_artifact, sys_id=' + id + ', directory=D:/work/out', { kind: 'update', tables: [], sysId: id }],
    ['tool=sn_update_sp_widget, widget_id=w-a, ...+3 more', { kind: 'update', tables: ['sp_widget'], names: ['w-a'] }],
    ['tool=sn_update_sp_widget, widget_id=' + id + ', template=<div>...', { kind: 'update', tables: ['sp_widget'], sysId: id }],
    ['tool=sn_artifact_manage, action=create, type=widget, name=Card List', { kind: 'create', tables: ['sp_widget'], names: ['card list'] }],
    ['tool=sn_artifact_manage, action=update, table=sys_script_include, sys_id=' + id, { kind: 'update', tables: ['sys_script_include'], sysId: id }],
    ['tool=sn_artifact_manage, action=update, type=sys_ui_page, name=Landing', { kind: 'update', tables: ['sys_ui_page'] }],
    ['tool=sn_artifact_manage, action=list, type=widget', null],
    ['tool=sn_add_form_field, table=x_app_t, field=credit_score, view=default', { kind: 'create', tables: ['sys_ui_element'], collection: 'x_app_t', names: ['credit_score'] }],
    ['tool=sn_build_portal_layout, page_id=home, ...+2 more', { kind: 'create', tables: ['sp_container', 'sp_row', 'sp_column', 'sp_instance'] }],
    ['tool=sn_intermediate_flow, action=create_flow, name=Card approval', { kind: 'create', tables: ['sys_hub_flow'], names: ['card approval'] }],
    ['tool=sn_intermediate_flow, action=create_trigger, flow_id=' + id, { kind: 'create', tables: expect.arrayContaining(['sys_hub_flow', 'sys_hub_trigger_instance']), sysId: id }],
    ['tool=sn_intermediate_flow, action=delete_flow, flow_id=' + id, { kind: 'delete', tables: ['sys_hub_flow'], sysId: id }],
    ['tool=sn_intermediate_flow, action=get_flow, flow_id=' + id, null],
    ['tool=sn_disable_business_rule, sys_id=' + id, { kind: 'update', tables: ['sys_script'], sysId: id }],
    ['tool=sn_execute_background_script, ...+2 more', { kind: 'script', tables: [], anyTable: true }],
    ['tool=sn_execute_background_script, script=var gr = new GlideRecord("x_app_t")..., ...+1 more', { kind: 'script', anyTable: true }],
    ['tool=sn_schedule_script_job, name=Fix data, ...+2 more', { kind: 'script', anyTable: true }],
    ['tool=sn_delete_record, table=x_app_t, sys_id=' + id, { kind: 'delete', tables: ['x_app_t'], sysId: id }],
    // Tools seen in the real log.
    ['tool=sn_assign_tool_to_agent, agent_id=' + id, { kind: 'update', anyTable: true }],
    ['tool=sn_bulk_update, table=x_app_t, query=active=true', { kind: 'update', tables: ['x_app_t'] }],
    ['tool=sn_bulk_update, query=active=true', { kind: 'update', anyTable: true }],
    ['tool=sn_catalog_item_manager, action=create, name=New card', { kind: 'create', tables: ['sc_cat_item'], names: ['new card'] }],
    ['tool=sn_catalog_item_manager, action=update, sys_id=' + id, { kind: 'update', tables: ['sc_cat_item'], sysId: id }],
    ['tool=sn_catalog_item_manager, action=get, sys_id=' + id, null],
    ['tool=sn_cleanup_workspace_t2e, workspace=cards', { kind: 'script', anyTable: true }],
    ['tool=sn_configure_macroponent, action=read, macroponent=card', null],
    ['tool=sn_configure_macroponent, macroponent=card', null],
    ['tool=sn_configure_macroponent, action=update, macroponent=card', { kind: 'update', anyTable: true }],
    ['tool=sn_decision_create, name=Card limits', { kind: 'create', tables: ['sys_decision'], names: ['card limits'] }],
    ['tool=sn_email_notification_manage, action=create, name=Approved', { kind: 'create', tables: ['sysevent_email_action'] }],
    ['tool=sn_email_notification_manage, action=delete, sys_id=' + id, { kind: 'delete', tables: ['sysevent_email_action'], sysId: id }],
    ['tool=sn_email_notification_manage, action=list', null],
    ['tool=sn_invoke_ai_agent, agent=triage', { kind: 'script', anyTable: true }],
    ['tool=sn_manage_workspace_list_config, list=cards, columns=number', { kind: 'update', anyTable: true }],
    ['tool=sn_manage_workspace_list_config, action=update, list=cards', { kind: 'update', anyTable: true }],
    ['tool=sn_manage_workspace_list_config, action=get', null],
    ['tool=sn_manage_workspace_navigation, action=set_landing_page, workspace=cards', { kind: 'update', anyTable: true }],
    ['tool=sn_par_create_dashboard, name=Cards', { kind: 'create', anyTable: true }],
    ['tool=sn_par_update_dashboard, sys_id=' + id, { kind: 'update', anyTable: true, sysId: id }],
    ['tool=sn_plugin_manage, action=activate, plugin_id=com.example', { kind: 'script', anyTable: true }],
    ['tool=sn_plugin_manage, action=list', null],
    ['tool=sn_property_manager, action=set, name=x_app.limit, value=42', { kind: 'update', tables: ['sys_properties'], names: ['x_app.limit'] }],
    ['tool=sn_property_manager, action=get, name=x_app.limit', null],
    ['tool=sn_rest_message_manage, action=create, name=Bureau', { kind: 'create', tables: ['sys_rest_message', 'sys_rest_message_fn'] }],
    ['tool=sn_scheduled_job_manage, action=create, name=Nightly', { kind: 'create', tables: ['sysauto_script'] }],
    ['tool=sn_scheduled_job_manage, action=run_now, sys_id=' + id, { kind: 'script', anyTable: true }],
    ['tool=sn_scheduled_job_manage, action=list', null],
    ['tool=sn_scripted_rest_api, name=Cards API, base_path=/cards', { kind: 'update', tables: ['sys_ws_definition', 'sys_ws_operation'] }],
    ['tool=sn_scripted_rest_api, action=create, name=Cards API', { kind: 'create', tables: ['sys_ws_definition', 'sys_ws_operation'] }],
    ['tool=sn_scripted_rest_api, action=list', null],
    ['tool=sn_uib_page_manage, action=create, name=Home', { kind: 'create', tables: ['sys_ux_screen'] }],
    ['tool=sn_uib_page_manage, action=list', null],
    ['tool=sn_wire_dashboard_home, dashboard_id=' + id, { kind: 'update', anyTable: true }],
    ...['sn_aggregate_metrics', 'sn_blast_radius_apps', 'sn_blast_radius_artifact_dependencies', 'sn_blast_radius_impact_map',
      'sn_blast_radius_reverse_dependencies', 'sn_blast_radius_table_configs', 'sn_catalog_item_search', 'sn_code_search', 'sn_data_export',
      'sn_decision_evaluate', 'sn_decision_get', 'sn_decision_list', 'sn_deployment_debug', 'sn_deployment_status', 'sn_elevate_role',
      'sn_export_to_xml', 'sn_inspect_mutations', 'sn_par_get_dashboard', 'sn_property_query', 'sn_uib_discover',
    ].map((t): [string, null] => [`tool=${t}, table=x_app_t`, null]),
  ];
  it.each(TOOLS)('reads %s', (args, want) => {
    const call = toCall(7, at, 'tool_execute', parseArgs(args));
    if (want === null) expect(call).toBeNull();
    else expect(call).toMatchObject({ line: 7, at, ...want });
    // A direct call reads the same as one through tool_execute.
    const [, tool, rest] = /^tool=([a-z0-9_]+)(?:, )?(.*)$/.exec(args)!;
    expect(toCall(7, at, tool, parseArgs(rest))).toEqual(call);
  });
  it('knows every tool in the table, and names the rest unknown', () => {
    for (const [args] of TOOLS) expect(toolRole(/^tool=([a-z0-9_]+)/.exec(args)![1]), args).not.toBe('unknown');
    expect(toolRole('sn_frobnicate')).toBe('unknown');
    expect(toolRole('sn_update_set_query')).toBe('read');
  });

  it('pairs a completion line with the start it ends, counting blank lines', () => {
    const scan = parseLog([
      `[2026-06-03T16:01:29.107Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=A`,
      '',
      `[2026-06-03T16:01:29.115Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=B`,
      `[2026-06-03T16:01:30.871Z] [INFO] [Tool] sn_create_field ✅ 1756ms`,
      'not a log line',
      `[2026-06-03T16:01:31.000Z] [INFO] [Tool] tool_execute | tool=sn_frobnicate, x=1`,
    ].join('\n') + '\n');
    expect(scan.lines).toBe(6);
    expect(scan.parsed).toBe(4);
    expect(scan.calls.map(c => [c.line, c.names[0], c.ms])).toEqual([[1, 'a', undefined], [3, 'b', 1756]]);
    expect(scan.calls[1].end).toBe(Date.parse('2026-06-03T16:01:30.871Z'));
    expect(scan.unknownTools).toEqual({ sn_frobnicate: 1 });
  });
  it('tags each call with the instance the log last connected to', () => {
    const scan = parseLog([
      `[2026-06-03T16:00:00.000Z] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`,
      '[2026-06-03T16:00:01.000Z] [INFO] [Auth] ✅ Connected to https://acme.service-now.com',
      `[2026-06-03T16:00:02.000Z] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`,
      '[2026-06-03T16:00:03.000Z] [INFO] [Auth] ✅ Connected to other.service-now.com',
      `[2026-06-03T16:00:04.000Z] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`,
    ].join('\n'));
    // The third call comes 3 s after acme's connect line: two processes may share the log, so it is unknown.
    expect(scan.calls.map(c => c.host)).toEqual([undefined, 'acme', undefined]);
    expect(scan.hosts).toEqual(['acme', 'other']);
  });
  it('makes a call\'s instance unknown when another instance connected in the 10 minutes before it', () => {
    const t = (min: number) => new Date(Date.parse('2026-06-03T16:00:00Z') + min * 60_000).toISOString();
    const write = (min: number) => `[${t(min)}] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`;
    const connect = (min: number, host: string) => `[${t(min)}] [INFO] [Auth] ✅ Connected to ${host}`;
    const scan = parseLog([
      connect(0, 'acme.service-now.com'), write(1),
      connect(2, 'other.service-now.com'), connect(3, 'acme.service-now.com'), write(4),
      write(14),
      connect(20, 'intranet.example.com'), write(21),
      connect(25, 'acme.service-now.com'), write(26),
    ].join('\n'));
    expect(scan.calls.map(c => c.host)).toEqual(['acme', undefined, 'acme', undefined, undefined]);
  });
  it('learns the agent\'s ServiceNow user from scope and update set calls', () => {
    const scan = parseLog([
      `[2026-06-03T16:00:00.000Z] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`,
      '[2026-06-03T16:00:01.000Z] [INFO] [Tool] tool_execute | tool=sn_switch_application_scope, scope=x_app, servicenow_username=Agent.User',
      `[2026-06-03T16:00:02.000Z] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`,
    ].join('\n'));
    expect(scan.calls.map(c => c.user)).toEqual([undefined, undefined]);
  });
  it('keeps each agent user to the instance it was named on', () => {
    const t = (min: number) => new Date(Date.parse('2026-06-03T16:00:00Z') + min * 60_000).toISOString();
    const write = (min: number) => `[${t(min)}] [INFO] [Tool] tool_execute | tool=sn_record_manage, table=t, action=update, sys_id=${id}`;
    const scan = parseLog([
      `[${t(0)}] [INFO] [Auth] ✅ Connected to acme.service-now.com`,
      `[${t(1)}] [INFO] [Tool] tool_execute | tool=sn_switch_application_scope, scope=x_app, servicenow_username=Agent.User`,
      write(2),
      `[${t(20)}] [INFO] [Auth] ✅ Connected to other.service-now.com`,
      `[${t(21)}] [INFO] [Tool] tool_execute | tool=sn_update_set_manage, action=switch, servicenow_username=other.bot`,
      write(22),
      `[${t(40)}] [INFO] [Auth] ✅ Connected to acme.service-now.com`,
      write(41),
      `[${t(42)}] [INFO] [Tool] tool_execute | tool=sn_switch_application_scope, scope=x_app, servicenow_username=second.bot`,
      write(43),
    ].join('\n'));
    // Back on acme, its own user applies again, never the other instance's; a newer user replaces it.
    expect(scan.calls.map(c => [c.host, c.user])).toEqual([['acme', 'agent.user'], ['other', 'other.bot'], ['acme', 'agent.user'], ['acme', 'second.bot']]);
    expect(scan.agentUsers).toEqual({ acme: ['agent.user', 'second.bot'], other: ['other.bot'] });
  });
  it('reads every line of the fixture log', () => {
    const scan = parseLog(fx.mcpLogExcerpt.lines.join('\n'));
    expect(scan.lines).toBe(400);
    expect(scan.parsed).toBe(400);
    expect(scan.calls.length).toBeGreaterThan(0);
    expect(scan.unknownTools).toEqual({});
    expect(scan.calls.some(c => c.tool === 'sn_execute_background_script' && c.anyTable)).toBe(true);
  });
});

describe('matching history to the log', () => {
  const at0 = Date.parse('2026-06-03T16:01:44Z');
  const I = { instance: 'inmorphisdemo3' };
  const ev = (over: Partial<HistoryEvent>): HistoryEvent => ({
    at: at0, kind: 'modified', table: 'sp_widget', update: 'u', name: 'n', keys: [], author: 'admin', source: 'version', confidence: 'history', ...over,
  });
  const call = (over: Partial<LogCall>): LogCall => ({ line: 1, at: at0 - 2000, tool: 'sn_record_manage', kind: 'update', tables: ['sp_widget'], names: [], host: 'inmorphisdemo3', user: 'admin', ...over });
  const id = 'ef'.repeat(16);
  const other = 'aa'.repeat(16);

  it('matches an update by sys_id and a create by table and name: log', () => {
    const upd = ev({ sysId: id });
    const crt = ev({ kind: 'created', table: 'sys_dictionary', keys: ['credit score'], collection: 'x_app_t' });
    const counts = matchHistory([upd, crt], [
      call({ sysId: id }),
      call({ line: 2, tool: 'sn_create_field', kind: 'create', tables: ['sys_dictionary'], collection: 'x_app_t', names: ['credit score'] }),
    ], I);
    expect(counts).toEqual({ events: 2, matched: 2, ambiguous: 0, hostUnknown: 0, timeOnly: 0, authorUnchecked: 0, unmatched: 0 });
    expect(upd).toMatchObject({ confidence: 'log', log: [{ line: 1, tool: 'sn_record_manage' }] });
    expect(crt).toMatchObject({ confidence: 'log', log: [{ line: 2, tool: 'sn_create_field' }] });
  });

  it('matches a dictionary entry by its update name when only the element is logged', () => {
    const e = ev({ kind: 'created', table: 'sys_dictionary', update: 'sys_dictionary_x_app_t_credit_score', keys: ['credit score'] });
    matchHistory([e], [call({ tool: 'sn_create_field', kind: 'create', tables: ['sys_dictionary'], collection: 'x_app_t', names: ['credit_score'] })], I);
    expect(e.confidence).toBe('log');
  });

  it('matches a call with a sys_id but no table on any table by that sys_id', () => {
    const e = ev({ table: 'sys_ui_page', sysId: id });
    matchHistory([e], [call({ tool: 'sn_push_artifact', tables: [], sysId: id })], I);
    expect(e.confidence).toBe('log');
  });

  it('keeps every candidate when two calls name the record: likely', () => {
    const e = ev({ keys: ['w-a'] });
    const counts = matchHistory([e], [call({ names: ['w-a'] }), call({ line: 2, names: ['w-a'], at: at0 - 1000 })], I);
    expect(counts.ambiguous).toBe(1);
    expect(e.confidence).toBe('likely');
    expect(e.log?.map(r => r.line)).toEqual([1, 2]);
  });

  it('never makes a table and time match more than likely, and never claims a save for another sys_id', () => {
    const e = ev({ sysId: id, keys: ['w-a'] });
    const counts = matchHistory([e], [call({ sysId: other }), call({ line: 2 })], I);
    expect(counts).toMatchObject({ matched: 0, timeOnly: 1 });
    expect(e.confidence).toBe('likely');
    // The call naming another record is not a candidate at all.
    expect(e.log?.map(r => r.line)).toEqual([2]);
    // A save made by hand right after a call on a different record stays history.
    const human = ev({ sysId: id });
    expect(matchHistory([human], [call({ sysId: other })], I).unmatched).toBe(1);
    expect(human.confidence).toBe('history');
  });

  it('spends a call matched at log, so it is no table and time candidate for another save', () => {
    const made = ev({ kind: 'created', keys: ['w-a'] });
    const nextDoor = ev({ sysId: id, keys: ['w-b'], at: at0 + 1000 });
    const counts = matchHistory([made, nextDoor], [call({ tool: 'sn_create_sp_widget', kind: 'create', names: ['w-a'] })], I);
    expect(counts).toMatchObject({ matched: 1, timeOnly: 0, unmatched: 1 });
    expect(nextDoor.confidence).toBe('history');
  });

  it('keeps creates whose names the log hides at table and time', () => {
    const e = ev({ kind: 'created', table: 'x_app_t', keys: ['row 1'] });
    expect(matchHistory([e], [call({ kind: 'create', tables: ['x_app_t'] })], I).timeOnly).toBe(1);
    expect(e.confidence).toBe('likely');
  });

  it('caps background scripts at likely, on any table and any kind', () => {
    const es = [ev({ sysId: id }), ev({ kind: 'deleted', table: 'sys_script', sysId: other })];
    const counts = matchHistory(es, [call({ tool: 'sn_execute_background_script', kind: 'script', tables: [], anyTable: true })], I);
    expect(counts).toMatchObject({ matched: 0, timeOnly: 2 });
  });

  it('keeps a save by someone other than the agent out of table and time and script matches', () => {
    const script = call({ tool: 'sn_execute_background_script', kind: 'script', tables: [], anyTable: true });
    const human = ev({ sysId: id, author: 'jane.dev', at: at0 + 20_000 });
    expect(matchHistory([human], [script, call({ line: 2 })], I).unmatched).toBe(1);
    expect(human.confidence).toBe('history');
    // The agent's own save still gets the script as a candidate.
    const own = ev({ sysId: id, author: 'Admin', at: at0 + 20_000 });
    expect(matchHistory([own], [script], I).timeOnly).toBe(1);
    // A call that names the record matches whoever saved it.
    const named = ev({ sysId: id, author: 'jane.dev' });
    expect(matchHistory([named], [call({ sysId: id })], I).matched).toBe(1);
    // With no known user, the author is not checked, and the match says so.
    const anyone = ev({ sysId: id, author: 'jane.dev', at: at0 + 20_000 });
    expect(matchHistory([anyone], [{ ...script, user: undefined }], I)).toMatchObject({ timeOnly: 0, authorUnchecked: 1 });
    expect(anyone).toMatchObject({ confidence: 'likely', reason: 'author not checked' });
    // The nexus session's user stands in when the log does not say, and wins when the log names someone else.
    const again = ev({ sysId: id, author: 'jane.dev', at: at0 + 20_000 });
    expect(matchHistory([again], [{ ...script, user: undefined }], { ...I, agentUser: 'admin' }).unmatched).toBe(1);
    expect(matchHistory([again], [{ ...script, user: 'jane.dev' }], { ...I, agentUser: 'admin' }).unmatched).toBe(1);
  });

  it('uses an asymmetric window: about 2 s before the call starts, the window after it ends', () => {
    const c = call({ sysId: id, at: at0, end: at0 + 5000 });
    const before = (ms: number) => { const e = ev({ sysId: id, at: at0 - ms }); matchHistory([e], [c], I); return e.confidence; };
    const after = (ms: number) => { const e = ev({ sysId: id, at: at0 + 5000 + ms }); matchHistory([e], [c], I); return e.confidence; };
    expect(before(LOG_LEAD_MS - 500)).toBe('log');
    expect(before(LOG_LEAD_MS + 500)).toBe('history');
    expect(before(50_000)).toBe('history');
    expect(after(DEFAULT_LOG_WINDOW_MS - 1000)).toBe('log');
    expect(after(DEFAULT_LOG_WINDOW_MS + 1000)).toBe('history');
  });

  it('drops calls on another instance, and caps calls on an unknown one at likely', () => {
    const e = ev({ sysId: id });
    expect(matchHistory([e], [call({ sysId: id, host: 'other' })], I).unmatched).toBe(1);
    expect(matchHistory([e], [call({ sysId: id, host: undefined })], I)).toMatchObject({ matched: 0, hostUnknown: 1 });
    expect(e.confidence).toBe('likely');
    expect(matchHistory([e], [call({ sysId: id })], { instance: null }).hostUnknown).toBe(1);
    expect(matchHistory([e], [call({ sysId: id, host: 'inmorphisdemo3' })], { instance: 'https://inmorphisdemo3.service-now.com' }).matched).toBe(1);
  });

  it('matches recaptures to capture calls only, and leaves them out of the counts', () => {
    const cap = ev({ kind: 'captured', sysId: id });
    const counts = matchHistory([cap], [call({ sysId: id }), call({ line: 2, tool: 'sn_update_set_manage', kind: 'capture', sysId: id })], I);
    expect(counts.events).toBe(0);
    expect(cap).toMatchObject({ confidence: 'log', log: [{ line: 2 }] });
  });

  it('leaves events outside the window, on another table or collection, or of another kind as history', () => {
    const e = [
      ev({ sysId: id, at: at0 + DEFAULT_LOG_WINDOW_MS + 5000 }),
      ev({ sysId: other, table: 'sp_page' }),
      ev({ kind: 'created', table: 'sys_dictionary', keys: ['credit score'], collection: 'x_other' }),
      ev({ kind: 'deleted', sysId: id }),
    ];
    const calls = [
      call({ sysId: id }),
      call({ line: 2, tool: 'sn_create_field', kind: 'create', tables: ['sys_dictionary'], collection: 'x_app_t', names: ['credit score'] }),
    ];
    expect(matchHistory(e, calls, I)).toMatchObject({ matched: 0, ambiguous: 0, timeOnly: 0, unmatched: 4 });
    expect(e.every(x => x.confidence === 'history' && x.log === undefined)).toBe(true);
    // A wider window reaches the first one.
    expect(matchHistory([e[0]], calls, { ...I, windowMs: DEFAULT_LOG_WINDOW_MS + 10_000 }).matched).toBe(1);
  });

  it('measures the match rate on the fixture (183 rows, 400 log lines)', async () => {
    const { c } = await setup();
    const { scope, pulled, manifest, files } = await pull(c);
    writeMirror(snRoot(dir), files, manifest);
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: logFile(), full: pulled.full, agentUser: 'admin' });
    expect(t.doc.log).toMatchObject({ found: true, lines: 401, parsed: 401, windowMs: 60_000, otherInstance: 0, unknownInstance: 0, agentUser: 'admin', agentUserFrom: 'session' });
    expect(t.doc.counts).toEqual(FIXTURE_COUNTS);
    // Every log match names its record; every likely one keeps its candidates.
    for (const e of t.doc.events) {
      if (e.confidence === 'log') expect(e.log).toHaveLength(1);
      if (e.confidence === 'likely') expect(e.log!.length).toBeGreaterThan(0);
      if (e.confidence === 'history') expect(e.log).toBeUndefined();
    }
    const byTable = (conf: string) => [...new Set(saves(t.doc.events).filter(e => e.confidence === conf).map(e => e.table))].sort();
    expect(byTable('log')).toEqual(['sp_page', 'sp_widget', 'sys_dictionary']);
    // Events of mirrored records point at their file.
    const withPath = t.doc.events.filter(e => e.path);
    expect(withPath.length).toBeGreaterThan(100);
    for (const e of withPath) expect(files.has(e.path!), e.path).toBe(true);
    // Stored next to the manifest, and the mirror's .gitignore hides it from the map.
    writeHistory(snRoot(dir), scope.scope, t.doc);
    expect(readHistory<typeof t.doc>(snRoot(dir), scope.scope)?.counts.matched).toBe(FIXTURE_COUNTS.matched);
    expect(fs.readFileSync(path.join(snRoot(dir), '.gitignore'), 'utf8')).toContain('*.history.json');
  });

  it('matches nothing at log when the log never says which instance it is on', async () => {
    const { c } = await setup();
    const { scope, pulled, manifest } = await pull(c);
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: logFile(false), full: pulled.full, agentUser: 'admin' });
    expect(t.doc.counts.matched).toBe(0);
    expect(t.doc.counts.hostUnknown).toBe(FIXTURE_COUNTS.matched);
    expect(t.doc.log?.unknownInstance).toBe(t.doc.log?.calls);
  });

  it('skips attribution when there is no log', async () => {
    const { c } = await setup();
    const { scope, pulled, manifest } = await pull(c);
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: path.join(dir, 'missing.log') });
    expect(t.log).toBeNull();
    expect(t.doc.log).toMatchObject({ found: false, lines: 0 });
    expect(t.doc.counts).toMatchObject({ matched: 0, unmatched: t.doc.counts.events });
  });

  it('asks nexus for its user within the budget, and reads several answer shapes', async () => {
    expect(await sessionUser((await setup()).c)).toBe('admin');
    expect(await sessionUser((await setup({ sessionContext: { success: true, data: { user: { user_name: 'Agent.Bot' } } } })).c)).toBe('agent.bot');
    expect(await sessionUser((await setup({ sessionContext: { success: false, error: 'no session' } })).c)).toBeNull();
    // Out of time: no call is made.
    const { m, c } = await setup();
    expect(await sessionUser(c, { at: 0, now: () => 1 })).toBeNull();
    expect(m.calls.filter(x => (x.inner ?? x.tool) === 'sn_session_context')).toHaveLength(0);
  });

  it('uses the nexus user for matching and lists every agent user in the summary', async () => {
    const { m, c } = await setup({ sessionContext: { success: true, data: { user_name: 'admin' } } });
    const { scope, pulled, manifest } = await pull(c);
    const f = path.join(dir, 'users.log');
    fs.writeFileSync(f, [AUTH_LINE, '[2026-05-29T00:00:01.000Z] [INFO] [Tool] tool_execute | tool=sn_switch_application_scope, scope=x, servicenow_username=agent.two', ...fx.mcpLogExcerpt.lines].join('\n'));
    const t = await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: f, full: pulled.full });
    expect(m.calls.some(x => (x.inner ?? x.tool) === 'sn_session_context')).toBe(true);
    expect(t.doc.log).toMatchObject({ agentUser: 'admin', agentUserFrom: 'session', agentUsers: ['admin', 'agent.two'] });
    expect(t.doc.counts).toEqual(FIXTURE_COUNTS);
  });

  it('stores the log path relative to the home folder', () => {
    expect(homeRelative(path.join(os.homedir(), '.skyforge', 'skyforge-mcp.log'))).toBe('~/.skyforge/skyforge-mcp.log');
    const outside = path.resolve(path.parse(os.homedir()).root, 'logs', 'x.log');
    expect(homeRelative(outside)).toBe(outside);
  });
});

/** The fixture's attribution, as the PR states it. */
const FIXTURE_COUNTS = { events: 112, matched: 18, ambiguous: 0, hostUnknown: 0, timeOnly: 3, authorUnchecked: 0, unmatched: 91 };
