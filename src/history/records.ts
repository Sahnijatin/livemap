import fs from 'node:fs';
import type { ServerMessage } from '../shared/protocol.js';

import { kindOf, TICK_KINDS } from '../shared/history.js';
export { kindOf, TICK_KINDS };
export type { TickKind } from '../shared/history.js';

/** One stored event, as the index locates it: `run` is the run's number, `off`/`len` its byte range in that run's file. */
export interface IndexEntry { seq: number; at: number; run: number; off: number; len: number; kind: number }

/** Per-event `seq`, `at`, run, byte range and tick kind in growable typed arrays, ordered by seq. */
export class EventIndex {
  length = 0;
  seq = new Float64Array(1024);
  at = new Float64Array(1024);
  run = new Uint32Array(1024);
  off = new Float64Array(1024);
  len = new Uint32Array(1024);
  kind = new Uint8Array(1024);

  push(e: IndexEntry): void {
    if (this.length === this.seq.length) this.grow(this.length * 2);
    const i = this.length++;
    this.seq[i] = e.seq; this.at[i] = e.at; this.run[i] = e.run; this.off[i] = e.off; this.len[i] = e.len; this.kind[i] = e.kind;
  }

  /** The first position whose seq is >= `seq` (`length` when none). */
  lowerBound(seq: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.seq[mid] < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The position holding exactly `seq`, or -1. */
  indexOf(seq: number): number {
    const i = this.lowerBound(seq);
    return i < this.length && this.seq[i] === seq ? i : -1;
  }

  /** Drops the first `n` entries. */
  removePrefix(n: number): void {
    if (n <= 0) return;
    for (const a of this.arrays()) a.copyWithin(0, n, this.length);
    this.length = Math.max(0, this.length - n);
  }

  toJSON(): Record<string, number[]> {
    const pick = (a: Float64Array | Uint32Array | Uint8Array) => Array.from(a.subarray(0, this.length));
    return { seq: pick(this.seq), at: pick(this.at), run: pick(this.run), off: pick(this.off), len: pick(this.len), kind: pick(this.kind) };
  }

  /** Rebuilds from `toJSON` output; throws on any shape mismatch. */
  static fromJSON(j: Record<string, unknown>): EventIndex {
    const cols = ['seq', 'at', 'run', 'off', 'len', 'kind'] as const;
    const n = Array.isArray(j.seq) ? j.seq.length : -1;
    for (const c of cols) if (!Array.isArray(j[c]) || (j[c] as unknown[]).length !== n) throw new Error(`bad index column ${c}`);
    const idx = new EventIndex();
    idx.grow(Math.max(1024, n));
    for (const c of cols) idx[c].set(j[c] as number[]);
    idx.length = n;
    for (let i = 1; i < n; i++) if (!(idx.seq[i] > idx.seq[i - 1])) throw new Error('index seqs out of order');
    return idx;
  }

  private arrays() {
    return [this.seq, this.at, this.run, this.off, this.len, this.kind];
  }

  private grow(cap: number): void {
    const next = <T extends Float64Array | Uint32Array | Uint8Array>(a: T, make: new (n: number) => T): T => {
      const b = new make(cap);
      b.set(a.subarray(0, Math.min(this.length, cap)));
      return b;
    };
    this.seq = next(this.seq, Float64Array); this.at = next(this.at, Float64Array); this.run = next(this.run, Uint32Array);
    this.off = next(this.off, Float64Array); this.len = next(this.len, Uint32Array); this.kind = next(this.kind, Uint8Array);
  }
}

/** The seq of a file's first record, read from its first bytes, or null. */
export function peekFirstSeq(file: string): number | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    const m = /^\{"seq":(\d+),/.exec(buf.toString('utf8', 0, n));
    return m ? Number(m[1]) : null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ScanResult { size: number; count: number; firstSeq: number; lastSeq: number; firstAt: number; repaired: boolean }

/**
 * Indexes one events file. Lines that fail to parse, or whose seq does not exceed `afterSeq` and the
 * lines before them, are skipped. A tail without a newline (a write cut short) is truncated away, or
 * only left unread when `repair` is false.
 */
export function scanEvents(file: string, runNo: number, afterSeq: number, index: EventIndex, repair = true): ScanResult {
  const buf = fs.readFileSync(file);
  const lastNl = buf.lastIndexOf(0x0a);
  const repaired = lastNl !== buf.length - 1;
  if (repaired && repair) fs.truncateSync(file, lastNl + 1);
  const size = lastNl + 1;
  const res: ScanResult = { size, count: 0, firstSeq: 0, lastSeq: afterSeq, firstAt: 0, repaired };
  let start = 0;
  while (start < size) {
    const nl = buf.indexOf(0x0a, start);
    const rec = parseRecord(buf.toString('utf8', start, nl));
    if (rec && rec.seq > res.lastSeq) {
      index.push({ seq: rec.seq, at: rec.at, run: runNo, off: start, len: nl + 1 - start, kind: kindOf(rec.msg) });
      if (res.count++ === 0) { res.firstSeq = rec.seq; res.firstAt = rec.at; }
      res.lastSeq = rec.seq;
    }
    start = nl + 1;
  }
  return res;
}

interface StoredRecord { seq: number; at: number; msg: ServerMessage }

function parseRecord(line: string): StoredRecord | null {
  try {
    const r = JSON.parse(line) as Partial<StoredRecord>;
    if (typeof r.seq !== 'number' || typeof r.at !== 'number' || typeof r.msg?.type !== 'string') return null;
    return r as StoredRecord;
  } catch {
    return null;
  }
}

/**
 * A byte range of one file holding consecutive records, with their seq, time, offset and length
 * copied out of the index, so a read in flight is unaffected by later index changes.
 */
export interface Span { file: string; seq: Float64Array; at: Float64Array; off: Float64Array; len: Uint32Array }

/** Pins positions [i0, i1) as spans of consecutive entries from the same run. */
export function spansOf(index: EventIndex, i0: number, i1: number, fileOf: (runNo: number) => string): Span[] {
  const spans: Span[] = [];
  let a = i0;
  for (let i = i0 + 1; i <= i1; i++) {
    if (i === i1 || index.run[i] !== index.run[a]) {
      spans.push({
        file: fileOf(index.run[a]),
        seq: index.seq.slice(a, i), at: index.at.slice(a, i), off: index.off.slice(a, i), len: index.len.slice(a, i),
      });
      a = i;
    }
  }
  return spans;
}

export interface ReadRecord { seq: number; at: number; msg: ServerMessage }

function decode(span: Span, buf: Buffer, out: ReadRecord[]): void {
  const base = span.off[0];
  for (let i = 0; i < span.seq.length; i++) {
    const o = span.off[i] - base;
    const rec = JSON.parse(buf.toString('utf8', o, o + span.len[i])) as StoredRecord;
    out.push({ seq: span.seq[i], at: span.at[i], msg: rec.msg });
  }
}

const spanBytes = (s: Span) => s.off[s.off.length - 1] + s.len[s.len.length - 1] - s.off[0];

/** Reads only the byte ranges the spans cover. */
export function readSpansSync(spans: Span[]): ReadRecord[] {
  const out: ReadRecord[] = [];
  for (const s of spans) {
    const buf = Buffer.alloc(spanBytes(s));
    const fd = fs.openSync(s.file, 'r');
    try {
      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, s.off[0] + got);
        if (n === 0) throw new Error(`short read in ${s.file}`);
        got += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    decode(s, buf, out);
  }
  return out;
}

export async function readSpans(spans: Span[]): Promise<ReadRecord[]> {
  const out: ReadRecord[] = [];
  for (const s of spans) {
    const buf = Buffer.alloc(spanBytes(s));
    const fh = await fs.promises.open(s.file, 'r');
    try {
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, s.off[0] + got);
        if (bytesRead === 0) throw new Error(`short read in ${s.file}`);
        got += bytesRead;
      }
    } finally {
      await fh.close();
    }
    decode(s, buf, out);
  }
  return out;
}
