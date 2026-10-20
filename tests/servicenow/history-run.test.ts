import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullScope, resolveScope } from '../../plugins/servicenow/backfill.js';
import { layoutMirror } from '../../plugins/servicenow/mirror.js';
import { NexusClient } from '../../plugins/servicenow/nexus.js';
import { snRoot, writeHistory, writeMirror, historyPath } from '../../plugins/servicenow/writer.js';
import { serviceNowAnalyzer } from '../../plugins/servicenow/analyzer.js';
import { buildTimeline, type TimelineDoc, type TimelineEvent } from '../../plugins/servicenow/timeline.js';
import { attributionOf, buildHistoryRun, historyRunId, importScopeHistory } from '../../plugins/servicenow/history-run.js';
import { ProjectModel } from '../../src/engine/project.js';
import { ANALYZERS } from '../../src/engine/domain/index.js';
import { buildDomainIndex } from '../../src/engine/domain/build-index.js';
import { HistoryStore } from '../../src/history/store.js';
import { emptyState } from '../../src/shared/state.js';
import type { ChangeSummary, FileModel } from '../../src/shared/types.js';
import { rmTree } from '../helpers/platform.js';
import { startMockNexus } from '../helpers/mock-nexus.js';

const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;
const NS = 'x_snc_cc_offering';
const T0 = Date.UTC(2026, 4, 29, 9, 0, 0);
const DAY = 86_400_000;
const temps: string[] = [];
const tmp = (p: string) => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p))); temps.push(d); return d; };
afterEach(async () => { for (const d of temps.splice(0)) rmTree(d); });

