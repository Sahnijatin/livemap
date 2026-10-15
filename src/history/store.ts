import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { ServerMessage } from '../shared/protocol.js';
import { applyMessage, emptyState } from '../shared/state.js';
import type { ProjectState } from '../shared/state.js';
import {
  ensureDir, eventsName, FILE_MODE, indexPath, parseEventsName, parseSnapshotName, projectDir, runIdFor,
  snapshotPath, snapshotsDir, writeFileAtomic,
} from './paths.js';
import { EventIndex, kindOf, peekFirstSeq, readSpans, readSpansSync, scanEvents, spansOf } from './records.js';
import type { ReadRecord, TickKind } from './records.js';
import { bucketTicks } from '../shared/history.js';
import type { HistoryInfo, HistoryRun, TickBucket, Ticks } from '../shared/history.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * The server message types the store records. `hello` is only ever written by `startRun` (one per run),
 * and `indexing`, `history` and `summaryStatus` are never recorded.
 */
export const RECORDED_TYPES: ReadonlySet<ServerMessage['type']> = new Set<ServerMessage['type']>([
  'files', 'change', 'usedBy', 'domain', 'agentEvent', 'session', 'control', 'attribution', 'summary', 'fileSummary',
]);

const FLUSH_MS = 250;
const FLUSH_BYTES = 256 * 1024;
const CAP_CHECK_BYTES = 5 * 1024 * 1024;
const DEFAULT_CAP_MB = 200;
const INDEX_VERSION = 1;
/** `events-<run>.jsonl.trim.tmp` (trimRun) and `index.json.<pid>.<hex>.tmp` (writeFileAtomic). */
const LEFTOVER_TMP = /^(events-.+\.jsonl\.trim|index\.json\..+)\.tmp$/;

export interface HistoryOptions {
  home?: string; capMb?: number; snapshotEvery?: number; now?: () => number;
  /** Read only (`livemap export`): nothing on disk is created, repaired, trimmed or removed, and no run can start. */
  readOnly?: boolean;
}
export type { HistoryInfo, HistoryRun, TickBucket, Ticks };
export type { ReadRecord as HistoryRecord, TickKind };

interface Run extends HistoryRun { no: number; file: string; size: number }
interface Pending { seq: number; at: number; msg: ServerMessage; line: string; bytes: number }

/**
 * Append-only per-project history: one JSONL file per run, gzip snapshots at each run start and every
 * `snapshotEvery` seqs, and an in-memory index of every record's byte range.
 *
 * Every run begins with a `hello` record carrying the run's start state (written by `startRun`), so
 * `append` before `startRun` records nothing and returns -1. `append` never throws: the first I/O
 * error disables the store, is reported once through `onError`, and appends after it return -1.
 */
export class HistoryStore {
  onError: (e: Error) => void = () => {};

  private readonly capBytes: number;
  private readonly every: number;
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private runs: Run[] = [];
  private nextRunNo = 1;
  private index = new EventIndex();
  /** Snapshot seq -> bytes on disk, and the same seqs sorted. */
  private snapshots = new Map<number, number>();
  private snapSeqs: number[] = [];
  private badSnapshots = new Set<number>();
  private snapWrites = new Set<Promise<void>>();
  private current: Run | null = null;
  private live: ProjectState | null = null;
  private pending: Pending[] = [];
  private pendingBytes = 0;
  private lastSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private sinceCapCheck = 0;
  /** stateAt reads in flight; cap eviction waits for them so no file or offset moves under a read. */
  private readers = 0;
  private capDue = false;
  private capTimer: NodeJS.Immediate | null = null;
  private disabled = false;
  private closed = false;
  private error: string | undefined;

  private constructor(private readonly dir: string, opts: HistoryOptions) {
    const envMb = Number(process.env.LIVEMAP_HISTORY_MB);
    const mb = opts.capMb ?? (envMb > 0 ? envMb : DEFAULT_CAP_MB);
    this.capBytes = mb * 1024 * 1024;
    this.every = opts.snapshotEvery ?? 500;
    this.now = opts.now ?? Date.now;
    this.readOnly = opts.readOnly ?? false;
  }

