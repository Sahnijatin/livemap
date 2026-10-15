import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DomainIndex } from '@shared/domain.js';
import { useStore, MAX_CHANGES, MAX_EVENTS, CENTER_TABS, loadTab, depKey, tableKey, fieldKey, routeBaseKey } from './store';
import { LARGE_PROJECT } from './map/mapModel';
import { file, change, event, session, emptyDomain } from './fixtures';
import { restHistorySource, setHistorySource, type HistorySource } from './history';
import { startPlayback } from './play';

const hello = (files = [file('a.ts'), file('b.ts'), file('c.ts')]) => ({
  type: 'hello' as const, root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
});

beforeEach(() => useStore.getState().reset());

describe('store.apply', () => {
  it('hello replaces everything; files upserts and removes', () => {
    const s = useStore.getState();
    s.apply({ type: 'hello', root: '/old', name: 'old', files: [file('zzz.ts')], changes: [change('zzz.ts')], usedBy: [{ file: 'zzz.ts', symbol: 'x', usedIn: [] }], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });
    s.apply(hello());
    let st = useStore.getState();
    expect(st.name).toBe('shop');
    expect(st.root).toBe('/p/shop');
    expect(Object.keys(st.files).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(st.changes).toEqual([]);
    expect(st.usedBy).toEqual([]);
    const c = st.files['c.ts'];

    const f2 = file('b.ts', [], { lines: 99 });
    s.apply({ type: 'files', files: [f2], removed: ['a.ts'] });
    st = useStore.getState();
    expect(Object.keys(st.files).sort()).toEqual(['b.ts', 'c.ts']);
    expect(st.files['b.ts']).toBe(f2);
    expect(st.files['c.ts']).toBe(c);
  });

  it('a change applies its file updates in the same state update', () => {
    const s = useStore.getState();
    s.apply(hello());
    const f2 = file('b.ts', [], { lines: 7 });
    let updates = 0;
    const unsub = useStore.subscribe(() => { updates++; });
    s.apply({ type: 'change', change: change('b.ts', 'modified'), files: [f2], removed: ['a.ts'] });
    unsub();
    expect(updates).toBe(1);
    const st = useStore.getState();
    expect(st.files['b.ts']).toBe(f2);
    expect(st.files['a.ts']).toBeUndefined();
    expect(st.recent['b.ts'].kind).toBe('modified');
  });

  it('change records recent kind, auto-expands the file and keeps the last 2,000 changes', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'created') });
    let st = useStore.getState();
    expect(st.recent['a.ts'].kind).toBe('created');
    expect(st.expanded['a.ts']).toBe(true);
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'modified') });
    expect(useStore.getState().recent['a.ts'].kind).toBe('modified');

    s.apply(hello());
    for (let i = 0; i < 2001; i++) s.apply({ type: 'change', files: [], removed: [], change: change(`f${i}.ts`) });
    st = useStore.getState();
    expect(MAX_CHANGES).toBe(2000);
    expect(st.changes).toHaveLength(2000);
    expect(st.changes[0].path).toBe('f1.ts');
    expect(st.changes[1999].path).toBe('f2000.ts');
  });

  it('a deleted change removes recent[path]; a removed selected path resets selected on the next files message', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'modified') });
    s.select('a.ts');
    s.apply({ type: 'change', files: [], removed: [], change: change('a.ts', 'deleted') });
    let st = useStore.getState();
    expect(st.recent['a.ts']).toBeUndefined();
    expect(st.selected).toBe('a.ts');
    s.apply({ type: 'files', files: [], removed: ['a.ts'] });
    st = useStore.getState();
    expect(st.selected).toBeNull();
  });

  it('usedBy replaces; indexing records progress until hello', () => {
    const s = useStore.getState();
    s.apply({ type: 'indexing', done: 3, total: 10 });
    expect(useStore.getState().indexing).toEqual({ done: 3, total: 10 });
    s.apply(hello());
    expect(useStore.getState().indexing).toBeNull();
    s.apply({ type: 'usedBy', usedBy: [{ file: 'a.ts', symbol: 'a', usedIn: ['b.ts'] }] });
    s.apply({ type: 'usedBy', usedBy: [{ file: 'b.ts', symbol: 'b', usedIn: ['c.ts'] }] });
    expect(useStore.getState().usedBy).toEqual([{ file: 'b.ts', symbol: 'b', usedIn: ['c.ts'] }]);
  });

  it('toggle flips expansion and setFilter stores the query', () => {
    const s = useStore.getState();
    s.toggle('a.ts');
    expect(useStore.getState().expanded['a.ts']).toBe(true);
    s.toggle('a.ts');
    expect(useStore.getState().expanded['a.ts']).toBe(false);
    s.setFilter('order');
    expect(useStore.getState().filter).toBe('order');
  });

  it('agentEvent appends and keeps the last 2,000 events', () => {
    const s = useStore.getState();
    s.apply(hello());
    for (let i = 1; i <= 2001; i++) s.apply({ type: 'agentEvent', event: event({ id: i, type: 'message', text: `m${i}` }) });
    const st = useStore.getState();
    expect(MAX_EVENTS).toBe(2000);
    expect(st.events).toHaveLength(2000);
    expect(st.events[0].id).toBe(2);
    expect(st.events[1999].id).toBe(2001);
  });

  it('session upserts and control replaces', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'session', session: session({ id: 's1', title: 'First' }) });
    s.apply({ type: 'session', session: session({ id: 's2' }) });
    s.apply({ type: 'session', session: session({ id: 's1', title: 'Renamed', status: 'idle' }) });
    let st = useStore.getState();
    expect(Object.keys(st.sessions).sort()).toEqual(['s1', 's2']);
    expect(st.sessions.s1.title).toBe('Renamed');
    expect(st.sessions.s1.status).toBe('idle');
    const control = { paused: true, flags: [{ id: 1, target: 'a.ts', note: 'n', createdAt: 1 }] };
    s.apply({ type: 'control', control });
    st = useStore.getState();
    expect(st.control).toEqual(control);
  });

  it('attribution patches the matching change by id', () => {
    const s = useStore.getState();
    s.apply(hello());
    const a = change('a.ts');
    const b = change('b.ts');
    s.apply({ type: 'change', change: a, files: [], removed: [] });
    s.apply({ type: 'change', change: b, files: [], removed: [] });
    const attribution = { agent: 'claude-code' as const, sessionId: 's1', confidence: 'exact' as const, intent: 'Add orders' };
    s.apply({ type: 'attribution', changeId: a.id, attribution });
    const st = useStore.getState();
    expect(st.changes[0].attribution).toEqual(attribution);
    expect(st.changes[1]).toBe(b);
    s.apply({ type: 'attribution', changeId: 99999, attribution });
    expect(useStore.getState().changes).toBe(st.changes);
  });

  it('hello replaces events, sessions and control and marks replayed events', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'agentEvent', event: event({ id: 1 }) });
    s.apply({ type: 'session', session: session({ id: 'old' }) });
    s.apply({ type: 'control', control: { paused: true, flags: [] } });
    s.apply({ ...hello(), events: [event({ id: 7 }), event({ id: 9 })], sessions: [session({ id: 'new' })], control: { paused: false, flags: [] } });
    const st = useStore.getState();
    expect(st.events.map(e => e.id)).toEqual([7, 9]);
    expect(Object.keys(st.sessions)).toEqual(['new']);
    expect(st.control).toEqual({ paused: false, flags: [] });
    expect(st.liveAfterId).toBe(9);
  });
});

