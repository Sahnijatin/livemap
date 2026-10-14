import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DomainIndex } from '@shared/domain.js';
import { useStore, MAX_CHANGES, MAX_EVENTS, loadTab, depKey, tableKey, fieldKey, routeBaseKey } from './store';
import { file, change, event, session, emptyDomain } from './fixtures';

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

  it('change records recent kind, auto-expands the file and keeps the last 2,000 changes', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', change: change('a.ts', 'created') });
    let st = useStore.getState();
    expect(st.recent['a.ts'].kind).toBe('created');
    expect(st.expanded['a.ts']).toBe(true);
    s.apply({ type: 'change', change: change('a.ts', 'modified') });
    expect(useStore.getState().recent['a.ts'].kind).toBe('modified');

    s.apply(hello());
    for (let i = 0; i < 2001; i++) s.apply({ type: 'change', change: change(`f${i}.ts`) });
    st = useStore.getState();
    expect(MAX_CHANGES).toBe(2000);
    expect(st.changes).toHaveLength(2000);
    expect(st.changes[0].path).toBe('f1.ts');
    expect(st.changes[1999].path).toBe('f2000.ts');
  });

  it('a deleted change removes recent[path]; a removed selected path resets selected on the next files message', () => {
    const s = useStore.getState();
    s.apply(hello());
    s.apply({ type: 'change', change: change('a.ts', 'modified') });
    s.select('a.ts');
    s.apply({ type: 'change', change: change('a.ts', 'deleted') });
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
    s.apply({ type: 'change', change: a });
    s.apply({ type: 'change', change: b });
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

  it('survives a localStorage that throws', () => {
    const boom = () => { throw new Error('denied'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(loadTab()).toBe('activity');
    useStore.getState().setTab('schema');
    expect(useStore.getState().tab).toBe('schema');
  });
});