  /** Opens the project's history: scans existing runs (or loads index.json), repairs a truncated tail, enforces the cap. */
  static async open(root: string, opts: HistoryOptions = {}): Promise<HistoryStore> {
    const store = new HistoryStore(projectDir(root, opts.home), opts);
    try {
      store.load();
    } catch (e) {
      store.fail(e, 'open');
    }
    return store;
  }

  /**
   * Starts a new run whose first record is `{type:'hello', ...state}`, snapshotted at that seq. The run
   * is current before this returns its promise, so appends made right after the call belong to it.
   */
  async startRun(state: ProjectState): Promise<void> {
    if (this.disabled || this.closed || this.readOnly) return;
    this.flushSync();
    if (this.disabled) return;
    const at = this.now();
    let id = runIdFor(at);
    for (let k = 1; this.runs.some(r => r.id === id); k++) id = `${runIdFor(at)}-${k}`;
    const run: Run = { no: this.nextRunNo++, id, file: path.join(this.dir, eventsName(id)), firstSeq: this.lastSeq + 1, lastSeq: this.lastSeq, startAt: at, size: 0 };
    this.runs.push(run);
    this.current = run;
    this.live = null;
    this.enqueue({ type: 'hello', ...state }, at);
    this.flushSync();
    // The cap runs once the previous run's snapshot writes have landed, so none lands after its run is deleted.
    await this.flush();
    this.capDue = true;
    this.runCapIfDue();
  }