const fileModel = (p: string, lines = 10): FileModel => ({
  path: p, lang: p.endsWith('.js') ? 'javascript' : 'json', size: lines * 20, lines,
  symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
const ev = (over: Partial<TimelineEvent> & { at: number; path?: string }): TimelineEvent => ({
  kind: 'modified', table: 'sys_script', update: 'u', name: 'n', keys: [], author: 'admin', source: 'version', confidence: 'history', ...over,
});

const changesOf = (records: { msg: { type: string } }[]) => records.filter(r => r.msg.type === 'change').map(r => (r.msg as unknown as { change: ChangeSummary }).change);

describe('buildHistoryRun', () => {
  const files = [
    fileModel('x/business_rule/t/a__1.js'),
    fileModel('x/business_rule/t/b__2.js'),
    fileModel('x/widget/card__3/template.html'),
    fileModel('x/widget/card__3/server.js'),
    fileModel('x/schema/t.sntable.json'),
  ];

  it('starts without what history creates, and adds it at the real time', () => {
    const run = buildHistoryRun({ root: '/r', name: 'x', files, events: [
      ev({ at: T0, kind: 'created', path: 'x/widget/card__3' }),
      ev({ at: T0 + DAY, kind: 'modified', path: 'x/business_rule/t/a__1.js' }),
      ev({ at: T0 + 2 * DAY, kind: 'created', path: 'x/business_rule/t/b__2.js' }),
    ] });
    expect(run.start.files.map(f => f.path).sort()).toEqual(['x/business_rule/t/a__1.js', 'x/schema/t.sntable.json']);
    const changes = changesOf(run.records);
    expect(changes.map(c => c.at)).toEqual([T0, T0 + DAY, T0 + 2 * DAY]);
    expect(changes.map(c => [c.path, c.kind])).toEqual([['x/widget/card__3/template.html', 'created'], ['x/business_rule/t/a__1.js', 'modified'], ['x/business_rule/t/b__2.js', 'created']]);
    // A folder record brings all its files.
    expect((run.records[0].msg as { files: FileModel[] }).files.map(f => f.path)).toEqual(['x/widget/card__3/template.html', 'x/widget/card__3/server.js']);
    expect(changes[0].lines.added).toBe(20);
    expect(run.used).toBe(3);
  });

  it('leaves out recaptures and events with no mirrored file; a delete removes the files', () => {
    const run = buildHistoryRun({ root: '/r', name: 'x', files, events: [
      ev({ at: T0, kind: 'captured', path: 'x/business_rule/t/a__1.js' }),
      ev({ at: T0 + 1, kind: 'deleted' }),
      ev({ at: T0 + 2, kind: 'modified', path: 'x/gone/thing__9.json' }),
      ev({ at: T0 + 3, kind: 'deleted', path: 'x/business_rule/t/b__2.js' }),
      ev({ at: T0 + 4, kind: 'created', path: 'x/business_rule/t/b__2.js' }),
    ] });
    expect(run.used).toBe(2);
    expect(run.skipped).toBe(3);
    // b's first event is a delete, so it existed before the history: in the start state.
    expect(run.start.files.map(f => f.path)).toContain('x/business_rule/t/b__2.js');
    expect(run.records[0].msg).toMatchObject({ type: 'change', removed: ['x/business_rule/t/b__2.js'], files: [] });
    expect(run.records[1].msg).toMatchObject({ type: 'change', removed: [] });
    expect(changesOf(run.records).map(c => c.kind)).toEqual(['deleted', 'created']);
  });

  it('shared files: a create of a file already there, and a delete of a file there now, are changes', () => {
    // A table and its columns all map to one .sntable.json.
    const run = buildHistoryRun({ root: '/r', name: 'x', files, events: [
      ev({ at: T0, kind: 'created', table: 'sys_db_object', path: 'x/schema/t.sntable.json' }),
      ev({ at: T0 + 1, kind: 'created', table: 'sys_dictionary', path: 'x/schema/t.sntable.json' }),
      ev({ at: T0 + 2, kind: 'created', table: 'sys_dictionary', path: 'x/schema/t.sntable.json' }),
      ev({ at: T0 + 3, kind: 'deleted', table: 'sys_dictionary', path: 'x/schema/t.sntable.json' }),
      ev({ at: T0 + 4, kind: 'deleted', path: 'x/business_rule/t/a__1.js' }),
    ] });
    expect(run.start.files.map(f => f.path)).not.toContain('x/schema/t.sntable.json');
    const changes = changesOf(run.records);
    expect(changes.map(c => c.kind)).toEqual(['created', 'modified', 'modified', 'modified', 'modified']);
    expect(changes.map(c => c.lines.added)).toEqual([10, 0, 0, 0, 0]);
    expect(run.records.filter(r => r.msg.type === 'change').every(r => (r.msg as { removed: string[] }).removed.length === 0)).toBe(true);
    // The run ends with every file there now.
    expect(run.records.at(-1)!.msg).toEqual({ type: 'files', files, removed: [] });
  });

  it('carries the start and final domain when given a builder', () => {
    const run = buildHistoryRun({ root: '/r', name: 'x', files, events: [ev({ at: T0, kind: 'created', path: 'x/business_rule/t/b__2.js' })], domainOf: fs2 => ({ ...emptyState('', '').domain, counts: { ...emptyState('', '').domain.counts, tables: fs2.length } }) });
    expect(run.start.domain.counts.tables).toBe(4);
    expect(run.records.at(-1)!.msg).toMatchObject({ type: 'domain', domain: { counts: { tables: 5 } } });
  });

  it('attributes by the log evidence; a save known only from the version history has no attribution', () => {
    expect(attributionOf(ev({ at: T0, confidence: 'log', log: [{ line: 12, at: T0, tool: 'sn_record_manage' }] }))).toMatchObject({ agent: 'skyforge', confidence: 'log', rule: 'log', reason: expect.stringContaining('SkyForge log line 12') });
    expect(attributionOf(ev({ at: T0, confidence: 'likely', reason: 'author not checked', log: [{ line: 1, at: T0, tool: 'a' }, { line: 2, at: T0, tool: 'b' }] }))).toMatchObject({ confidence: 'likely', reason: expect.stringContaining('(2 candidate calls); author not checked') });
    expect(attributionOf(ev({ at: T0, author: 'dev.user1' }))).toBeUndefined();
    expect(attributionOf(ev({ at: T0, confidence: 'log', log: [] }))).toBeUndefined();
    const run = buildHistoryRun({ root: '/r', name: 'x', files, events: [ev({ at: T0, author: 'dev.user1', path: 'x/business_rule/t/a__1.js' })] });
    const [c] = changesOf(run.records);
    expect(c.attribution).toBeUndefined();
    expect(c.savedBy).toBe('dev.user1');
  });
});

describe('HistoryStore.importRun and importScopeHistory', () => {
  const files = [fileModel('x/business_rule/t/a__1.js'), fileModel('x/business_rule/t/b__2.js'), fileModel('x/acl/read/t__4.json')];
  const writeDoc = (root: string, events: TimelineEvent[], partial = false) => writeHistory(root, NS, { instance: 'devtest', scope: { sys_id: 's', scope: NS, name: 'App' }, sources: { partial }, events } as unknown as TimelineDoc);

  async function setup() {
    const home = tmp('lm-hrun-home-');
    const root = snRoot(tmp('lm-hrun-proj-'));
    fs.mkdirSync(root, { recursive: true });
    const open = (capMb?: number) => HistoryStore.open(root, { home, ...(capMb ? { capMb } : {}) });
    return { home, root, open };
  }

  it('writes a back-dated run before the live one, and rewinds through it', async () => {
    const s = await setup();
    writeDoc(s.root, [
      ev({ at: T0, kind: 'created', path: 'x/business_rule/t/a__1.js', confidence: 'log', log: [{ line: 3, at: T0, tool: 'sn_record_manage' }] }),
      ev({ at: T0 + 30 * DAY, kind: 'created', path: 'x/business_rule/t/b__2.js' }),
      ev({ at: T0 + 100 * DAY, kind: 'modified', path: 'x/business_rule/t/a__1.js' }),
    ]);
    const store = await s.open();
    const r = await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files, domainOf: fs2 => buildDomainIndex(fs2, () => null) });
    expect(r).toEqual({ status: 'imported', imported: 3, skipped: 0, runId: historyRunId(NS) });
    await store.startRun({ ...emptyState(s.root, NS), files });
    const info = store.info();
    expect(info.runs.map(x => x.id)).toEqual(['sn-history-x_snc_cc_offering', expect.any(String)]);
    expect(info.runs[0].startAt).toBe(T0);
    expect(info.runs[1].firstSeq).toBe(info.runs[0].lastSeq + 1);
    const at = async (seq: number) => (await store.stateAt(seq)).files.map(f => f.path).sort();
    expect(await at(info.runs[0].firstSeq)).toEqual(['x/acl/read/t__4.json']);
    expect(await at(info.runs[0].firstSeq + 1)).toEqual(['x/acl/read/t__4.json', 'x/business_rule/t/a__1.js']);
    expect(await at(info.runs[0].firstSeq + 2)).toEqual(['x/acl/read/t__4.json', 'x/business_rule/t/a__1.js', 'x/business_rule/t/b__2.js']);
    const end = await store.stateAt(info.runs[0].lastSeq);
    expect(end.changes.map(c => [c.kind, c.attribution?.confidence, c.savedBy])).toEqual([['created', 'log', 'admin'], ['created', undefined, 'admin'], ['modified', undefined, 'admin']]);
    expect(end.at).toBe(T0 + 100 * DAY);
    await store.close();
  });

  it('imports once per scope: not again on a restart, for newer saves, or after the cap deletes the run', async () => {
    const s = await setup();
    const first = [ev({ at: T0, kind: 'created', path: 'x/business_rule/t/a__1.js' }), ev({ at: T0 + DAY, kind: 'modified', path: 'x/business_rule/t/a__1.js' })];
    writeDoc(s.root, first);
    let store = await s.open();
    expect((await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).imported).toBe(2);
    await store.startRun({ ...emptyState(s.root, NS), files });
    await store.close();

    store = await s.open();
    const before = store.info();
    expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toMatchObject({ status: 'already', imported: 0 });
    expect(store.info().runs).toEqual(before.runs);
    expect(store.info().last).toBe(before.last);
    await store.close();

    // Live polling appended a newer save to history.json, and the live run recorded it: not imported again.
    writeDoc(s.root, [...first, ev({ at: T0 + 5 * DAY, kind: 'created', path: 'x/business_rule/t/b__2.js' })]);
    store = await s.open();
    expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toMatchObject({ status: 'already' });
    expect(store.info().runs).toEqual(before.runs);
    // A tiny cap deletes the oldest runs, the import first, when a live run starts.
    await store.close();
    store = await s.open(0.000_01);
    await store.startRun({ ...emptyState(s.root, NS), files });
    expect(store.info().runs.map(x => x.id)).not.toContain(historyRunId(NS));
    await store.close();
    for (let k = 0; k < 4; k++) {
      store = await s.open(0.000_01);
      expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toMatchObject({ status: 'already', imported: 0 });
      expect(store.info().runs.map(x => x.id)).not.toContain(historyRunId(NS));
      await store.close();
    }
  });

  it('a partial history is not imported, and a later full one is', async () => {
    const s = await setup();
    const events = [ev({ at: T0, kind: 'created', path: 'x/business_rule/t/a__1.js' })];
    writeDoc(s.root, events, true);
    let store = await s.open();
    expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toMatchObject({ status: 'partial', imported: 0 });
    expect(store.info().runs).toEqual([]);
    expect(store.imported(historyRunId(NS))).toBe(false);
    await store.close();
    writeDoc(s.root, events);
    store = await s.open();
    expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toMatchObject({ status: 'imported', imported: 1 });
    await store.close();
  });

  it('refuses once the live run started, a duplicate id, a bad id, and an empty run', async () => {
    const s = await setup();
    const store = await s.open();
    const start = emptyState(s.root, NS);
    const rec = [{ at: T0, msg: { type: 'files' as const, files: [], removed: [] } }];
    expect(await store.importRun('sn-history-a-1', start, [])).toBe(0);
    expect(await store.importRun('bad id/../x', start, rec)).toBe(0);
    expect(await store.importRun('sn-history-a-1', start, rec)).toBe(1);
    expect(await store.importRun('sn-history-a-1', start, rec)).toBe(0);
    expect(store.imported('sn-history-a-1')).toBe(true);
    await store.startRun(start);
    expect(await store.importRun('sn-history-a-2', start, rec)).toBe(0);
    // Live appends still go to the live run.
    expect(store.append({ type: 'files', files: [], removed: [] })).toBeGreaterThan(0);
    await store.close();
  });

  it('no history file: nothing happens', async () => {
    const s = await setup();
    const store = await s.open();
    expect(await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files })).toEqual({ status: 'none', imported: 0, skipped: 0, runId: historyRunId(NS) });
    expect(store.info().runs).toEqual([]);
    await store.close();
  });

  it('3,000 events over 1,700 files import fast', async () => {
    const s = await setup();
    const many: FileModel[] = [];
    for (let i = 0; i < 1700; i++) many.push(fileModel(`x/business_rule/t/r${i}__${i.toString(16).padStart(32, '0')}.js`, 40));
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 3000; i++) events.push(ev({ at: T0 + i * 60_000, kind: i < 1700 ? 'created' : 'modified', path: many[i % 1700].path, confidence: i % 3 ? 'history' : 'log', log: i % 3 ? undefined : [{ line: i, at: T0, tool: 'sn_record_manage' }] }));
    writeDoc(s.root, events);
    const store = await s.open();
    const t = performance.now();
    const r = await importScopeHistory(store, { root: s.root, name: NS, scope: NS, files: many });
    const ms = performance.now() - t;
    expect(r.imported).toBe(3000);
    expect(ms).toBeLessThan(5000 * TIME_SCALE);
    const info = store.info();
    // The changes, then the final files and domain records.
    expect(info.runs[0].lastSeq - info.runs[0].firstSeq).toBe(3001);
    expect((await store.stateAt(info.runs[0].lastSeq)).files).toHaveLength(1700);
    await store.close();
  }, 60_000 * TIME_SCALE);
});

