import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullScope, resolveScope } from '../../plugins/servicenow/backfill.js';
import { changeFacts, readChangeRows, updateNameIndex, updateSetNames } from '../../plugins/servicenow/changes.js';
import { layoutMirror, readHeader, type ChangeFacts } from '../../plugins/servicenow/mirror.js';
import { NexusClient, NexusOfflineError } from '../../plugins/servicenow/nexus.js';
import { initialState, ScopePoller } from '../../plugins/servicenow/poller.js';
import { recordResolver } from '../../plugins/servicenow/records.js';
import { LiveTimeline, type TimelineDoc } from '../../plugins/servicenow/timeline.js';
import { readHistory, readManifest, readPollState, snRoot, writeMirror } from '../../plugins/servicenow/writer.js';
import type { SourceStatus } from '../../src/shared/protocol.js';
import { rmTree } from '../helpers/platform.js';
import { loadFixture, startMockNexus, type MockNexus } from '../helpers/mock-nexus.js';

const fx = loadFixture();
const SET = '5f0000000000000000000000000fe001';
const SET2 = '5f0000000000000000000000000fe002';
const rule = fx.tables.sys_script[0] as Record<string, string>;
const widget = fx.tables.sp_widget[0] as Record<string, string>;
const open: { close(): Promise<void> }[] = [];
let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-snp-'))); });
afterEach(async () => {
  for (const o of open.splice(0).reverse()) await o.close();
  rmTree(dir);
});

/** A row as the instance writes it when a record is saved into an update set. */
const xmlRow = (n: number, table: string, sysId: string, on: string, over: Record<string, string> = {}) => ({
  sys_id: `5e${String(n).padStart(30, '0')}`, name: `${table}_${sysId}`, type: 'Business Rule', target_name: 'x', action: 'INSERT_OR_UPDATE',
  update_set: SET, sys_created_by: 'admin', sys_updated_by: 'dev.one', sys_updated_on: on, payload: '', ...over,
});

/** Pulls the scope, writes the mirror with its change facts, and makes a poller on a second ("live") client. */
async function setup(extraUpdateXml: Record<string, string>[] = []) {
  const m = await startMockNexus({ extraUpdateXml });
  open.push(m);
  m.live.rows.sys_update_set = [{ sys_id: SET, name: 'Card refresh' }, { sys_id: SET2, name: 'Fixes' }];
  const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', backoffMs: 1 });
  open.push(c);
  const scope = await resolveScope(c, 'x_snc_cc_offering');
  const pulled = await pullScope(c, scope);
  const rows = await readChangeRows(c, scope);
  const names = await updateSetNames(c, rows);
  const facts = changeFacts(rows, updateNameIndex(pulled.full), names);
  const root = snRoot(dir);
  const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: root, facts });
  writeMirror(root, files, manifest);
  const live = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', attempts: 1, backoffMs: 1 });
  open.push(live);
  const statuses: SourceStatus[] = [];
  const skews: number[] = [];
  const poller = new ScopePoller(live, { instance: 'inmorphisdemo3', scope, inventory: pulled.inventory, full: pulled.full, facts, setNames: names }, initialState(scope.scope, rows, pulled.inventory), {
    root, intervalMs: 30, onStatus: s => statuses.push(s), onSkew: ms => skews.push(ms),
  });
  open.push({ close: async () => poller.stop() });
  const fileOf = (sysId: string) => readManifest(root, scope.scope)!.records[sysId]?.path;
  const read = (p: string) => fs.readFileSync(path.join(root, ...p.split('/')), 'utf8');
  return { m, scope, pulled, root, poller, statuses, skews, fileOf, read, facts };
}

