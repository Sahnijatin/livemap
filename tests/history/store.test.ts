import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HistoryStore, RECORDED_TYPES } from '../../src/history/store.js';
import { projectDir } from '../../src/history/paths.js';
import { applyMessage, emptyState } from '../../src/shared/state.js';
import type { ProjectState } from '../../src/shared/state.js';
import type { ServerMessage } from '../../src/shared/protocol.js';
import type { AgentEvent, AgentEventType, ChangeSummary, FileModel } from '../../src/shared/types.js';
import { expectMode } from '../helpers/platform.js';

let home: string;
let root: string;

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hist-home-')));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hist-root-')));
});
// A test may leave a nested dir read-only (write failure); non-root rm needs every dir writable again.
function makeWritable(d: string): void {
  try {
    fs.chmodSync(d, 0o700);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) makeWritable(path.join(d, e.name));
  } catch { /* gone or not a dir */ }
}
afterEach(() => {
  for (const d of [home, root]) {
    makeWritable(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const file = (p: string, lines = 3): FileModel => ({
  path: p, lang: 'typescript', size: 10, lines, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
});
const change = (id: number, p: string): ChangeSummary => ({
  id, path: p, kind: 'modified', at: id, lang: 'typescript',
  symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
  entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
  env: { added: [], removed: [] }, lines: { added: 1, removed: 0 }, hunks: [], truncated: false,
});
const agentEvent = (id: number, type: AgentEventType, text = 'x'): AgentEvent => ({ id, agent: 'claude-code', sessionId: 's1', at: id, type, text });

function startState(name = 'p', files = ['a.ts', 'b.ts']): ProjectState {
  const s = emptyState(root, name);
  return { ...s, files: files.map(f => file(f)) };
}

const EVENT_TYPES: AgentEventType[] = ['prompt', 'message', 'thinking', 'tool_start', 'tool_end', 'commit', 'status'];

/** A deterministic mix of recorded message types. */
function msgAt(i: number, pad = ''): ServerMessage {
  switch (i % 8) {
    case 0: return { type: 'change', change: change(i, `f${i % 13}.ts`), files: [file(`f${i % 13}.ts`, i)], removed: i % 5 === 0 ? ['a.ts'] : [] };
    case 1: return { type: 'files', files: [file(`g${i % 7}.ts`, i)], removed: [] };
    case 2: return { type: 'session', session: { id: `s${i % 3}`, agent: 'claude-code', title: `t${i}`, cwd: root, startedAt: 1, lastAt: i, status: 'working', hooks: true } };
    case 3: return { type: 'control', control: { paused: i % 2 === 0, flags: [] } };
    case 4: return { type: 'attribution', changeId: i - 4, attribution: { agent: 'claude-code', sessionId: 's1', confidence: 'likely' } };
    case 5: return { type: 'usedBy', usedBy: [{ file: 'a.ts', symbol: `s${i}`, usedIn: [] }] };
    default: return { type: 'agentEvent', event: agentEvent(i, EVENT_TYPES[i % EVENT_TYPES.length], `e${i}${pad}`) };
  }
}

/** A fake clock that keeps running across opens, so each run gets its own id. */
let clock = Date.UTC(2026, 9, 15);
const open = (opts: Parameters<typeof HistoryStore.open>[1] = {}) =>
  HistoryStore.open(root, { home, now: () => (clock += 10), ...opts });

describe('projectDir', () => {
  it('is <home>/projects/<sha1(realpath root)>', () => {
    const sha = crypto.createHash('sha1').update(fs.realpathSync.native(root)).digest('hex');
    expect(projectDir(root, home)).toBe(path.join(home, 'projects', sha));
  });
});

describe('RECORDED_TYPES', () => {
  it('records data messages and never hello or indexing', async () => {
    expect([...RECORDED_TYPES].sort()).toEqual(['agentEvent', 'agentEvents', 'attribution', 'change', 'control', 'domain', 'fileSummary', 'files', 'session', 'summary', 'usedBy']);
    const store = await open();
    await store.startRun(startState());
    expect(store.append({ type: 'indexing', done: 1, total: 2 })).toBe(-1);
    expect(store.append({ type: 'hello', ...startState() })).toBe(-1);
    expect(store.append(msgAt(7))).toBe(2);
    await store.flush();
    expect(store.messages(1, 100).map(r => r.msg.type)).toEqual(['hello', 'agentEvent']);
    await store.close();
  });

  it('old single agentEvent records replay to the same state as agentEvents batches (Review Focus 2)', async () => {
    const events = Array.from({ length: 30 }, (_, i) => agentEvent(i + 1, EVENT_TYPES[i % EVENT_TYPES.length], `e${i}`));
    const old = await open();
    await old.startRun(startState());
    for (const e of events) old.append({ type: 'agentEvent', event: e });
    await old.flush();
    const { seq: _s1, at: _a1, ...fromOld } = await old.stateAt(old.info().last);
    await old.close();
    fs.rmSync(projectDir(root, home), { recursive: true, force: true });
    const batched = await open();
    await batched.startRun(startState());
    for (let i = 0; i < events.length; i += 10) batched.append({ type: 'agentEvents', events: events.slice(i, i + 10) });
    await batched.flush();
    expect(batched.messages(1, 100).map(r => r.msg.type)).toEqual(['hello', 'agentEvents', 'agentEvents', 'agentEvents']);
    const { seq: _s2, at: _a2, ...fromBatches } = await batched.stateAt(batched.info().last);
    await batched.close();
    expect(fromOld.events).toEqual(events);
    expect(fromBatches).toEqual(fromOld);
  });

  it('append before startRun records nothing and returns -1', async () => {
    const store = await open();
    expect(() => store.append(msgAt(7))).not.toThrow();
    expect(store.append(msgAt(7))).toBe(-1);
    await store.flush();
    expect(store.info()).toMatchObject({ enabled: true, first: 0, last: 0, runs: [] });
    await store.startRun(startState());
    expect(store.append(msgAt(7))).toBe(2);
    await store.close();
  });

  it('records appends made right after startRun, before it resolves', async () => {
    const store = await open();
    const started = store.startRun(startState());
    expect(store.append(msgAt(7))).toBe(2);
    await started;
    await store.flush();
    expect(store.messages(1, 10).map(r => r.msg.type)).toEqual(['hello', 'agentEvent']);
    await store.close();
  });

  it('writes the pre-serialized text given to append', async () => {
    const store = await open();
    await store.startRun(startState());
    const msg = msgAt(5);
    expect(store.append(msg, 123, JSON.stringify(msg))).toBe(2);
    await store.flush();
    expect(store.messages(2, 2)).toEqual([expect.objectContaining({ seq: 2, at: 123, msg })]);
    await store.close();
  });
});

describe('HistoryStore basics', () => {
  it('appends, flushes and reads back in order, with records in the documented shape', async () => {
    const store = await open();
    await store.startRun(startState());
    const msgs = Array.from({ length: 20 }, (_, i) => msgAt(i));
    const seqs = msgs.map((m, i) => store.append(m, 5000 + i));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    // Unflushed records are readable too.
    expect(store.messages(2, 21).map(r => r.msg)).toEqual(msgs);
    await store.flush();
    const read = store.messages(1, 100);
    expect(read[0].seq).toBe(1);
    expect(read[0].msg).toEqual({ type: 'hello', ...startState() });
    expect(read.slice(1).map(r => r.msg)).toEqual(msgs);
    expect(read.slice(1).map(r => r.at)).toEqual(msgs.map((_, i) => 5000 + i));
    expect(store.messages(5, 7).map(r => r.seq)).toEqual([5, 6, 7]);
    expect(store.messages(2, 100, 3).map(r => r.seq)).toEqual([2, 3, 4]);

    const info = store.info();
    expect(info).toMatchObject({ enabled: true, first: 1, last: 21, firstAt: info.runs[0].startAt, lastAt: 5019 });
    expect(info.runs).toHaveLength(1);
    const runId = info.runs[0].id;
    expect(runId).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z/);
    const lines = fs.readFileSync(path.join(projectDir(root, home), `events-${runId}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(21);
    expect(Object.keys(JSON.parse(lines[1]))).toEqual(['seq', 'at', 'run', 'msg']);
    expect(JSON.parse(lines[1])).toEqual({ seq: 2, at: 5000, run: runId, msg: msgs[0] });
    await store.close();

    const again = await open();
    expect(again.info().last).toBe(21);
    expect(again.messages(1, 100).slice(1).map(r => r.msg)).toEqual(msgs);
    await again.close();
  });

  it('stateAt equals applyMessage replayed from the start, and carries seq and at', async () => {
    const store = await open();
    const s0 = startState();
    await store.startRun(s0);
    const expected = new Map<number, ProjectState>();
    let state = applyMessage(emptyState('', ''), { type: 'hello', ...s0 });
    expected.set(1, state);
    for (let i = 0; i < 1200; i++) {
      const m = msgAt(i);
      const seq = store.append(m, 10_000 + i);
      state = applyMessage(state, m);
      expected.set(seq, state);
    }
    await store.flush();
    const last = store.info().last;
    expect(last).toBe(1201);
    for (const seq of [1, 2, 499, 500, 501, 999, 1000, 1001, last]) {
      const got = await store.stateAt(seq);
      const { seq: gotSeq, at, ...rest } = got;
      expect(gotSeq).toBe(seq);
      expect(at).toBe(store.messages(seq, seq)[0].at);
      expect(rest).toEqual(expected.get(seq));
    }
    await expect(store.stateAt(last + 1)).rejects.toThrow();
    await store.close();
  });

  it('writes snapshots every 500 events with 0700 dirs and 0600 files', async () => {
    const store = await open();
    await store.startRun(startState());
    for (let i = 0; i < 1100; i++) store.append(msgAt(i));
    await store.close();
    const dir = projectDir(root, home);
    const snaps = fs.readdirSync(path.join(dir, 'snapshots')).sort((a, b) => parseInt(a) - parseInt(b));
    expect(snaps).toEqual(['1.json.gz', '500.json.gz', '1000.json.gz']);
    expectMode(dir, 0o700);
    expectMode(path.join(dir, 'snapshots'), 0o700);
    for (const f of fs.readdirSync(dir).filter(f => f !== 'snapshots')) expectMode(path.join(dir, f), 0o600);
    for (const f of snaps) expectMode(path.join(dir, 'snapshots', f), 0o600);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
  });

  it('snapshots a 5,000-file state', async () => {
    const store = await open({ snapshotEvery: 2 });
    await store.startRun(startState());
    const sync: number[] = [];
    // The same paths each round, so the state stays at 5,000 files.
    const files = Array.from({ length: 5000 }, (_, i) => file(`src/f${i}.ts`));
    for (let run = 0; run < 6; run++) {
      const msg: ServerMessage = { type: 'files', files, removed: [] };
      const text = JSON.stringify(msg);
      // The big record is over the flush threshold, so appending it flushes (and snapshots) at once.
      const t0 = performance.now();
      store.append(msg, 1, text);
      sync.push(performance.now() - t0);
      await store.flush();
      store.append({ type: 'control', control: { paused: false, flags: [] } });
    }
    await store.close();
    sync.shift(); // warm-up
    sync.sort((a, b) => a - b);
    const median = sync[Math.floor(sync.length / 2)];
    expect(median).toBeLessThan(50);
    expect(fs.readdirSync(path.join(projectDir(root, home), 'snapshots'))).toContain('2.json.gz');
  });

  it('reopens from index.json, and rebuilds when it is missing or garbage', async () => {
    const store = await open();
    await store.startRun(startState());
    for (let i = 0; i < 50; i++) store.append(msgAt(i), 100 + i);
    await store.close();
    const want = (await open()).info();
    const idx = path.join(projectDir(root, home), 'index.json');
    fs.rmSync(idx);
    const a = await open();
    expect(a.info()).toEqual(want);
    expect(a.messages(1, 100)).toHaveLength(51);
    await a.close();
    fs.writeFileSync(idx, '{garbage');
    const b = await open();
    expect(b.info()).toEqual(want);
    expect((await b.stateAt(30)).seq).toBe(30);
    await b.close();
  });
});

describe('leftover temp files', () => {
  it('open sweeps trim and index temp files a crash left behind, but read-only open leaves them', async () => {
    const store = await open();
    await store.startRun(startState());
    for (let i = 0; i < 5; i++) store.append(msgAt(i));
    await store.close();
    const dir = projectDir(root, home);
    const events = fs.readdirSync(dir).find(f => /^events-.*\.jsonl$/.test(f))!;
    const leftovers = [`${events}.trim.tmp`, 'index.json.12345.deadbeef.tmp'];
    for (const n of leftovers) fs.writeFileSync(path.join(dir, n), 'partial');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');

    const ro = await open({ readOnly: true });
    expect(ro.info().last).toBe(6);
    for (const n of leftovers) expect(fs.existsSync(path.join(dir, n)), n).toBe(true);
    await ro.close();

    const again = await open();
    expect(again.info().last).toBe(6);
    for (const n of leftovers) expect(fs.existsSync(path.join(dir, n)), n).toBe(false);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, events))).toBe(true);
    await again.close();
  });
});

describe('Review Focus 1: repair and corrupt snapshots', () => {
  it('drops a half-written tail line on open and reuses its seq', async () => {
    const store = await open();
    await store.startRun(startState());
    for (let i = 0; i < 9; i++) store.append(msgAt(i));
    await store.close();
    expect(store.info().last).toBe(10);
    const dir = projectDir(root, home);
    const events = fs.readdirSync(dir).find(f => f.startsWith('events-'))!;
    const before = fs.readFileSync(path.join(dir, events), 'utf8');
    fs.appendFileSync(path.join(dir, events), '{"seq":11,"at":5,"run":"x","msg":{"type":"agentEv');

    const again = await open();
    expect(again.info().last).toBe(10);
    expect(fs.readFileSync(path.join(dir, events), 'utf8')).toBe(before);
    // The next record written gets seq 11: the run-start record, then appends continue from 12.
    await again.startRun(startState('q'));
    expect(again.info().last).toBe(11);
    expect(again.append(msgAt(7))).toBe(12);
    await again.flush();
    expect(again.messages(11, 11)[0].msg.type).toBe('hello');
    await again.close();
  });

  it('falls back to an older snapshot plus replay when the latest snapshot is garbage', async () => {
    const store = await open();
    const s0 = startState();
    await store.startRun(s0);
    let state = applyMessage(emptyState('', ''), { type: 'hello', ...s0 });
    for (let i = 0; i < 1100; i++) { const m = msgAt(i); store.append(m); state = applyMessage(state, m); }
    await store.flush();
    const snap = path.join(projectDir(root, home), 'snapshots', '1000.json.gz');
    expect(fs.existsSync(snap)).toBe(true);
    fs.writeFileSync(snap, crypto.randomBytes(300));
    const { seq, at: _at, ...rest } = await store.stateAt(1101);
    expect(seq).toBe(1101);
    expect(rest).toEqual(state);
    await store.close();
  });
});

describe('Review Focus 2: run boundaries', () => {
  it('nothing leaks across runs', async () => {
    const a = await open();
    const sa = startState('A', ['a.ts', 'b.ts']);
    await a.startRun(sa);
    let stateA = applyMessage(emptyState('', ''), { type: 'hello', ...sa });
    for (let i = 0; i < 599; i++) { const m = msgAt(i); a.append(m); stateA = applyMessage(stateA, m); }
    await a.close();
    const lastA = a.info().last;
    expect(lastA).toBe(600);

    const b = await open();
    const sb: ProjectState = { ...startState('B', ['z.ts']), control: { paused: true, flags: [] } };
    await b.startRun(sb);
    for (let i = 0; i < 20; i++) b.append(msgAt(i));
    await b.flush();
    const info = b.info();
    expect(info.runs).toHaveLength(2);
    const firstB = info.runs[1].firstSeq;
    expect(firstB).toBe(lastA + 1);

    const { seq: _s1, at: _a1, ...gotA } = await b.stateAt(lastA);
    expect(gotA).toEqual(stateA);
    const { seq: _s2, at: _a2, ...gotB } = await b.stateAt(firstB);
    expect(gotB).toEqual(sb);
    await b.close();
  });
});

describe('cap', () => {
  const runOf = async (store: HistoryStore, name: string, n: number) => {
    await store.startRun(startState(name));
    // About 2 KB per event.
    for (let i = 0; i < n; i++) store.append({ type: 'agentEvent', event: agentEvent(i, 'message', 'x'.repeat(2000)) });
    await store.flush();
  };

  it('deletes the oldest run when over the cap and keeps the current run', async () => {
    const dir = projectDir(root, home);
    const s1 = await open({ capMb: 1 });
    await runOf(s1, 'A', 300);
    const runA = s1.info().runs[0];
    await s1.close();
    const s2 = await open({ capMb: 1 });
    await runOf(s2, 'B', 300);
    await s2.close();
    const s3 = await open({ capMb: 1 });
    await runOf(s3, 'C', 300);
    const info = s3.info();
    expect(info.runs.map(r => r.id)).not.toContain(runA.id);
    expect(fs.existsSync(path.join(dir, `events-${runA.id}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'snapshots', `${runA.firstSeq}.json.gz`))).toBe(false);
    expect(info.first).toBeGreaterThan(runA.lastSeq);
    const current = info.runs[info.runs.length - 1];
    expect(fs.existsSync(path.join(dir, `events-${current.id}.jsonl`))).toBe(true);
    expect((await s3.stateAt(info.last)).name).toBe('C');
    await s3.close();

    const s4 = await open({ capMb: 1 });
    expect(s4.info().runs.map(r => r.id)).toEqual([current.id]);
    await s4.close();
  });

  it('a single run over the cap keeps only its newest snapshot and the tail after it', async () => {
    const s = await open({ capMb: 0.25, snapshotEvery: 100 });
    await s.startRun(startState('solo'));
    let state = applyMessage(emptyState('', ''), { type: 'hello', ...startState('solo') });
    for (let i = 0; i < 350; i++) {
      const m: ServerMessage = { type: 'agentEvent', event: agentEvent(i, 'message', 'y'.repeat(2000)) };
      s.append(m);
      state = applyMessage(state, m);
    }
    await s.close();
    const again = await open({ capMb: 0.25, snapshotEvery: 100 });
    const info = again.info();
    expect(info.first).toBe(300);
    expect(info.last).toBe(351);
    expect(info.bytes).toBeLessThan(0.25 * 1024 * 1024);
    expect(fs.readdirSync(path.join(projectDir(root, home), 'snapshots'))).toEqual(['300.json.gz']);
    const { seq: _s, at: _a, ...got } = await again.stateAt(351);
    expect(got).toEqual(state);
    expect(again.messages(1, 1000)[0].seq).toBe(300);
    await again.close();
  });
});

describe('cap and reads in flight', () => {
  it('stateAt is unaffected by cap eviction during its awaits', async () => {
    const store = await open({ capMb: 0.9 });
    await store.startRun(startState('A'));
    for (let i = 0; i < 10; i++) store.append({ type: 'agentEvent', event: agentEvent(i, 'message', 'a'.repeat(60_000)) });
    const sb = startState('B');
    await store.startRun(sb);
    const firstB = store.info().runs[1].firstSeq;
    let state = applyMessage(emptyState('', ''), { type: 'hello', ...sb });
    const expected = new Map<number, ProjectState>();
    for (let i = 0; i < 400; i++) {
      const m: ServerMessage = { type: 'agentEvent', event: agentEvent(1000 + i, 'message', 'b'.repeat(1000)) };
      expected.set(store.append(m), state = applyMessage(state, m));
    }
    await store.flush();
    const runA = store.info().runs[0];
    const target = firstB + 50;
    const wantAt = store.messages(target, target)[0].at;

    const [got] = await Promise.all([store.stateAt(target), store.startRun(startState('C'))]);
    const { seq, at, ...rest } = got;
    expect(seq).toBe(target);
    expect(at).toBe(wantAt);
    expect(rest.events).toHaveLength(50);
    expect(rest).toEqual(expected.get(target));
    // The eviction the read held back has run since.
    await store.flush();
    expect(store.info().runs.map(r => r.id)).not.toContain(runA.id);
    expect((await store.stateAt(target)).events).toHaveLength(50);
    await store.close();
  });

  it('append never enforces the cap inline; it runs on a deferred task', async () => {
    const dir = projectDir(root, home);
    const store = await open({ capMb: 1 });
    await store.startRun(startState('A'));
    for (let i = 0; i < 300; i++) store.append({ type: 'agentEvent', event: agentEvent(i, 'message', 'x'.repeat(2000)) });
    const runA = store.info().runs[0];
    await store.startRun(startState('B'));
    // Over 5 MB of appends: inline flushes happen, the cap check does not.
    for (let i = 0; i < 2700; i++) store.append({ type: 'agentEvent', event: agentEvent(i, 'message', 'x'.repeat(2000)) });
    expect(fs.existsSync(path.join(dir, `events-${runA.id}.jsonl`))).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.existsSync(path.join(dir, `events-${runA.id}.jsonl`))).toBe(false);
    await store.close();
  });
});

describe('ticks', () => {
  it('counts kinds per bucket and lists run starts', async () => {
    const store = await open();
    await store.startRun(startState('A'));
    const kinds: AgentEventType[] = ['prompt', 'message', 'thinking', 'tool_start', 'tool_end', 'commit', 'status'];
    kinds.forEach((k, i) => store.append({ type: 'agentEvent', event: agentEvent(i, k) }));
    store.append({ type: 'change', change: change(1, 'a.ts'), files: [], removed: [] });
    store.append({ type: 'control', control: { paused: false, flags: [] } });
    await store.startRun(startState('B'));
    await store.flush();
    const t = store.ticks(1);
    expect(t.from).toBe(1);
    expect(t.to).toBe(11);
    expect(t.buckets).toHaveLength(1);
    expect(t.buckets[0].counts).toEqual({ prompt: 1, message: 2, tool: 2, change: 1, commit: 1, other: 4 });
    expect(t.runStarts).toEqual([1, 11]);
    const ids = store.info().runs.map(r => r.id);
    expect(t.prevRuns).toEqual(['', ids[0]]);
    expect(store.ticks(4, 2, 11).runStarts).toEqual([11]);
    expect(store.ticks(4, 2, 11).prevRuns).toEqual([ids[0]]);
    await store.close();
  });

  it('an agentEvents batch counts as the first kind in tick order among its events', async () => {
    const store = await open();
    await store.startRun(startState());
    store.append({ type: 'agentEvents', events: [agentEvent(1, 'tool_start'), agentEvent(2, 'prompt'), agentEvent(3, 'status')] });
    store.append({ type: 'agentEvents', events: [agentEvent(4, 'status'), agentEvent(5, 'tool_end')] });
    await store.flush();
    expect(store.ticks(1).buckets[0].counts).toEqual({ prompt: 1, message: 0, tool: 1, change: 0, commit: 0, other: 1 });
    await store.close();
  });
});

describe('50,000 events', () => {
  let bigHome: string;
  let bigRoot: string;
  let store: HistoryStore;

  beforeAll(async () => {
    bigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hist-big-'));
    bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hist-bigroot-'));
    store = await HistoryStore.open(bigRoot, { home: bigHome });
    await store.startRun({ ...emptyState(bigRoot, 'big'), files: Array.from({ length: 200 }, (_, i) => file(`src/f${i}.ts`)) });
    for (let i = 0; i < 49_999; i++) store.append(msgAt(i), 1_000_000 + i);
    await store.flush();
  }, 60_000);
  afterAll(async () => {
    await store.close();
    fs.rmSync(bigHome, { recursive: true, force: true });
    fs.rmSync(bigRoot, { recursive: true, force: true });
  });

  it('ticks into 300 buckets sum to 50,000 and stay under 64 KB', () => {
    const t = store.ticks(300);
    expect(t.buckets).toHaveLength(300);
    let sum = 0;
    for (const b of t.buckets) for (const v of Object.values(b.counts)) sum += v;
    expect(sum).toBe(50_000);
    expect(JSON.stringify(t).length).toBeLessThan(64 * 1024);
    expect(t.runStarts).toEqual([1]);
  });

  it('stateAt at random seqs is fast', async () => {
    let worst = 0;
    for (let k = 0; k < 15; k++) {
      const seq = 1 + Math.floor(Math.random() * 50_000);
      const t0 = performance.now();
      const s = await store.stateAt(seq);
      const ms = performance.now() - t0;
      worst = Math.max(worst, ms);
      expect(s.seq).toBe(seq);
    }
    console.log(`stateAt worst over 15 random seqs: ${worst.toFixed(1)} ms`);
    expect(worst).toBeLessThan(600);
  });
});

describe('write failure', () => {
  it('reports once, disables the store, and later appends are no-ops', async () => {
    const errors: Error[] = [];
    const store = await open();
    store.onError = e => errors.push(e);
    await store.startRun(startState());
    store.append(msgAt(7));
    await store.flush();
    const dir = projectDir(root, home);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) fs.chmodSync(path.join(dir, f), 0o400);
    fs.chmodSync(dir, 0o500);
    if (process.getuid?.() === 0) {
      // Root ignores modes, so make the directory unusable another way.
      fs.chmodSync(dir, 0o700);
      fs.renameSync(dir, `${dir}.moved`);
      fs.writeFileSync(dir, '');
    }
    expect(() => store.append(msgAt(15))).not.toThrow();
    await store.flush();
    expect(errors).toHaveLength(1);
    const info = store.info();
    expect(info.enabled).toBe(false);
    expect(info.error).toBeTruthy();
    expect(store.append(msgAt(23))).toBe(-1);
    await store.flush();
    await store.close();
    expect(errors).toHaveLength(1);
  });
});