describe('the fixture history as a back-dated run', () => {
  let dir: string;
  let root: string;
  let model: ProjectModel;
  let doc: TimelineDoc;

  beforeAll(async () => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hrun-fx-')));
    const m = await startMockNexus();
    const c = new NexusClient({ url: m.url, instance: 'inmorphisdemo3' });
    try {
      const scope = await resolveScope(c, NS);
      const pulled = await pullScope(c, scope);
      root = snRoot(dir);
      const { files, manifest } = layoutMirror({ instance: 'inmorphisdemo3', scope, ...pulled, rootAbs: root });
      writeMirror(root, files, manifest);
      doc = (await buildTimeline(c, scope, pulled.inventory, manifest, { logFile: null, full: pulled.full, agentUser: null })).doc;
      writeHistory(root, NS, doc);
    } finally {
      await c.close();
      await m.close();
    }
    model = new ProjectModel(root, { analyzers: [...ANALYZERS, serviceNowAnalyzer(root)] });
    await model.scan();
  }, 120_000 * TIME_SCALE);
  afterAll(() => rmTree(dir));

  it('replays the scope growing, and ends where the live run starts', async () => {
    expect(fs.existsSync(historyPath(root, NS))).toBe(true);
    const home = tmp('lm-hrun-fxhome-');
    const store = await HistoryStore.open(root, { home });
    const files = model.all();
    const r = await importScopeHistory(store, { root, name: NS, scope: NS, files, domainOf: fs2 => buildDomainIndex(fs2, p => model.content(p)) });
    expect(r.imported).toBeGreaterThan(50);
    expect(r.imported + r.skipped).toBe(doc.events.filter(e => e.kind !== 'captured').length + doc.events.filter(e => e.kind === 'captured').length);
    const run = store.info().runs[0];
    const first = await store.stateAt(run.firstSeq);
    const last = await store.stateAt(run.lastSeq);
    expect(first.files.length).toBeLessThan(last.files.length);
    expect(last.files.map(f => f.path).sort()).toEqual(files.map(f => f.path).sort());
    expect(first.at).toBe(Math.min(...doc.events.filter(e => e.kind !== 'captured' && e.path).map(e => e.at)));
    // Times only go forward through the run.
    const msgs = store.messages(run.firstSeq, run.lastSeq, 5000);
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].at).toBeGreaterThanOrEqual(msgs[i - 1].at);
    expect(last.domain.tables.length).toBeGreaterThan(0);
    // Only SkyForge log matches are attributions; the rest carry who saved them.
    expect(last.changes.every(c => c.attribution === undefined || c.attribution.agent === 'skyforge')).toBe(true);
    expect(last.changes.filter(c => !c.attribution).every(c => typeof c.savedBy === 'string')).toBe(true);
    await store.close();
  });
});