const domainWith = (extra: Partial<DomainIndex>): DomainIndex => ({ ...emptyDomain(), ...extra });
const zod = { name: 'zod', version: '^3.23.0', eco: 'npm', file: 'package.json' };
const next = { id: 'nextjs', name: 'Next.js', category: 'frontend' as const, source: 'package.json' };

describe('store domain', () => {
  it('hello and domain messages set the domain; hello records the baseline for "new" items', () => {
    const s = useStore.getState();
    expect(s.domain).toEqual(emptyDomain());
    s.apply({ ...hello(), domain: domainWith({ stack: [next], deps: [zod] }) });
    let st = useStore.getState();
    expect(st.domain.stack).toEqual([next]);
    expect(st.domainBase.stack.has('nextjs')).toBe(true);
    expect(st.domainBase.deps.has(depKey(zod))).toBe(true);

    const prisma = { id: 'prisma', name: 'Prisma', category: 'orm' as const, source: 'package.json' };
    const added = { name: '@prisma/client', version: '^5.0.0', eco: 'npm', file: 'package.json' };
    s.apply({ type: 'domain', domain: domainWith({ stack: [next, prisma], deps: [zod, added] }) });
    st = useStore.getState();
    expect(st.domain.stack.map(t => t.id)).toEqual(['nextjs', 'prisma']);
    expect(st.domainBase.stack.has('prisma')).toBe(false);
    expect(st.domainBase.deps.has(depKey(added))).toBe(false);
  });

  it('hello records table and field keys as the baseline; later tables and fields are not in it', () => {
    const f = (name: string) => ({ name, type: 'String', file: 'prisma/schema.prisma' });
    const user = { name: 'User', table: 'User', orm: 'prisma', sources: [{ file: 'prisma/schema.prisma', line: 1 }], fields: [f('id')], relations: [] };
    const s = useStore.getState();
    s.apply({ ...hello(), domain: domainWith({ tables: [user] }) });
    let st = useStore.getState();
    expect(tableKey(user)).toBe('user');
    expect(st.domainBase.tables.has('user')).toBe(true);
    expect(st.domainBase.fields.has(fieldKey(user, user.fields[0]))).toBe(true);

    const grown = { ...user, fields: [f('id'), f('email')] };
    const order = { ...user, name: 'Order', table: 'orders', fields: [f('id')] };
    s.apply({ type: 'domain', domain: domainWith({ tables: [grown, order] }) });
    st = useStore.getState();
    expect(st.domainBase.tables.has('orders')).toBe(false);
    expect(st.domainBase.fields.has(fieldKey(grown, grown.fields[1]))).toBe(false);
  });

  it('hello records route keys (method, path, file) as the baseline; a moved line is not new, a new route is', () => {
    const r = (path: string, line: number) => ({ id: `GET ${path} a.ts:${line}`, method: 'GET', path, fullPath: path, line, kind: 'api' as const, framework: 'express', file: 'a.ts' });
    const s = useStore.getState();
    s.apply({ ...hello(), domain: domainWith({ routes: [r('/a', 1)] }) });
    s.apply({ type: 'domain', domain: domainWith({ routes: [r('/a', 5), r('/b', 6)] }) });
    const st = useStore.getState();
    expect(st.domainBase.routes.has(routeBaseKey(r('/a', 5)))).toBe(true);
    expect(st.domainBase.routes.has(routeBaseKey(r('/b', 6)))).toBe(false);
  });

  it('indexes routes by file once per domain update, stable across unrelated updates', () => {
    const r = (path: string, file: string) => ({ id: `GET ${path} ${file}:1`, method: 'GET', path, fullPath: path, line: 1, kind: 'api' as const, framework: 'express', file });
    const s = useStore.getState();
    s.apply({ ...hello(), domain: domainWith({ routes: [r('/a', 'a.ts'), r('/b', 'b.ts'), r('/a2', 'a.ts')] }) });
    const first = useStore.getState().routesByFile;
    expect(first['a.ts'].map(x => x.path)).toEqual(['/a', '/a2']);
    expect(first['c.ts']).toBeUndefined();
    s.apply({ type: 'usedBy', usedBy: [] });
    expect(useStore.getState().routesByFile).toBe(first);
    s.apply({ type: 'domain', domain: domainWith({ routes: [r('/c', 'c.ts')] }) });
    expect(Object.keys(useStore.getState().routesByFile)).toEqual(['c.ts']);
  });

  it('a hello without a domain falls back to an empty one', () => {
    const { domain: _d, ...rest } = hello();
    useStore.getState().apply(rest as ReturnType<typeof hello>);
    expect(useStore.getState().domain).toEqual(emptyDomain());
  });
});

