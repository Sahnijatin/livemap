import { describe, it, expect, afterEach } from 'vitest';
import { AgentHub } from '../../src/agents/hub.js';
import { Attributor, DEFAULT_SKEW_MS, type AttributorOptions, type RecordKey } from '../../src/agents/attribution.js';
import { captureEvents } from '../../src/agents/capture.js';
import { buildCapture, SessionContext } from '../../src/proxy/capture.js';
import type { Attribution, ChangeSummary } from '../../src/shared/types.js';
import { loadFixture } from '../helpers/mock-nexus.js';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SYS = (n: number) => n.toString(16).padStart(32, 'a');
const US1 = 'e'.repeat(32);
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

/**
 * A hub and Attributor where changed paths are `rec/<table>/<sys_id>` and the record facts come from `facts`.
 * Calls go in the way production sends them: through the proxy's capture builder, then the server's /hook
 * conversion.
 */
function setup(opts: AttributorOptions = {}) {
  const hub = new AgentHub('/p/.livemap/sn');
  const facts = new Map<string, RecordKey>();
  const attr = new Attributor(hub, { recordOf: (p) => facts.get(p), ...opts });
  cleanup.push(() => { attr.stop(); hub.stop(); });
  const ctxs = new Map<string, SessionContext>();
  let n = 0;
  const call = (session: string, name: string, args: unknown, start: number, end: number, result: unknown = text({ success: true })) => {
    const ctx = ctxs.get(session) ?? new SessionContext('devtest');
    ctxs.set(session, ctx);
    const body = buildCapture({ sessionId: session, callId: `c${++n}`, name, args, result, start, end }, ctx);
    hub.ingestRaw(captureEvents(JSON.parse(JSON.stringify(body)) as Record<string, unknown>, end), { agent: 'mcp-client', cwd: '', hooks: true });
  };
  const user = (session: string, name: string, at: number) => call(session, 'sn_session_context', {}, at, at, text({ success: true, data: { user_name: name } }));
  const updateSet = (session: string, sysId: string, name: string, at: number) =>
    call(session, 'sn_update_set_manage', { action: 'create', name }, at, at + 200, text({ success: true, data: { sys_id: sysId } }));
  const bg = (session: string, start: number, end: number) => call(session, 'tool_execute', { tool: 'sn_execute_background_script', args: { script: 'var gr = new GlideRecord("x");' } }, start, end);
  const update = (session: string, table: string, sysId: string, at: number) => call(session, 'sn_record_manage', { action: 'update', table, sys_id: sysId, data: { active: true } }, at, at + 300);
  const read = (session: string, at: number) => call(session, 'sn_query_table', { table: 'sys_script', query: 'active=true' }, at, at + 100);
  let id = 0;
  const change = (key: RecordKey, detectedAt = (key.updatedOn ?? T0) + 4000): ChangeSummary => {
    const path = `rec/${key.table}/${key.sysId}`;
    facts.set(path, key);
    return { id: ++id, path, kind: 'modified', at: detectedAt } as ChangeSummary;
  };
  return { hub, attr, call, user, updateSet, bg, update, read, change };
}

describe('rule 1: record key (exact)', () => {
  it('a call naming the record is exact, within the window', () => {
    const s = setup();
    s.update('A', 'sys_script', SYS(1), T0 - 2000);
    expect(s.attr.attribute(s.change({ instance: 'devtest', table: 'sys_script', sysId: SYS(1), updatedOn: T0 }))).toMatchObject({ sessionId: 'A', confidence: 'exact', rule: 'record' });
  });

  it('the skew margin widens the window, and setSkewMs changes it', () => {
    const s = setup();
    s.update('A', 'sys_script', SYS(1), T0 - 13_000);
    const key = { table: 'sys_script', sysId: SYS(1), updatedOn: T0 };
    expect(s.attr.skew).toBe(DEFAULT_SKEW_MS);
    expect(s.attr.attribute(s.change(key))?.confidence).toBe('exact');
    s.attr.setSkewMs(0);
    expect(s.attr.attribute(s.change(key))?.rule).not.toBe('record');
    s.attr.setSkewMs(-3000);
    expect(s.attr.skew).toBe(3000);
    s.attr.setSkewMs(Number.NaN);
    expect(s.attr.skew).toBe(3000);
  });

  it('a create is exact through the sys_id in its result', () => {
    const s = setup();
    s.call('A', 'sn_record_manage', { action: 'create', table: 'sp_widget', data: { name: 'Offer card' } }, T0 - 1500, T0 - 1000, text({ success: true, data: { sys_id: SYS(9) } }));
    expect(s.attr.attribute(s.change({ table: 'sp_widget', sysId: SYS(9), updatedOn: T0 }))).toMatchObject({ sessionId: 'A', confidence: 'exact' });
  });
});