describe('change facts in the mirror', () => {
  it("writes each record's latest update_xml row into its meta.json, script header and manifest", async () => {
    const { root, fileOf, read } = await setup([
      xmlRow(1, 'sp_widget', widget.sys_id, '2026-06-13 10:18:00', { update_set: SET2, sys_updated_by: 'dev.zero' }),
      xmlRow(2, 'sp_widget', widget.sys_id, '2026-06-14 09:00:00'),
      xmlRow(3, 'sys_script', rule.sys_id, '2026-06-15 08:00:00', { sys_updated_by: '' }),
    ]);
    // A folder record: the newest row's update set (as a reference, the shape M6 reads), user and time.
    const meta = JSON.parse(read(fileOf(widget.sys_id)!));
    expect(meta).toMatchObject({ sys_update_set: { value: SET, display_value: 'Card refresh' }, sys_updated_by: 'dev.one', sys_updated_on: '2026-06-14 09:00:00' });
    // A script: the same in its header, camelCase. No sys_updated_by on the row: the row's creator.
    expect(readHeader(read(fileOf(rule.sys_id)!))).toMatchObject({ updateSet: SET, updateSetName: 'Card refresh', updatedBy: 'admin', updatedOn: '2026-06-15 08:00:00' });
    // The manifest, and the record key the attribution gets, with the time as epoch ms.
    const key = recordResolver(root)(fileOf(rule.sys_id)!);
    expect(key).toMatchObject({ table: 'sys_script', sysId: rule.sys_id, updateSet: SET, updateSetName: 'Card refresh', updatedBy: 'admin', updatedOn: Date.parse('2026-06-15T08:00:00Z') });
  });

  it('takes the latest row whatever order the rows come in, and skips deletes and unknown update names', () => {
    const facts = changeFacts([
      { name: `sp_widget_${widget.sys_id}`, sys_updated_on: '2026-06-02 00:00:00', update_set: SET2, sys_updated_by: 'b' },
      { name: `sp_widget_${widget.sys_id}`, sys_updated_on: '2026-06-01 00:00:00', update_set: SET, sys_updated_by: 'a' },
      { name: 'sys_dictionary_x_t_gone', sys_updated_on: '2026-06-03 00:00:00', update_set: SET, sys_updated_by: 'c' },
      { name: `sp_page_${'ab'.repeat(16)}`, sys_updated_on: '2026-06-03 00:00:00', action: 'DELETE', sys_updated_by: 'd' },
      { name: `sp_page_${'cd'.repeat(16)}`, sys_updated_on: '2026-06-03 00:00:00', update_set: '""', sys_updated_by: 'e' },
    ], updateNameIndex(new Map()), new Map([[SET2, 'Fixes']]));
    expect([...facts]).toEqual<[string, ChangeFacts][]>([
      [widget.sys_id, { updateSet: SET2, updateSetName: 'Fixes', updatedBy: 'b', updatedOn: '2026-06-02 00:00:00' }],
      ['cd'.repeat(16), { updatedBy: 'e', updatedOn: '2026-06-03 00:00:00' }],
    ]);
  });
});

