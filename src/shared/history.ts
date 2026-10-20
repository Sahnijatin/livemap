/** History API shapes shared by the server (`src/history/store.ts`) and the UI. No node imports. */

/** Tick kinds, in the order their codes are stored in the index. */
export const TICK_KINDS = ['prompt', 'message', 'tool', 'change', 'commit', 'other'] as const;
export type TickKind = (typeof TICK_KINDS)[number];

export interface HistoryRun { id: string; firstSeq: number; lastSeq: number; startAt: number }
export interface HistoryInfo {
  enabled: boolean; first: number; last: number; firstAt: number; lastAt: number;
  runs: HistoryRun[]; bytes: number; error?: string;
}
/** One bucket of `/api/history/ticks`: its first seq, the time of its first record, and kind counts. */
export interface TickBucket { seq: number; at: number; counts: Record<TickKind, number> }
export interface Ticks {
  from: number; to: number; buckets: TickBucket[]; runStarts: number[];
  /** For each of `runStarts`, the id of the run before it ('' for none). Absent where run ids are unknown (exports). */
  prevRuns?: string[];
}

const OTHER = TICK_KINDS.indexOf('other');

/**
 * The tick kind code (an index into TICK_KINDS) for a message. An `agentEvents` batch is one record, so it
 * takes the first kind in TICK_KINDS order among its events (a batch holding a prompt ticks as a prompt).
 */
export function kindOf(msg: { type: string; event?: { type: string }; events?: { type: string }[] }): number {
  if (msg.type === 'change') return TICK_KINDS.indexOf('change');
  if (msg.type === 'agentEvents') return (msg.events ?? []).reduce((k, e) => Math.min(k, eventKind(e)), OTHER);
  if (msg.type !== 'agentEvent') return OTHER;
  return eventKind(msg.event);
}

function eventKind(event: { type: string } | undefined): number {
  switch (event?.type) {
    case 'prompt': return TICK_KINDS.indexOf('prompt');
    case 'message': case 'thinking': return TICK_KINDS.indexOf('message');
    case 'tool_start': case 'tool_end': return TICK_KINDS.indexOf('tool');
    case 'commit': return TICK_KINDS.indexOf('commit');
    default: return OTHER;
  }
}

/** Most buckets a ticks request gets. */
export const MAX_TICK_BUCKETS = 500;

/** Records as parallel columns ordered by seq: their seq, time and tick kind code. */
export interface TickColumns { length: number; seq: ArrayLike<number>; at: ArrayLike<number>; kind: ArrayLike<number> }

/**
 * Kind counts over seqs [from, to] (default: everything) in at most `buckets` (capped at 500) equal seq
 * ranges. Each bucket carries its first seq and the time of its first record; a bucket with no records
 * takes the previous bucket's time. `runStarts` (and `prevRuns`, one per start) are passed through, limited to the range.
 * Shared by the history store and the export's embedded history source, so both bucket alike.
 */
export function bucketTicks(cols: TickColumns, buckets: number, runStarts: number[], from?: number, to?: number, prevRuns?: string[]): Ticks {
  const n = cols.length;
  if (!n) return { from: 0, to: 0, buckets: [], runStarts: [] };
  const lo = Math.max(from ?? cols.seq[0], cols.seq[0]);
  const hi = Math.min(to ?? cols.seq[n - 1], cols.seq[n - 1]);
  const keep = runStarts.map(s => s >= lo && s <= hi);
  const starts = runStarts.filter((_, i) => keep[i]);
  const runs = prevRuns ? { prevRuns: prevRuns.filter((_, i) => keep[i]) } : {};
  if (hi < lo) return { from: lo, to: hi, buckets: [], runStarts: starts, ...runs };
  const span = hi - lo + 1;
  const count = Math.min(span, Math.max(1, Math.min(MAX_TICK_BUCKETS, Math.floor(buckets) || 1)));
  const out: TickBucket[] = [];
  for (let b = 0; b < count; b++) {
    const counts = Object.fromEntries(TICK_KINDS.map(k => [k, 0])) as Record<TickKind, number>;
    out.push({ seq: lo + Math.ceil((b * span) / count), at: -1, counts });
  }
  const first = lowerBound(cols, lo);
  for (let i = first; i < n && cols.seq[i] <= hi; i++) {
    const bucket = out[Math.floor(((cols.seq[i] - lo) * count) / span)];
    if (bucket.at < 0) bucket.at = cols.at[i];
    bucket.counts[TICK_KINDS[cols.kind[i]]]++;
  }
  let prevAt = cols.at[first];
  for (const b of out) prevAt = b.at = b.at < 0 ? prevAt : b.at;
  return { from: lo, to: hi, buckets: out, runStarts: starts, ...runs };
}

/** The first position whose seq is at least `seq` (`length` when none is). */
export function lowerBound(cols: Pick<TickColumns, 'length' | 'seq'>, seq: number): number {
  let a = 0;
  let b = cols.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (cols.seq[m] < seq) a = m + 1;
    else b = m;
  }
  return a;
}