describe('rule 2: update set', () => {
  it('the session that made the update set current owns its changes inside its span', () => {
    const s = setup();
    s.updateSet('A', US1, 'Card offers v2', T0 - 120_000);
    s.updateSet('B', SYS(2), 'Something else', T0 - 100_000);
    s.read('A', T0 - 30_000);
    expect(s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(3), updatedOn: T0, updateSet: US1 }))).toMatchObject({ sessionId: 'A', confidence: 'likely', rule: 'update_set' });
  });

  it('matches by name when the session only named the update set', () => {
    const s = setup();
    s.call('A', 'sn_update_set_manage', { action: 'set_current', name: 'Card offers v2' }, T0 - 10_000, T0 - 9000);
    expect(s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(3), updatedOn: T0, updateSet: US1, updateSetName: 'Card offers v2' }))?.rule).toBe('update_set');
  });

  it('two sessions on the same update set are ambiguous', () => {
    const s = setup();
    s.updateSet('A', US1, 'Card offers v2', T0 - 20_000);
    s.updateSet('B', US1, 'Card offers v2', T0 - 10_000);
    const a = s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(3), updatedOn: T0, updateSet: US1 }));
    expect(a).toMatchObject({ confidence: 'ambiguous', rule: 'update_set' });
    expect(a?.candidates?.map((c) => c.sessionId).sort()).toEqual(['A', 'B']);
  });

  it('outside the session span it does not match', () => {
    const s = setup();
    s.updateSet('A', US1, 'Card offers v2', T0 - 600_000);
    expect(s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(3), updatedOn: T0, updateSet: US1 }))).toBeUndefined();
  });

  it('beats the run window rule when both fit', () => {
    const s = setup();
    s.updateSet('A', US1, 'Card offers v2', T0 - 20_000);
    s.bg('B', T0 - 1000, T0 + 1000);
    expect(s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(3), updatedOn: T0, updateSet: US1 }))).toMatchObject({ sessionId: 'A', rule: 'update_set' });
  });
});

describe('rule 3: run window', () => {
  it('a change by the session user while its background script ran is likely', () => {
    const s = setup();
    s.user('A', 'agent.a', T0 - 60_000);
    s.bg('A', T0 - 2000, T0 + 1000);
    const a = s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(4), updatedOn: T0, updatedBy: 'agent.a' }));
    expect(a).toMatchObject({ sessionId: 'A', confidence: 'likely', rule: 'run_window' });
    expect(a?.reason).toContain('by agent.a');
  });

  it('the 3 s tail and the skew margin extend the window; past them it does not match', () => {
    const s = setup({ skewMs: 1000 });
    s.bg('A', T0 - 5000, T0 - 4000);
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(5), updatedOn: T0 }))?.rule).toBe('run_window');
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(6), updatedOn: T0 + 1500 }))?.rule).not.toBe('run_window');
  });

  it('two overlapping sessions are ambiguous with both candidates', () => {
    const s = setup();
    s.bg('A', T0 - 3000, T0 + 1000);
    s.bg('B', T0 - 1000, T0 + 2000);
    const a = s.attr.attribute(s.change({ table: 'x', sysId: SYS(5), updatedOn: T0, updatedBy: 'admin' }));
    expect(a).toMatchObject({ confidence: 'ambiguous', rule: 'run_window' });
    expect(a?.candidates?.map((c) => c.sessionId).sort()).toEqual(['A', 'B']);
  });

  it('a session acting as another user is left out', () => {
    const s = setup();
    s.user('A', 'agent.a', T0 - 60_000);
    s.user('B', 'agent.b', T0 - 60_000);
    s.bg('A', T0 - 3000, T0 + 1000);
    s.bg('B', T0 - 1000, T0 + 2000);
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(5), updatedOn: T0, updatedBy: 'agent.b' }))).toMatchObject({ sessionId: 'B', confidence: 'likely', rule: 'run_window' });
  });

  it('a user learned from an exact match narrows later run windows', () => {
    const s = setup();
    s.update('A', 'sys_script', SYS(1), T0 - 60_000);
    expect(s.attr.attribute(s.change({ table: 'sys_script', sysId: SYS(1), updatedOn: T0 - 59_000, updatedBy: 'svc.a' }))?.confidence).toBe('exact');
    s.bg('A', T0 - 1000, T0 + 1000);
    s.bg('B', T0 - 1000, T0 + 1000);
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(7), updatedOn: T0, updatedBy: 'admin' }))).toMatchObject({ sessionId: 'B', confidence: 'likely' });
  });

  it('a script still running counts', () => {
    const s = setup();
    s.hub.ingestRaw(captureEvents({ source: 'mcp-proxy', sessionId: 'A', callId: 'r', tool: 'sn_execute_background_script', args: {}, start: T0 - 1000, end: T0 - 1000, ok: true }, T0).slice(0, 1), { agent: 'mcp-client', cwd: '', hooks: true });
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(8), updatedOn: T0 + 30_000 }))?.rule).toBe('run_window');
  });
});