describe('live polling', () => {
  it('costs two queries when nothing changed, and writes nothing', async () => {
    const { m, poller } = await setup();
    m.calls.length = 0;
    const first = await poller.tick(); // the first poll also reads deletes
    expect(first).toMatchObject({ changed: [], deleted: [], queries: 3, written: null });
    const idle = await poller.tick();
    expect(idle).toMatchObject({ changed: [], deleted: [], queries: 2, written: null });
    expect(new Set(m.calls.map(c => c.inner ?? c.tool))).toEqual(new Set(['sn_query_table']));
  });

  it('applies a saved record: its file, its last change, and the cursor, once', async () => {
    const { m, root, poller, fileOf, read, scope } = await setup();
    const file = fileOf(rule.sys_id)!;
    m.live.rows.sys_update_xml = [xmlRow(10, 'sys_script', rule.sys_id, '2026-10-20 12:00:05')];
    m.live.rows.sys_script = [{ ...rule, script: '// changed in the UI\ngs.info("x");', sys_updated_on: '2026-10-20 12:00:05', sys_updated_by: 'dev.one' }];
    m.live.rows.sys_metadata = [{ sys_id: rule.sys_id, sys_class_name: 'sys_script', sys_name: rule.sys_name, sys_updated_on: '2026-10-20 12:00:05', sys_updated_by: 'dev.one', sys_scope: scope.sys_id }];
    const r = await poller.tick();
    expect(r.changed).toEqual([rule.sys_id]);
    expect(r.written?.written).toBeGreaterThan(0);
    const text = read(file);
    expect(text).toContain('// changed in the UI');
    expect(readHeader(text)).toMatchObject({ updateSet: SET, updateSetName: 'Card refresh', updatedBy: 'dev.one', updatedOn: '2026-10-20 12:00:05' });
    expect(poller.cursors).toMatchObject({ updateXml: '2026-10-20 12:00:05', metadata: '2026-10-20 12:00:05' });
    expect(readPollState(root, scope.scope)?.cursors.updateXml).toBe('2026-10-20 12:00:05');
    // The same second again: nothing new to apply. A second change in that second is applied.
    expect((await poller.tick()).changed).toEqual([]);
    m.live.rows.sys_update_xml.push(xmlRow(11, 'sp_widget', widget.sys_id, '2026-10-20 12:00:05', { update_set: SET2 }));
    expect((await poller.tick()).changed).toEqual([widget.sys_id]);
    expect(JSON.parse(read(fileOf(widget.sys_id)!)).sys_update_set).toEqual({ value: SET2, display_value: 'Fixes' });
  });

  it('applies a change made outside update sets, with no update set', async () => {
    const { m, poller, fileOf, read, scope } = await setup();
    m.live.rows.sys_metadata = [{ sys_id: widget.sys_id, sys_class_name: 'sp_widget', sys_name: widget.sys_name, sys_updated_on: '2026-10-20 12:30:00', sys_updated_by: 'jane.dev', sys_scope: scope.sys_id }];
    m.live.rows.sp_widget = [{ ...widget, template: '<div>new</div>', sys_updated_on: '2026-10-20 12:30:00' }];
    expect((await poller.tick()).changed).toEqual([widget.sys_id]);
    const meta = JSON.parse(read(fileOf(widget.sys_id)!));
    expect(meta).toMatchObject({ sys_updated_by: 'jane.dev', sys_updated_on: '2026-10-20 12:30:00' });
    expect(meta.sys_update_set).toBeUndefined();
  });

  it('removes deleted records, from update_xml rows and from sys_metadata_delete', async () => {
    const { m, root, poller, fileOf, scope } = await setup();
    const ruleFile = fileOf(rule.sys_id)!;
    const widgetFile = fileOf(widget.sys_id)!;
    m.live.rows.sys_update_xml = [xmlRow(20, 'sys_script', rule.sys_id, '2026-10-20 13:00:00', { action: 'DELETE' })];
    m.live.rows.sys_metadata_delete = [{ sys_id: '5e0000000000000000000000000000d1', sys_update_name: `sp_widget_${widget.sys_id}`, sys_class_name: 'sp_widget', sys_updated_on: '2026-10-20 13:00:01', sys_scope: scope.sys_id }];
    const r = await poller.tick();
    expect(new Set(r.deleted)).toEqual(new Set([rule.sys_id, widget.sys_id]));
    expect(fs.existsSync(path.join(root, ...ruleFile.split('/')))).toBe(false);
    expect(fs.existsSync(path.join(root, ...widgetFile.split('/')))).toBe(false);
    expect(readManifest(root, scope.scope)!.records[rule.sys_id]).toBeUndefined();
  });

  it('goes offline when nexus does not answer, keeps the mirror, and catches up once it is back', async () => {
    const { m, poller, statuses, fileOf, read, scope } = await setup();
    const file = fileOf(rule.sys_id)!;
    const before = read(file);
    m.live.down = true;
    await expect(poller.tick()).rejects.toBeInstanceOf(NexusOfflineError);
    expect(read(file)).toBe(before);
    // A change made during the outage.
    m.live.rows.sys_update_xml = [xmlRow(30, 'sys_script', rule.sys_id, '2026-10-20 14:00:00')];
    m.live.rows.sys_script = [{ ...rule, script: '// made while offline', sys_updated_on: '2026-10-20 14:00:00' }];
    m.live.rows.sys_metadata = [{ sys_id: rule.sys_id, sys_class_name: 'sys_script', sys_name: rule.sys_name, sys_updated_on: '2026-10-20 14:00:00', sys_updated_by: 'dev.one', sys_scope: scope.sys_id }];
    poller.start();
    await until(() => statuses.at(-1)?.state === 'offline');
    expect(statuses.at(-1)).toMatchObject({ name: 'x_snc_cc_offering on inmorphisdemo3', state: 'offline' });
    m.live.down = false;
    await until(() => statuses.at(-1)?.state === 'online', 10_000);
    await until(() => read(file).includes('// made while offline'));
    expect(statuses.map(s => s.state)).toEqual(['offline', 'online']);
  });

  it('adds new saves to the history file, matched to the SkyForge log', async () => {
    const { m, root, scope, pulled } = await setup();
    const log = path.join(dir, 'skyforge-mcp.log');
    fs.writeFileSync(log, [
      '[2026-10-20T11:00:00.000Z] [INFO] [Auth] ✅ Connected to inmorphisdemo3.service-now.com',
      `[2026-10-20T12:00:04.000Z] [INFO] [Tool] tool_execute | tool=sn_edit_by_sysid, table=sys_script, sys_id=${rule.sys_id}, field=script, value=// fix`,
      '[2026-10-20T12:00:04.900Z] [INFO] [Tool] sn_edit_by_sysid ✅ 900ms',
    ].join('\n'));
    const doc = {
      instance: 'inmorphisdemo3', scope: { sys_id: scope.sys_id, scope: scope.scope, name: scope.name },
      sources: { versions: 0, updateXml: 0, fromVersions: 0, fromUpdateXml: 0, captured: 0, versionsBy: null, partial: false }, log: null,
      counts: { events: 0, matched: 0, ambiguous: 0, hostUnknown: 0, timeOnly: 0, authorUnchecked: 0, unmatched: 0 }, events: [],
    } as TimelineDoc;
    const history = new LiveTimeline(doc, { root, logFile: log, agentUser: 'admin' });
    const live = new NexusClient({ url: m.url, instance: 'inmorphisdemo3', attempts: 1 });
    open.push(live);
    const ctx = { instance: 'inmorphisdemo3', scope, inventory: pulled.inventory, full: pulled.full, facts: new Map(), setNames: new Map() };
    const poller = new ScopePoller(live, ctx, initialState(scope.scope, await readChangeRows(live, scope), pulled.inventory), {
      root, onSaves: (rows, c, man) => history.addSaves(rows, c.full, man, c.inventory),
    });
    m.live.rows.sys_update_xml = [
      xmlRow(40, 'sys_script', rule.sys_id, '2026-10-20 12:00:05'),
      xmlRow(41, 'sp_widget', widget.sys_id, '2026-10-20 12:10:00', { sys_updated_by: 'jane.dev' }),
    ];
    await poller.tick();
    const stored = readHistory<TimelineDoc>(root, scope.scope)!;
    expect(stored.events.map(e => [e.table, e.sysId, e.kind, e.author, e.confidence])).toEqual([
      ['sys_script', rule.sys_id, 'modified', 'dev.one', 'log'],
      ['sp_widget', widget.sys_id, 'modified', 'jane.dev', 'history'],
    ]);
    expect(stored.events[0].log).toEqual([{ line: 2, at: Date.parse('2026-10-20T12:00:04.000Z'), tool: 'sn_edit_by_sysid', ms: 900 }]);
    expect(stored.events[0].path).toBe(readManifest(root, scope.scope)!.records[rule.sys_id].path);
    expect(stored.counts).toMatchObject({ events: 2, matched: 1, unmatched: 1 });
    // The same rows again add nothing.
    await poller.tick();
    expect(readHistory<TimelineDoc>(root, scope.scope)!.events).toHaveLength(2);
  });

  it('learns the clock skew from exact matches, and keeps it for the next run', async () => {
    const { poller, skews, root, scope } = await setup();
    poller.learnGap(3000);
    poller.learnGap(-1000);
    expect(skews).toEqual([]); // two samples are not enough
    poller.learnGap(4000);
    expect(skews).toEqual([5000]); // median 3 s, plus a 2 s margin
    expect(readPollState(root, scope.scope)?.skewMs).toBe(5000);
  });

  it('uses the LiveMap client name, so its own session is never attributed, and only reads', async () => {
    const { m, poller } = await setup();
    await poller.tick();
    expect(new Set(m.clients)).toEqual(new Set(['livemap']));
    expect(m.calls.every(c => (c.inner ?? c.tool) === 'sn_query_table' || (c.inner ?? c.tool) === 'sn_get_instance_info' || c.tool === 'tool_search')).toBe(true);
  });
});

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
