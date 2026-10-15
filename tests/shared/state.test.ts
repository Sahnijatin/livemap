import { describe, it, expect } from 'vitest';
import { applyMessage, emptyState, MAX_CHANGES, MAX_EVENTS } from '../../src/shared/state.js';
import type { ProjectState } from '../../src/shared/state.js';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary, FileModel } from '../../src/shared/types.js';
import type { DomainIndex } from '../../src/shared/domain.js';
import type { WireMessage } from '../../src/shared/protocol.js';

const file = (path: string, lines = 3): FileModel => ({
  path, lang: 'typescript', size: 10, lines, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
let nextId = 1;
const change = (path: string, kind: ChangeSummary['kind'] = 'modified'): ChangeSummary => ({
  id: nextId++, path, kind, at: 1, lang: 'typescript',
  symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
  entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 0, removed: 0 }, hunks: [], truncated: false,
});
let nextEv = 1;
const event = (): AgentEvent => ({ id: nextEv++, agent: 'claude-code', sessionId: 's1', at: 1, type: 'message', text: 'x' });
const session = (id = 's1', status: AgentSession['status'] = 'working'): AgentSession => ({ id, agent: 'claude-code', title: 't', cwd: '/p', startedAt: 1, lastAt: 2, status, hooks: true });
const domain = (): DomainIndex => ({ routes: [], tables: [], dataRefs: [], stack: [], deps: [], scripts: [], env: [], counts: { routes: 1, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 } });

const base = (): ProjectState => applyMessage(emptyState('/p', 'p'), {
  type: 'hello', root: '/p', name: 'p', files: [file('a.ts'), file('b.ts'), file('c.ts')], changes: [], usedBy: [],
  domain: domain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
});

describe('emptyState', () => {
  it('has the root, name and empty slices', () => {
    const s = emptyState('/r', 'n');
    expect(s).toMatchObject({ root: '/r', name: 'n', files: [], changes: [], usedBy: [], indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });
    expect(s.domain.routes).toEqual([]);
  });
});

describe('applyMessage', () => {
  it('hello replaces everything and applies the caps', () => {
    const s = base();
    const changes = Array.from({ length: MAX_CHANGES + 5 }, (_, i) => change(`f${i}.ts`));
    const events = Array.from({ length: MAX_EVENTS + 5 }, () => event());
    const next = applyMessage(s, { type: 'hello', root: '/q', name: 'q', files: [file('z.ts')], changes, usedBy: [{ file: 'z.ts', symbol: 'x', usedIn: [] }], domain: domain(), indexing: true, events, sessions: [session('s9')], control: { paused: true, flags: [] } });
    expect(next.root).toBe('/q');
    expect(next.files.map(f => f.path)).toEqual(['z.ts']);
    expect(next.changes).toHaveLength(MAX_CHANGES);
    expect(next.changes[0]).toBe(changes[5]);
    expect(next.events).toHaveLength(MAX_EVENTS);
    expect(next.events[0]).toBe(events[5]);
    expect(next.sessions.map(x => x.id)).toEqual(['s9']);
    expect(next.control.paused).toBe(true);
    expect(next.indexing).toBe(true);
  });

  it('hello tolerates missing agent fields and domain', () => {
    const msg = { type: 'hello', root: '/p', name: 'p', files: [], changes: [], usedBy: [], indexing: false } as unknown as Parameters<typeof applyMessage>[1];
    const next = applyMessage(base(), msg);
    expect(next.events).toEqual([]);
    expect(next.sessions).toEqual([]);
    expect(next.control).toEqual({ paused: false, flags: [] });
    expect(next.domain.routes).toEqual([]);
  });

  it('files upserts and removes, keeping untouched references', () => {
    const s = base();
    const c = s.files.find(f => f.path === 'c.ts');
    const f2 = file('b.ts', 99);
    const next = applyMessage(s, { type: 'files', files: [f2, file('d.ts')], removed: ['a.ts'] });
    expect(next.files.map(f => f.path)).toEqual(['b.ts', 'c.ts', 'd.ts']);
    expect(next.files.find(f => f.path === 'b.ts')).toBe(f2);
    expect(next.files.find(f => f.path === 'c.ts')).toBe(c);
    expect(next.changes).toBe(s.changes);
  });

  it('change appends, caps, and applies its files and removed', () => {
    let s = base();
    const f2 = file('b.ts', 7);
    const c1 = change('b.ts');
    s = applyMessage(s, { type: 'change', change: c1, files: [f2], removed: ['a.ts'] });
    expect(s.changes).toEqual([c1]);
    expect(s.files.map(f => f.path)).toEqual(['b.ts', 'c.ts']);
    for (let i = 0; i < MAX_CHANGES + 10; i++) s = applyMessage(s, { type: 'change', change: change('c.ts'), files: [], removed: [] });
    expect(s.changes).toHaveLength(MAX_CHANGES);
    expect(s.changes[0]).not.toBe(c1);
  });

  it('usedBy replaces', () => {
    const s = base();
    const u = [{ file: 'a.ts', symbol: 's', usedIn: ['b.ts'] }];
    expect(applyMessage(s, { type: 'usedBy', usedBy: u }).usedBy).toBe(u);
  });

  it('domain replaces', () => {
    const d = domain();
    expect(applyMessage(base(), { type: 'domain', domain: d }).domain).toBe(d);
  });

  it('agentEvent appends and caps at 2,000 (2,050 leave 2,000)', () => {
    let s = base();
    const all: AgentEvent[] = [];
    for (let i = 0; i < 2050; i++) { const e = event(); all.push(e); s = applyMessage(s, { type: 'agentEvent', event: e }); }
    expect(s.events).toHaveLength(2000);
    expect(s.events[0]).toBe(all[50]);
    expect(s.events[1999]).toBe(all[2049]);
  });

  it('session upserts by id', () => {
    let s = base();
    s = applyMessage(s, { type: 'session', session: session('s1') });
    s = applyMessage(s, { type: 'session', session: session('s2') });
    const idle = session('s1', 'idle');
    s = applyMessage(s, { type: 'session', session: idle });
    expect(s.sessions.map(x => x.id)).toEqual(['s1', 's2']);
    expect(s.sessions[0]).toBe(idle);
  });

  it('control replaces', () => {
    const control = { paused: true, flags: [] };
    expect(applyMessage(base(), { type: 'control', control }).control).toBe(control);
  });

  it('attribution patches the newest change with that id, or does nothing', () => {
    let s = base();
    const c1 = change('a.ts'); const c2 = change('b.ts');
    s = applyMessage(s, { type: 'change', change: c1, files: [], removed: [] });
    s = applyMessage(s, { type: 'change', change: c2, files: [], removed: [] });
    const attribution: Attribution = { agent: 'claude-code', sessionId: 's1', confidence: 'exact' };
    const next = applyMessage(s, { type: 'attribution', changeId: c1.id, attribution });
    expect(next.changes[0]).toEqual({ ...c1, attribution });
    expect(next.changes[1]).toBe(c2);
    expect(applyMessage(s, { type: 'attribution', changeId: 99999, attribution })).toBe(s);
  });

  it('indexing is a no-op', () => {
    const s = base();
    expect(applyMessage(s, { type: 'indexing', done: 1, total: 2 })).toBe(s);
  });

  it('returns the state unchanged for a message type this build does not know', () => {
    const s = base();
    const msg = { type: 'fromTheFuture', data: 1 } as unknown as Parameters<typeof applyMessage>[1];
    expect(applyMessage(s, msg)).toBe(s);
  });

  it('does not mutate its input and keeps unchanged slice references', () => {
    const s = base();
    const snap = JSON.stringify(s);
    const next = applyMessage(s, { type: 'agentEvent', event: event() });
    expect(JSON.stringify(s)).toBe(snap);
    expect(next.files).toBe(s.files);
    expect(next.changes).toBe(s.changes);
    expect(next.sessions).toBe(s.sessions);
    expect(next.domain).toBe(s.domain);
    expect(next.events).not.toBe(s.events);
  });
});

describe('applyMessage with a stamped (wire) message', () => {
  it('ignores the envelope seq: the state never carries it', () => {
    const s = base();
    const c = change('a.ts');
    const plain = applyMessage(s, { type: 'change', change: c, files: [file('a.ts', 9)], removed: [] });
    const stamped = applyMessage(s, { type: 'change', change: c, files: [file('a.ts', 9)], removed: [], seq: 42 } as WireMessage);
    expect(stamped).toEqual(plain);
    expect(stamped).not.toHaveProperty('seq');
    const hello = applyMessage(s, { type: 'hello', root: '/p', name: 'p', files: [], changes: [], usedBy: [], domain: domain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] }, seq: 42 });
    expect(hello).not.toHaveProperty('seq');
  });
});