describe('rule 4: log hook', () => {
  it('is asked only after rules 1 to 3, before time only; a throwing matcher counts as no match', () => {
    const asked: string[] = [];
    const log: Attribution = { agent: 'mcp-client', sessionId: 'log', confidence: 'log', rule: 'log' };
    const s = setup({ logMatch: (c) => { asked.push(c.path); return c.path.includes(SYS(10)) ? log : undefined; } });
    s.update('A', 'x', SYS(11), T0 - 2000);
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(10), updatedOn: T0 }))).toMatchObject({ confidence: 'log', sessionId: 'log' });
    expect(s.attr.attribute(s.change({ table: 'x', sysId: SYS(11), updatedOn: T0 }))?.confidence).toBe('exact');
    expect(asked).toEqual([`rec/x/${SYS(10)}`]);
    const t = setup({ logMatch: () => { throw new Error('bad log'); } });
    t.update('A', 'x', SYS(12), T0 - 2000);
    expect(t.attr.attribute(t.change({ table: 'x', sysId: SYS(13), updatedOn: T0 }))).toMatchObject({ confidence: 'likely', rule: 'time' });
  });
});

describe('rule 5: time only', () => {
  it('one write call in the window is likely, never exact', () => {
    const s = setup();
    s.update('A', 'sys_script', SYS(20), T0 - 5000);
    expect(s.attr.attribute(s.change({ table: 'sp_widget', sysId: SYS(21), updatedOn: T0 }))).toMatchObject({ sessionId: 'A', confidence: 'likely', rule: 'time' });
  });

  it('more than one is ambiguous and keeps all candidates', () => {
    const s = setup();
    s.update('A', 'sys_script', SYS(20), T0 - 5000);
    s.update('B', 'sys_script', SYS(22), T0 - 3000);
    const a = s.attr.attribute(s.change({ table: 'sp_widget', sysId: SYS(21), updatedOn: T0 }));
    expect(a).toMatchObject({ confidence: 'ambiguous', rule: 'time' });
    expect(a?.candidates?.map((c) => c.sessionId).sort()).toEqual(['A', 'B']);
  });

  it('reads and calls on another instance do not count', () => {
    const s = setup();
    s.read('A', T0 - 2000);
    expect(s.attr.attribute(s.change({ instance: 'devtest', table: 'sp_widget', sysId: SYS(21), updatedOn: T0 }))).toBeUndefined();
    s.update('B', 'sys_script', SYS(20), T0 - 2000);
    expect(s.attr.attribute(s.change({ instance: 'prod', table: 'sp_widget', sysId: SYS(23), updatedOn: T0 }))).toBeUndefined();
  });
});

describe('rule 6: human', () => {
  it('nothing matched: no attribution', () => {
    const s = setup();
    expect(s.attr.attribute(s.change({ table: 'sp_widget', sysId: SYS(30), updatedOn: T0, updatedBy: 'jane.doe' }))).toBeUndefined();
  });
});

describe('late upgrades', () => {
  it('a capture arriving after the change upgrades it, and only upward', () => {
    const s = setup();
    const got: Attribution[] = [];
    s.attr.on('late', (_id: number, a: Attribution) => got.push(a));
    const c = s.change({ table: 'sys_script', sysId: SYS(40), updatedOn: T0 });
    expect(s.attr.attribute(c)).toBeUndefined();
    s.bg('A', T0 - 1000, T0 + 500);
    expect(got.map((a) => a.rule)).toEqual(['run_window']);
    s.read('B', T0);
    s.bg('C', T0 - 5000, T0 + 6000);
    expect(got).toHaveLength(1);
    s.update('D', 'sys_script', SYS(40), T0 - 500);
    expect(got.map((a) => [a.confidence, a.sessionId])).toEqual([['likely', 'A'], ['exact', 'D']]);
    s.update('E', 'sys_script', SYS(40), T0);
    expect(got).toHaveLength(2);
  });
});

