import { applyMessage, type ProjectState } from '@shared/state.js';
import { bucketTicks, kindOf, lowerBound } from '@shared/history.js';
import type { ExportPayload } from '@shared/export.js';
import type { HistoryStatus } from '@shared/protocol.js';
import { setEmbeddedCode, setHistorySource, type HistoryRecord, type HistorySource, type HistoryState } from './history';
import { useStore } from './store';

// Export mode only: loaded when the page carries an embedded payload, so the live app never ships it.

/** States are kept after every this many messages, so a seek replays at most this many. */
const CHECKPOINT = 500;

/** The payload from its base64 gzip JSON text. */
export async function decodePayload(base64: string): Promise<ExportPayload> {
  const bin = atob(base64.trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as ExportPayload;
}

/**
 * History read from the payload (ruling R-P2): ticks bucketed as the server does, the state at a seq by
 * replay from `initial` (from the nearest checkpoint), and the end state standing in for live.
 */
export function embeddedSource(p: ExportPayload): HistorySource & { status: HistoryStatus } {
  const n = p.messages.length;
  const cols = { length: n, seq: new Float64Array(n), at: new Float64Array(n), kind: new Uint8Array(n) };
  const runStarts: number[] = [];
  p.messages.forEach(([seq, at, msg], i) => {
    cols.seq[i] = seq;
    cols.at[i] = at;
    cols.kind[i] = kindOf(msg);
    if (msg.type === 'hello') runStarts.push(seq);
  });
  // checkpoints[k] is the state after message k * CHECKPOINT + CHECKPOINT - 1.
  const checkpoints: ProjectState[] = [];
  let end = p.initial;
  for (let i = 0; i < n; i++) {
    end = applyMessage(end, p.messages[i][2]);
    if ((i + 1) % CHECKPOINT === 0) checkpoints.push(end);
  }
  const first = n ? cols.seq[0] : 0;
  const last = n ? cols.seq[n - 1] : 0;
  const status: HistoryStatus = { enabled: true, first, last, firstAt: n ? cols.at[0] : 0, lastAt: n ? cols.at[n - 1] : 0 };

  const stateAt = async (seq: number): Promise<HistoryState> => {
    const i = lowerBound(cols, seq + 1) - 1; // the last message at or before seq
    if (i < 0) return { ...p.initial, seq, at: status.firstAt };
    const k = Math.floor((i + 1) / CHECKPOINT);
    let state = k ? checkpoints[k - 1] : p.initial;
    for (let j = k * CHECKPOINT; j <= i; j++) state = applyMessage(state, p.messages[j][2]);
    return { ...state, seq, at: cols.at[i] };
  };

  return {
    status,
    info: async () => ({ ...status, runs: [], bytes: 0 }),
    ticks: async buckets => bucketTicks(cols, buckets, runStarts),
    stateAt,
    messages: async (from, to, limit) => {
      const out: HistoryRecord[] = [];
      for (let i = lowerBound(cols, from); i < n && cols.seq[i] <= to && out.length < limit; i++) {
        const [seq, at, msg] = p.messages[i];
        out.push({ seq, at, msg });
      }
      return out;
    },
    live: async () => ({ ...end, seq: last, history: status }),
  };
}

/** Decodes the embedded payload, installs it as the history and code source, and opens rewound at its end. */
export async function bootExport(el: Element): Promise<void> {
  const p = await decodePayload(el.textContent ?? '');
  const src = embeddedSource(p);
  setHistorySource(src);
  setEmbeddedCode(p.code ?? null);
  useStore.setState({ replay: true, historyStatus: src.status });
  useStore.getState().rewind(await src.stateAt(src.status.last));
}