describe('store tab', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to activity, persists the tab and reads it back', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
    expect(useStore.getState().tab).toBe('activity');
    expect(loadTab()).toBe('activity');
    useStore.getState().setTab('stack');
    expect(useStore.getState().tab).toBe('stack');
    expect(loadTab()).toBe('stack');
    mem.set('livemap-tab', 'nonsense');
    expect(loadTab()).toBe('activity');
  });

  it('accepts and persists the map tab; tabs are ordered activity, map, schema, api, stack', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
    expect(CENTER_TABS).toEqual(['activity', 'map', 'schema', 'api', 'stack']);
    useStore.getState().setTab('map');
    expect(useStore.getState().tab).toBe('map');
    expect(mem.get('livemap-tab')).toBe('map');
    expect(loadTab()).toBe('map');
  });

  it('survives a localStorage that throws', () => {
    const boom = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(loadTab()).toBe('activity');
    useStore.getState().setTab('schema');
    expect(useStore.getState().tab).toBe('schema');
  });
});

describe('store map state', () => {
  const imp = (path: string, local: string[]) => file(path, [], { imports: { local, external: [] } });

  it('captures the hello edge baseline at file and folder level, with buildMap ids', () => {
    useStore.getState().apply(hello([
      imp('src/web/App.tsx', ['src/web/Page.tsx', 'src/api/orders.ts', 'README.md', 'src/web/App.tsx']),
      imp('src/web/Page.tsx', ['src/api/orders.ts']),
      imp('src/api/orders.ts', []),
      file('README.md', [], { lang: 'markdown' }),
    ]));
    const base = useStore.getState().helloEdges;
    expect([...base].sort()).toEqual([
      'dir:src/web->dir:src/api',
      'src/web/App.tsx->src/api/orders.ts',
      'src/web/App.tsx->src/web/Page.tsx',
      'src/web/Page.tsx->src/api/orders.ts',
    ]);
    // Later file updates leave the baseline alone.
    useStore.getState().apply({ type: 'files', files: [imp('src/api/orders.ts', ['src/web/Page.tsx'])], removed: [] });
    expect(useStore.getState().helloEdges).toBe(base);
  });

  it('level defaults to files, switches, and opens at folders above the large-project threshold', () => {
    expect(useStore.getState().mapLevel).toBe('files');
    useStore.getState().setMapLevel('functions');
    expect(useStore.getState().mapLevel).toBe('functions');
    useStore.getState().reset();
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 7}/f${i}.ts`));
    useStore.getState().apply(hello(many));
    expect(useStore.getState().mapLevel).toBe('folders');
    // A reconnect keeps the level the user chose.
    useStore.getState().setMapLevel('files');
    useStore.getState().apply(hello(many));
    expect(useStore.getState().mapLevel).toBe('files');
  });

  it('expands and collapses map folders', () => {
    const s = useStore.getState();
    s.toggleMapFolder('dir:src');
    expect(useStore.getState().mapExpanded).toEqual({ 'dir:src': true });
    s.toggleMapFolder('dir:src');
    expect(useStore.getState().mapExpanded).toEqual({});
    s.expandMapFolder('dir:lib');
    s.expandMapFolder('dir:lib');
    expect(useStore.getState().mapExpanded).toEqual({ 'dir:lib': true });
  });
});

describe('store history and focus requests', () => {
  it('history keeps the last 8 distinct selected files, most recent first', () => {
    const s = useStore.getState();
    for (const p of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) s.select(`${p}.ts`);
    s.select('c.ts');
    s.revealLine('z.ts', 4);
    s.select(null);
    expect(useStore.getState().history).toEqual(['z.ts', 'c.ts', 'i.ts', 'h.ts', 'g.ts', 'f.ts', 'e.ts', 'd.ts']);
  });

  it('focus requests carry a sequence so repeats fire', () => {
    const s = useStore.getState();
    s.focusMap('a.ts');
    const first = useStore.getState().mapFocus!;
    s.focusMap('a.ts');
    expect(useStore.getState().mapFocus).toEqual({ path: 'a.ts', seq: first.seq + 1 });
    s.focusTable('orders');
    expect(useStore.getState().tableFocus).toMatchObject({ key: 'orders' });
    s.traceRoute('POST /api/orders src/r.ts:3');
    expect(useStore.getState().routeTrace).toMatchObject({ id: 'POST /api/orders src/r.ts:3' });
    s.reset();
    const st = useStore.getState();
    expect([st.mapFocus, st.tableFocus, st.routeTrace, st.history]).toEqual([null, null, null, []]);
  });
});

describe('history and rewind', () => {
  const past = (files = [file('a.ts')]) => ({ ...hello(files), type: undefined, seq: 4, at: 1_700_000_000_000 });
  const status = { enabled: true, first: 1, last: 9, firstAt: 1, lastAt: 9 };

  afterEach(() => setHistorySource(restHistorySource));

  it('takes the history status from hello and from history messages', () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    expect(useStore.getState().historyStatus).toEqual(status);
    s.apply({ type: 'history', history: { ...status, enabled: false, error: 'disk full' } });
    expect(useStore.getState().historyStatus).toMatchObject({ enabled: false, error: 'disk full' });
  });

  it('rewind replaces data but keeps tab, selected and panel', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.setTab('map');
    s.select('c.ts');
    s.setPanel('inspector');
    const { type: _t, ...state } = past();
    s.rewind(state);
    const st = useStore.getState();
    expect(Object.keys(st.files)).toEqual(['a.ts']);
    expect(st.rewound).toEqual({ seq: 4, at: 1_700_000_000_000 });
    expect([st.tab, st.selected, st.panel]).toEqual(['map', 'c.ts', 'inspector']);
  });

  it('drops live data messages while rewound, but still applies history status', () => {
    const s = useStore.getState();
    s.apply(hello());
    const { type: _t, ...state } = past([file('a.ts')]);
    s.rewind(state);
    const before = useStore.getState();
    s.apply({ type: 'change', change: change('z.ts', 'created'), files: [file('z.ts')], removed: [] });
    s.apply({ type: 'files', files: [file('y.ts')], removed: [] });
    expect(useStore.getState().files).toBe(before.files);
    expect(useStore.getState().changes).toBe(before.changes);
    s.apply({ type: 'history', history: status });
    expect(useStore.getState().historyStatus).toEqual(status);
  });

  it('summaries: rewind takes file summaries from the past state but keeps the live summarizer status', () => {
    const s = useStore.getState();
    const ready = { state: 'ready' as const, provider: 'anthropic' as const, model: 'm', usedTokens: 5, capTokens: 100, month: '2026-10' };
    s.apply({ ...hello(), summaries: { status: ready, files: { 'a.ts': { hash: 'h2', summary: 'Now' } } } });
    const { type: _t, ...state } = past();
    s.rewind({ ...state, summaries: { status: { ...ready, state: 'off' }, files: { 'a.ts': { hash: 'h1', summary: 'Then' } } } });
    expect(useStore.getState().summaries).toEqual({ status: ready, files: { 'a.ts': { hash: 'h1', summary: 'Then' } } });
    // A past state recorded before summaries existed has none.
    s.rewind(state);
    expect(useStore.getState().summaries).toEqual({ status: ready, files: {} });
    // The status is the engine's, not history's: it still updates while rewound; file summaries do not.
    s.apply({ type: 'summaryStatus', status: { ...ready, state: 'working' } });
    s.apply({ type: 'fileSummary', path: 'a.ts', hash: 'h3', summary: 'Later' });
    expect(useStore.getState().summaries).toEqual({ status: { ...ready, state: 'working' }, files: {} });
  });

  it('backToLive keeps a summarizer status that arrived while it waited', async () => {
    const s = useStore.getState();
    const ready = { state: 'ready' as const, provider: 'anthropic' as const, model: 'm', usedTokens: 5, capTokens: 100, month: '2026-10' };
    s.apply({ ...hello(), summaries: { status: ready, files: {} } });
    const { type: _t, ...state } = past();
    s.rewind(state);
    let answer!: (v: unknown) => void;
    const live = vi.fn(() => new Promise(r => { answer = r; }));
    setHistorySource({ ...restHistorySource, live } as unknown as HistorySource);
    const done = s.backToLive();
    s.apply({ type: 'summaryStatus', status: { ...ready, state: 'cap', usedTokens: 100 } });
    // The live state was built before that status.
    answer({ ...hello(), type: undefined, seq: 12, summaries: { status: ready, files: { 'a.ts': { hash: 'h', summary: 'S' } } } });
    await done;
    expect(useStore.getState().summaries).toEqual({ status: { ...ready, state: 'cap', usedTokens: 100 }, files: { 'a.ts': { hash: 'h', summary: 'S' } } });

    // Without a status in between, the fetched one wins.
    s.rewind(state);
    setHistorySource({ ...restHistorySource, live: async () => ({ ...hello(), type: undefined, seq: 13, summaries: { status: { ...ready, usedTokens: 7 }, files: {} } }) } as unknown as HistorySource);
    await s.backToLive();
    expect(useStore.getState().summaries.status.usedTokens).toBe(7);
  });

  it('a fileSummary with an empty hash clears the entry', () => {
    const s = useStore.getState();
    s.apply({ ...hello(), summaries: { status: { state: 'off', usedTokens: 0, capTokens: 1, month: '' }, files: { 'a.ts': { hash: 'h', summary: 'S' }, 'b.ts': { hash: 'g', summary: 'T' } } } });
    s.apply({ type: 'fileSummary', path: 'a.ts', hash: '', summary: '' });
    expect(useStore.getState().summaries.files).toEqual({ 'b.ts': { hash: 'g', summary: 'T' } });
  });

  it('backToLive applies the live state like a hello, keeping tab, selection and panel', async () => {
    const s = useStore.getState();
    s.apply(hello());
    s.setTab('schema');
    s.select('b.ts');
    s.setPanel('files');
    const { type: _t, ...state } = past();
    s.rewind(state);
    const live = vi.fn(async () => ({ ...hello([file('a.ts'), file('b.ts'), file('new.ts')]), type: undefined, seq: 12, history: status }));
    setHistorySource({ ...restHistorySource, live } as unknown as HistorySource);
    await s.backToLive();
    const st = useStore.getState();
    expect(live).toHaveBeenCalledTimes(1);
    expect(st.rewound).toBeNull();
    expect(Object.keys(st.files).sort()).toEqual(['a.ts', 'b.ts', 'new.ts']);
    expect([st.tab, st.selected, st.panel]).toEqual(['schema', 'b.ts', 'files']);
    expect(st.historyStatus).toEqual(status);
    // Live again: messages apply.
    s.apply({ type: 'files', files: [file('y.ts')], removed: [] });
    expect(useStore.getState().files['y.ts']).toBeDefined();
  });

  it('backToLive replays live messages that arrive while it waits, once, by seq', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    const { type: _t, ...state } = past();
    s.rewind(state);
    let resolve!: (v: unknown) => void;
    const live = vi.fn(() => new Promise(r => { resolve = r; }));
    setHistorySource({ ...restHistorySource, live } as unknown as HistorySource);
    const done = s.backToLive();
    const included = change('a.ts', 'modified');
    const after = change('late.ts', 'created');
    // Broadcast before the server built the state (so it is in it), and after (so it is not).
    s.apply({ type: 'change', change: included, files: [file('a.ts')], removed: [], seq: 11 });
    s.apply({ type: 'change', change: after, files: [file('late.ts')], removed: [], seq: 13 });
    s.apply({ type: 'history', history: { ...status, last: 13 } });
    expect(useStore.getState().rewound).not.toBeNull();
    expect(useStore.getState().files['late.ts']).toBeUndefined();
    resolve({ ...hello([file('a.ts'), file('b.ts')]), changes: [included], type: undefined, seq: 12, history: status });
    await done;
    const st = useStore.getState();
    expect(st.rewound).toBeNull();
    expect(st.changes.map(c => c.id)).toEqual([included.id, after.id]);
    expect(st.files['late.ts']).toBeDefined();
    expect(st.historyStatus.last).toBe(13);
  });

  it('a reset hello buffered during backToLive is replayed only when its seq is newer than the live state', async () => {
    for (const [helloSeq, replayed] of [[13, true], [12, false]] as const) {
      useStore.getState().reset();
      const s = useStore.getState();
      s.apply({ ...hello(), history: status, seq: 9 });
      const { type: _t, ...state } = past();
      s.rewind(state);
      let resolve!: (v: unknown) => void;
      setHistorySource({ ...restHistorySource, live: () => new Promise(r => { resolve = r; }) } as unknown as HistorySource);
      const done = s.backToLive();
      s.apply({ ...hello([file('reset.ts')]), history: { ...status, last: helloSeq }, seq: helloSeq });
      resolve({ ...hello([file('live.ts')]), type: undefined, seq: 12, history: status });
      await done;
      expect(Object.keys(useStore.getState().files)).toEqual([replayed ? 'reset.ts' : 'live.ts']);
    }
  });

  it('a buffered message without a seq is dropped when the live state has one', async () => {
    const s = useStore.getState();
    s.apply(hello());
    const { type: _t, ...state } = past();
    s.rewind(state);
    let resolve!: (v: unknown) => void;
    setHistorySource({ ...restHistorySource, live: () => new Promise(r => { resolve = r; }) } as unknown as HistorySource);
    const done = s.backToLive();
    s.apply({ type: 'files', files: [file('noseq.ts')], removed: [] });
    resolve({ ...hello(), type: undefined, seq: 12, history: status });
    await done;
    expect(useStore.getState().files['noseq.ts']).toBeUndefined();
  });

  it('Back to live stops the play engine itself, so a played hello cannot cancel it', async () => {
    vi.useFakeTimers();
    try {
      const s = useStore.getState();
      s.apply({ ...hello(), history: status, seq: 9 });
      const { type: _t, ...state } = past();
      s.rewind(state);
      let resolve!: (v: unknown) => void;
      // The next record is a run-start hello, due 100 ms after the rewound point.
      const pages = [[{ seq: 5, at: state.at + 800, msg: hello([file('restart.ts')]) }]];
      const messages = vi.fn(() => (pages.length ? Promise.resolve(pages.shift()!) : new Promise(() => {})));
      const live = vi.fn(() => new Promise(r => { resolve = r; }));
      setHistorySource({ ...restHistorySource, messages, live } as unknown as HistorySource);
      await startPlayback(() => true, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(messages).toHaveBeenCalledTimes(1);
      // No Timeline is mounted: nothing but backToLive itself can stop the engine.
      const done = s.backToLive();
      await vi.advanceTimersByTimeAsync(500);
      resolve({ ...hello([file('live.ts')]), type: undefined, seq: 12, history: status });
      await done;
      const st = useStore.getState();
      expect(st.rewound).toBeNull();
      expect(Object.keys(st.files)).toEqual(['live.ts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a replay whose end cannot be loaded says so instead of rejecting', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    const { type: _t, ...state } = past();
    s.rewind(state);
    useStore.setState({ replay: true });
    setHistorySource({ ...restHistorySource, stateAt: () => Promise.reject(new Error('gone')) } as unknown as HistorySource);
    await expect(useStore.getState().backToLive()).resolves.toBeUndefined();
    expect(useStore.getState().toast).toMatchObject({ tone: 'error' });
    expect(useStore.getState().rewound?.seq).toBe(4);
  });

  it('in a replay, a seek made while the end loads wins over Back to live', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    const { type: _t, ...state } = past();
    s.rewind(state);
    useStore.setState({ replay: true });
    let resolveEnd!: (v: unknown) => void;
    setHistorySource({ ...restHistorySource, stateAt: () => new Promise(r => { resolveEnd = r; }) } as unknown as HistorySource);
    const back = useStore.getState().backToLive();
    // The user drags the timeline before the end arrives.
    useStore.getState().rewind({ ...state, seq: 6 });
    resolveEnd({ ...state, seq: 9 });
    await back;
    expect(useStore.getState().rewound?.seq).toBe(6);
  });

  it('Play that cannot load its first state shows an error toast', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    const info = vi.fn(async () => ({ ...status, runs: [{ id: 'r1', firstSeq: 1, lastSeq: 9, startAt: 1 }], bytes: 0 }));
    setHistorySource({ ...restHistorySource, info, stateAt: () => Promise.reject(new Error('gone')) } as unknown as HistorySource);
    expect(await startPlayback(() => true, () => {})).toBeNull();
    expect(useStore.getState().toast).toMatchObject({ tone: 'error', text: expect.stringMatching(/play/i) });
    expect(useStore.getState().playing).toBe(false);
  });

  it('Play that loses a page mid-way shows an error toast and stops', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: status, seq: 9 });
    const { type: _t, ...state } = past();
    s.rewind(state);
    const failed = vi.fn();
    setHistorySource({ ...restHistorySource, messages: () => Promise.reject(new Error('gone')) } as unknown as HistorySource);
    await startPlayback(() => true, failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(useStore.getState().toast).toMatchObject({ tone: 'error' });
  });

  it('Play from live starts at the current run, not the first recorded event', async () => {
    const s = useStore.getState();
    s.apply({ ...hello(), history: { ...status, first: 1, last: 90 }, seq: 90 });
    const runs = [{ id: 'r1', firstSeq: 1, lastSeq: 40, startAt: 1 }, { id: 'r2', firstSeq: 41, lastSeq: 90, startAt: 2 }];
    const stateAt = vi.fn(async (seq: number) => ({ ...past(), seq, at: 5 }));
    const info = vi.fn(async () => ({ ...status, runs, bytes: 0 }));
    const messages = vi.fn(() => new Promise(() => {}));
    setHistorySource({ ...restHistorySource, info, stateAt, messages } as unknown as HistorySource);
    const stop = await startPlayback(() => true, () => {});
    stop?.();
    expect(stateAt).toHaveBeenCalledWith(41);
    expect(useStore.getState().rewound?.seq).toBe(41);
  });

  it('a played hello (a run boundary) replaces the data and moves the rewound point', () => {
    const s = useStore.getState();
    s.apply(hello());
    const { type: _t, ...state } = past();
    s.rewind(state);
    s.applyHistorical({ seq: 5, at: 2, msg: hello([file('restart.ts')]) });
    const st = useStore.getState();
    expect(Object.keys(st.files)).toEqual(['restart.ts']);
    expect(st.rewound).toEqual({ seq: 5, at: 2 });
  });
});