/** The fixture's change rows as a poller would hand them over: table and sys_id from the payload, references flattened. */
function fixtureChanges() {
  const fx = loadFixture();
  const flat = (v: string) => { try { const o = JSON.parse(v) as unknown; return typeof o === 'string' ? o : (o as { value?: string })?.value ?? ''; } catch { return v; } };
  return fx.sys_update_xml.map((r) => ({
    table: /<record_update table="(\w+)"/.exec(r.payload)![1],
    sysId: /<sys_id>([0-9a-f]{32})<\/sys_id>/.exec(r.payload)![1],
    updatedOn: Date.parse(`${r.sys_updated_on.replace(' ', 'T')}Z`),
    updatedBy: r.sys_created_by,
    updateSet: flat(r.update_set) || undefined,
  }));
}

describe('fixture replay: sys_update_xml rows against synthetic calls', () => {
  const rows = fixtureChanges();
  // The recording holds two bursts: an install on 3 Jul with no update set, and a rebuild on 16 Jul in one update set.
  const plain = rows.filter((r) => !r.updateSet);
  const inSet = rows.filter((r) => r.updateSet);
  const span = (rs: typeof rows) => ({ start: Math.min(...rs.map((r) => r.updatedOn)), end: Math.max(...rs.map((r) => r.updatedOn)) });
  const tally = (s: ReturnType<typeof setup>, rs: typeof rows) => {
    const out: Record<string, number> = {};
    for (const r of rs) {
      const a = s.attr.attribute(s.change(r, r.updatedOn + 4000));
      const label = a ? `${a.confidence}:${a.rule}:${a.sessionId}` : 'human';
      out[label] = (out[label] ?? 0) + 1;
    }
    return out;
  };

  it('has the rows and bursts the scenarios assume', () => {
    expect(rows).toHaveLength(183);
    expect(plain.length).toBe(104);
    expect(inSet.length).toBe(79);
    expect(new Set(inSet.map((r) => r.updateSet)).size).toBe(1);
    expect(span(plain).end - span(plain).start).toBeLessThan(60_000);
    expect(span(inSet).end - span(inSet).start).toBeLessThan(60_000);
  });

  it('install burst: widgets pushed by name are exact; the rest, changed while one script ran, are run window', () => {
    const s = setup();
    const { start, end } = span(plain);
    const widgets = plain.filter((r) => r.table === 'sp_widget');
    for (const w of widgets) s.call('A', 'tool_execute', { tool: 'sn_push_artifact', args: { table: 'sp_widget', sys_id: w.sysId } }, w.updatedOn - 1500, w.updatedOn - 500);
    s.user('A', 'admin', start - 60_000);
    s.bg('A', start - 1000, end + 500);
    expect(tally(s, plain)).toEqual({ 'exact:record:A': widgets.length, 'likely:run_window:A': plain.length - widgets.length });
  });

  it('install burst with two overlapping script sessions: every unnamed change is ambiguous', () => {
    const s = setup();
    const { start, end } = span(plain);
    s.bg('A', start - 1000, end + 500);
    s.bg('B', start - 500, end + 1000);
    const t = tally(s, plain);
    expect(Object.keys(t)).toHaveLength(1);
    expect(Object.keys(t)[0]).toMatch(/^ambiguous:run_window:[AB]$/);
    expect(Object.values(t)[0]).toBe(plain.length);
  });

  it('install burst while another user ran the script: not that session; the time rule sees no write call', () => {
    const s = setup();
    const { start, end } = span(plain);
    s.user('A', 'agent.other', start - 60_000);
    s.bg('A', start - 1000, end + 500);
    expect(tally(s, plain)).toEqual({ human: plain.length });
  });

  it('update set burst: the session that made the set current owns its rows; rows it named are exact', () => {
    const s = setup();
    const { start } = span(inSet);
    s.updateSet('U', inSet[0].updateSet as string, 'Credit card offering rebuild', start - 120_000);
    s.read('U', start - 5000);
    const named = inSet.filter((r) => r.table === 'sys_script');
    for (const r of named) s.update('U', 'sys_script', r.sysId, r.updatedOn - 1000);
    // A teammate session on another update set, active at the same time, must not take these rows.
    s.updateSet('T', 'f'.repeat(32), 'Teammate work', start - 60_000);
    s.read('T', start);
    expect(tally(s, inSet)).toEqual({ 'exact:record:U': named.length, 'likely:update_set:U': inSet.length - named.length });
  });

  it('no agent activity: every row is human', () => {
    const s = setup();
    expect(tally(s, rows)).toEqual({ human: rows.length });
  });
});