  /**
   * Buffers one message and returns its seq, or -1 when the type is not recorded, no run has started or the
   * store is disabled. `text`, when given, must be `JSON.stringify(msg)`; it saves serializing the message twice.
   */
  append(msg: ServerMessage, at: number = this.now(), text?: string): number {
    if (!RECORDED_TYPES.has(msg.type) || this.disabled || this.closed || !this.current) return -1;
    const seq = this.enqueue(msg, at, text);
    if (this.pendingBytes >= FLUSH_BYTES) this.flushSync();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flushSync(); }, FLUSH_MS);
      this.timer.unref?.();
    }
    return seq;
  }

  /** Writes buffered records and waits for snapshot writes in flight. */
  async flush(): Promise<void> {
    this.flushSync();
    while (this.snapWrites.size) await Promise.all([...this.snapWrites]);
  }

  /** Flushes and persists the index. Later calls are no-ops. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.capTimer) clearImmediate(this.capTimer);
    this.capTimer = null;
    if (this.disabled || this.readOnly) return;
    const runs = this.runs.map(r => ({ id: r.id, no: r.no, firstSeq: r.firstSeq, lastSeq: r.lastSeq, startAt: r.startAt, size: r.size }));
    // index.json is a cache rebuilt by scanning, so failing to write it is not a history failure.
    await writeFileAtomic(indexPath(this.dir), JSON.stringify({ version: INDEX_VERSION, runs, ...this.index.toJSON() })).catch(() => undefined);
  }

  info(): HistoryInfo {
    const idx = this.index;
    const n = idx.length;
    const tail = this.pending[this.pending.length - 1];
    const info: HistoryInfo = {
      enabled: !this.disabled,
      first: n ? idx.seq[0] : tail ? this.pending[0].seq : 0,
      last: tail ? tail.seq : n ? idx.seq[n - 1] : 0,
      firstAt: n ? idx.at[0] : tail ? this.pending[0].at : 0,
      lastAt: tail ? tail.at : n ? idx.at[n - 1] : 0,
      runs: this.runs.filter(r => r.lastSeq >= r.firstSeq).map(r => ({ id: r.id, firstSeq: r.firstSeq, lastSeq: r.lastSeq, startAt: r.startAt })),
      bytes: this.pendingBytes + this.diskBytes(),
    };
    if (this.error) info.error = this.error;
    return info;
  }

  /**
   * Kind counts over [from, to] (default: everything) in at most `buckets` (capped at 500) equal seq
   * ranges. Each bucket carries its first seq and the time of its first record. `runStarts` lists the
   * first seq of each run in range (for a run trimmed by the cap, where its history now begins).
   */
  ticks(buckets: number, from?: number, to?: number): Ticks {
    this.flushSync();
    const runStarts = this.runs.filter(r => r.lastSeq >= r.firstSeq).map(r => r.firstSeq);
    return bucketTicks(this.index, buckets, runStarts, from, to);
  }

  /** Records with seq in [from, to], oldest first, at most `limit` (default 1000). */
  messages(from: number, to: number, limit = 1000): ReadRecord[] {
    this.flushSync();
    const i0 = this.index.lowerBound(from);
    const i1 = Math.min(this.index.lowerBound(to + 1), i0 + Math.max(0, limit));
    if (i1 <= i0) return [];
    return readSpansSync(spansOf(this.index, i0, i1, no => this.fileOf(no)));
  }

  /**
   * The project state right after record `seq`: the newest readable snapshot at or before it within its
   * run (or the run's own start record when none is readable), plus replay. Throws for an unknown seq.
   *
   * Everything the read needs (time, snapshot candidates, byte ranges) is pinned before the first await,
   * and cap eviction waits until no read is in flight, so concurrent writes, deletes and trims cannot
   * shift what this read sees.
   */
  async stateAt(seq: number): Promise<ProjectState & { seq: number; at: number }> {
    this.flushSync();
    const idx = this.index;
    const i = idx.indexOf(seq);
    if (i < 0) throw new RangeError(`seq ${seq} is not in history`);
    const run = this.runs.find(r => r.no === idx.run[i]);
    if (!run) throw new Error(`no run holds seq ${seq}`);
    const at = idx.at[i];
    const candidates = this.snapSeqs.filter(s => s >= run.firstSeq && s <= seq).reverse();
    // While a reader is active the cap (the only thing that moves index entries or deletes run files) waits,
    // so the spans can be cut after the snapshot is chosen: only the records after it are copied.
    this.readers++;
    try {
      let state: ProjectState | null = null;
      let after = run.firstSeq - 1;
      for (const s of candidates) {
        state = await this.readSnapshot(s);
        if (state) { after = s; break; }
      }
      const records = await readSpans(spansOf(idx, Math.max(idx.lowerBound(after + 1), idx.indexOf(run.firstSeq)), i + 1, no => this.fileOf(no)));
      if (!state) {
        if (records[0]?.msg.type !== 'hello') throw new Error(`no readable snapshot for seq ${seq}`);
        state = emptyState('', '');
      }
      for (const r of records) state = applyMessage(state, r.msg);
      return { ...state, seq, at };
    } finally {
      this.readers--;
      this.runCapIfDue();
    }
  }

  // ---- writing ----

  private enqueue(msg: ServerMessage, at: number, text?: string): number {
    const seq = ++this.lastSeq;
    const line = `{"seq":${seq},"at":${at},"run":${JSON.stringify(this.current!.id)},"msg":${text ?? JSON.stringify(msg)}}\n`;
    const bytes = Buffer.byteLength(line);
    this.pending.push({ seq, at, msg, line, bytes });
    this.pendingBytes += bytes;
    return seq;
  }

  private flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.length || this.disabled) return;
    const batch = this.pending;
    const run = this.current!;
    this.pending = [];
    this.pendingBytes = 0;
    const buf = Buffer.from(batch.map(p => p.line).join(''));
    try {
      const fd = fs.openSync(run.file, 'a', FILE_MODE);
      try {
        for (let done = 0; done < buf.length;) done += fs.writeSync(fd, buf, done, buf.length - done);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.fail(e, 'write');
      return;
    }
    let off = run.size;
    for (const p of batch) {
      this.index.push({ seq: p.seq, at: p.at, run: run.no, off, len: p.bytes, kind: kindOf(p.msg) });
      off += p.bytes;
      this.live = applyMessage(this.live ?? emptyState('', ''), p.msg);
      if (p.msg.type === 'hello' || p.seq % this.every === 0) this.writeSnapshot(p.seq, this.live);
    }
    run.size = off;
    run.lastSeq = batch[batch.length - 1].seq;
    this.sinceCapCheck += buf.length;
    if (this.sinceCapCheck >= CAP_CHECK_BYTES) {
      this.sinceCapCheck = 0;
      this.requestCap();
    }
  }

  private writeSnapshot(seq: number, state: ProjectState): void {
    const job = (async () => {
      const gz = await gzip(Buffer.from(JSON.stringify(state)));
      await writeFileAtomic(snapshotPath(this.dir, seq), gz);
      this.addSnapshot(seq, gz.length);
    })().catch(e => this.fail(e, 'snapshot'));
    this.snapWrites.add(job);
    void job.finally(() => this.snapWrites.delete(job));
  }

  private addSnapshot(seq: number, bytes: number): void {
    if (!this.snapshots.has(seq)) {
      let k = this.snapSeqs.length;
      while (k > 0 && this.snapSeqs[k - 1] > seq) k--;
      this.snapSeqs.splice(k, 0, seq);
    }
    this.snapshots.set(seq, bytes);
    this.badSnapshots.delete(seq);
  }

  private removeSnapshot(seq: number): void {
    fs.rmSync(snapshotPath(this.dir, seq), { force: true });
    this.snapshots.delete(seq);
    this.snapSeqs = this.snapSeqs.filter(s => s !== seq);
  }

  private async readSnapshot(seq: number): Promise<ProjectState | null> {
    if (this.badSnapshots.has(seq)) return null;
    try {
      const raw = await gunzip(await fs.promises.readFile(snapshotPath(this.dir, seq)));
      const state = JSON.parse(raw.toString('utf8')) as ProjectState;
      if (!state || typeof state !== 'object' || !Array.isArray(state.files)) throw new Error('not a project state');
      return state;
    } catch {
      this.badSnapshots.add(seq);
      return null;
    }
  }

  private fail(e: unknown, what: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const err = e instanceof Error ? e : new Error(String(e));
    const code = (err as NodeJS.ErrnoException).code;
    this.error = `could not ${what} history files${code ? ` (${code})` : ''}`;
    try { this.onError(err); } catch { /* a failing handler must not break recording callers */ }
  }

  // ---- cap ----

  /** Schedules cap enforcement off the caller's path (append may flush inline). */
  private requestCap(): void {
    this.capDue = true;
    if (this.capTimer || this.closed) return;
    this.capTimer = setImmediate(() => { this.capTimer = null; this.runCapIfDue(); });
    this.capTimer.unref?.();
  }

  /** Enforces the cap when one is due and no read is in flight; otherwise the last read to finish runs it. */
  private runCapIfDue(): void {
    if (!this.capDue || this.readers > 0) return;
    this.capDue = false;
    this.enforceCap();
  }

  /** Deletes the oldest runs while over the cap; a lone run over the cap is trimmed to its newest snapshot. */
  private enforceCap(): void {
    this.sinceCapCheck = 0;
    if (this.disabled) return;
    try {
      while (this.diskBytes() > this.capBytes && this.runs.length > 1) this.deleteRun(this.runs[0]);
      if (this.diskBytes() > this.capBytes && this.runs.length === 1) this.trimRun(this.runs[0]);
    } catch (e) {
      this.fail(e, 'trim');
    }
  }

  private diskBytes(): number {
    let bytes = 0;
    for (const r of this.runs) bytes += r.size;
    for (const b of this.snapshots.values()) bytes += b;
    return bytes;
  }

  private deleteRun(run: Run): void {
    fs.rmSync(run.file, { force: true });
    for (const s of [...this.snapSeqs]) if (s >= run.firstSeq && s <= run.lastSeq) this.removeSnapshot(s);
    let n = 0;
    while (n < this.index.length && this.index.run[n] === run.no) n++;
    this.index.removePrefix(n);
    this.runs = this.runs.filter(r => r !== run);
  }

  private trimRun(run: Run): void {
    const keep = this.snapSeqs.filter(s => s > run.firstSeq && s <= run.lastSeq).pop();
    const i = keep === undefined ? -1 : this.index.indexOf(keep);
    if (keep === undefined || i <= 0) return;
    const base = this.index.off[i];
    const tmp = `${run.file}.trim.tmp`;
    const src = fs.openSync(run.file, 'r');
    try {
      const dst = fs.openSync(tmp, 'w', FILE_MODE);
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        for (let pos = base; pos < run.size;) {
          const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, run.size - pos), pos);
          if (n === 0) break;
          fs.writeSync(dst, chunk, 0, n);
          pos += n;
        }
      } finally {
        fs.closeSync(dst);
      }
    } finally {
      fs.closeSync(src);
    }
    fs.renameSync(tmp, run.file);
    for (const s of [...this.snapSeqs]) if (s < keep) this.removeSnapshot(s);
    this.index.removePrefix(i);
    for (let k = 0; k < this.index.length; k++) this.index.off[k] -= base;
    run.size -= base;
    run.firstSeq = keep;
    run.startAt = this.index.at[0];
  }

  // ---- loading ----

  private fileOf(runNo: number): string {
    const run = this.runs.find(r => r.no === runNo);
    if (!run) throw new Error(`unknown run ${runNo}`);
    return run.file;
  }

  private load(): void {
    if (!this.readOnly) {
      ensureDir(this.dir);
      ensureDir(snapshotsDir(this.dir));
      // Temp files a crash left mid-trim or mid-index-write: never read, so removed.
      for (const name of fs.readdirSync(this.dir)) {
        if (LEFTOVER_TMP.test(name)) fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
    const ids = fs.readdirSync(this.dir).map(parseEventsName).filter((x): x is string => x !== null);
    if (!this.loadIndexFile(ids)) this.scan(ids);
    this.lastSeq = this.index.length ? this.index.seq[this.index.length - 1] : 0;
    const first = this.index.length ? this.index.seq[0] : 1;
    for (const name of fs.readdirSync(snapshotsDir(this.dir))) {
      const file = path.join(snapshotsDir(this.dir), name);
      const seq = parseSnapshotName(name);
      // Temp files, and snapshots for seqs no longer (or not yet) recorded, are removed.
      if (seq === null || seq < first || seq > this.lastSeq) { if (!this.readOnly) fs.rmSync(file, { force: true }); }
      else this.addSnapshot(seq, fs.statSync(file).size);
    }
    if (!this.readOnly) this.enforceCap();
  }

  /** Uses index.json when it matches the event files on disk exactly; returns false when it is missing or stale. */
  private loadIndexFile(ids: string[]): boolean {
    try {
      const j = JSON.parse(fs.readFileSync(indexPath(this.dir), 'utf8')) as { version: number; runs: (HistoryRun & { no: number; size: number })[] } & Record<string, unknown>;
      if (j.version !== INDEX_VERSION || !Array.isArray(j.runs) || j.runs.length !== ids.length) return false;
      const runs: Run[] = [];
      for (const r of j.runs) {
        const file = path.join(this.dir, eventsName(r.id));
        if (!ids.includes(r.id) || fs.statSync(file).size !== r.size) return false;
        runs.push({ ...r, file });
      }
      const index = EventIndex.fromJSON(j);
      this.runs = runs;
      this.index = index;
      this.nextRunNo = Math.max(0, ...runs.map(r => r.no)) + 1;
      return true;
    } catch {
      return false;
    }
  }

  /** Rebuilds the index from the event files, oldest run first; empty files are removed. */
  private scan(ids: string[]): void {
    const files = ids.map(id => {
      const file = path.join(this.dir, eventsName(id));
      return { id, file, first: peekFirstSeq(file) ?? Number.MAX_SAFE_INTEGER };
    }).sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : 1));
    this.index = new EventIndex();
    this.runs = [];
    let last = 0;
    for (const f of files) {
      const no = this.nextRunNo++;
      const res = scanEvents(f.file, no, last, this.index, !this.readOnly);
      if (!res.count) { if (!this.readOnly) fs.rmSync(f.file, { force: true }); continue; }
      this.runs.push({ no, id: f.id, file: f.file, firstSeq: res.firstSeq, lastSeq: res.lastSeq, startAt: res.firstAt, size: res.size });
      last = res.lastSeq;
    }
  }
}
