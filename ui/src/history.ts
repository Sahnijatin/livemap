import type { HistoryInfo, TickKind, Ticks } from '@shared/history.js';
import type { HistoryStatus, ServerMessage } from '@shared/protocol.js';
import type { ProjectState } from '@shared/state.js';
import { authHeaders } from './connection';
import { dict } from './dict';

export type { HistoryInfo, TickKind, Ticks };

/** The project state right after a recorded seq, as `/api/history/state` returns it. */
export type HistoryState = ProjectState & { seq: number; at: number };
/** `/api/state`: the live hello payload, with its recording status and seq. */
export type LiveState = ProjectState & { seq: number; history?: HistoryStatus };
/** One recorded message. */
export interface HistoryRecord { seq: number; at: number; msg: ServerMessage }

/**
 * Where the timeline reads history from (ruling R-P2). The app talks to the live server over REST; an
 * export installs an embedded source with `setHistorySource`.
 */
export interface HistorySource {
  info(): Promise<HistoryInfo>;
  ticks(buckets: number): Promise<Ticks>;
  stateAt(seq: number): Promise<HistoryState>;
  messages(from: number, to: number, limit: number): Promise<HistoryRecord[]>;
  /** The live state, as `/api/state` returns it (a hello payload). */
  live(): Promise<LiveState>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export const restHistorySource: HistorySource = {
  info: () => getJson('/api/history/info'),
  ticks: buckets => getJson(`/api/history/ticks?buckets=${buckets}`),
  stateAt: seq => getJson(`/api/history/state?seq=${seq}`),
  messages: (from, to, limit) => getJson(`/api/history/messages?from=${from}&to=${to}&limit=${limit}`),
  live: () => getJson('/api/state'),
};

let current: HistorySource = restHistorySource;
export const historySource = (): HistorySource => current;
export function setHistorySource(s: HistorySource): void {
  current = s;
}

/** An export's file texts by path (null when it was made with --no-code); undefined in the live app. */
let code: Record<string, string> | null | undefined;
export const embeddedCode = () => code;
export function setEmbeddedCode(c: Record<string, string> | null | undefined): void {
  code = c ? dict(c) : c;
}

/** Tooltip on everything that is read-only while the UI shows the past. */
export const READ_ONLY_TIP = 'Back to live to make changes';

/** Most buckets the timeline asks for; the server caps it there too. */
export const MAX_BUCKETS = 500;
/** Pixels per tick bucket on the track. */
export const BUCKET_PX = 3;
export const bucketsFor = (width: number): number => Math.max(1, Math.min(MAX_BUCKETS, Math.floor(width / BUCKET_PX)));

const COLORED: TickKind[] = ['prompt', 'message', 'tool', 'change', 'commit'];

/** The bucket's most frequent colored kind (first in COLORED order on a tie); `other` when only uncolored records fell in it; null when empty. */
export function dominantKind(counts: Record<TickKind, number>): TickKind | null {
  let best: TickKind | null = null;
  for (const k of COLORED) if (counts[k] > 0 && (!best || counts[k] > counts[best])) best = k;
  return best ?? (counts.other > 0 ? 'other' : null);
}

/** A drag asks for the state at most this often. */
export const STATE_THROTTLE_MS = 120;

/**
 * Leading and trailing throttle for state requests: at most one `fetch` per `wait` ms, the newest seq
 * last. A response applies only when no newer request has already applied, so an older answer never
 * overrides a newer one. `cancel` drops the pending request and every response still in flight.
 */
export function latestThrottle<T, A = number>(fetch: (req: A) => Promise<T>, apply: (v: T) => void, wait = STATE_THROTTLE_MS, onError?: () => void) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Boxed, so any request value (a seq, or a seq with what was true when it was asked) can be pending.
  let pending: { req: A } | null = null;
  let issued = 0;
  let applied = 0;
  const fire = () => {
    const { req } = pending!;
    pending = null;
    last = Date.now();
    const id = ++issued;
    fetch(req).then(v => {
      if (id <= applied) return;
      applied = id;
      apply(v);
    }, () => {
      // Only the newest request's failure matters: a superseded or cancelled one is already moot.
      if (id === issued && id > applied && pending === null) onError?.();
    });
  };
  return {
    request(req: A) {
      pending = { req };
      if (timer) return;
      const due = last + wait - Date.now();
      if (due <= 0) return fire();
      timer = setTimeout(() => { timer = null; if (pending !== null) fire(); }, due);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      applied = issued;
    },
  };
}
