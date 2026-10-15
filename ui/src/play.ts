import { historySource, type HistoryRecord, type HistorySource } from './history';
import { setPlayEngine, useStore } from './store';

const FAILED_START = 'Could not load the history to play. Try again.';
const FAILED_PAGE = 'Playback stopped: the history could not be read.';

// The playback engine. Loaded on the first Play, so the first paint does not carry it.

export const PLAY_PAGE = 500;
export const PLAY_SPEED = 8;
export const PLAY_MAX_GAP_MS = 400;

/** The wait before a played record: its real gap, eight times faster, at most 400 ms. */
export const playGap = (prevAt: number, at: number): number => Math.min(PLAY_MAX_GAP_MS, Math.max(0, (at - prevAt) / PLAY_SPEED));

/**
 * Plays recorded messages after `from` in time order, in pages of 500, each after its compressed gap.
 * Calls `live` once the cursor reaches `end()` (the newest recorded seq) or history runs out, and
 * `failed` when a page cannot be read. Returns stop.
 */
export function play(
  source: HistorySource, from: { seq: number; at: number }, end: () => number,
  hooks: { apply(rec: HistoryRecord): void; live(): void; failed?(): void },
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A stopped sleep never wakes: the loop is dropped with it.
  const sleep = (ms: number) => new Promise<void>(r => { timer = setTimeout(r, ms); });
  void (async () => {
    let cursor = from.seq;
    let prevAt = from.at;
    try {
      while (!stopped) {
        const to = end();
        const page = cursor < to ? await source.messages(cursor + 1, to, PLAY_PAGE) : [];
        if (stopped) return;
        if (!page.length) return hooks.live();
        for (const rec of page) {
          const gap = playGap(prevAt, rec.at);
          if (gap >= 1) await sleep(gap);
          if (stopped) return;
          hooks.apply(rec);
          prevAt = rec.at;
          cursor = rec.seq;
        }
      }
    } catch {
      if (!stopped) hooks.failed?.();
    }
  })();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Starts the timeline's playback: from the rewound point, or from the start of the current run when live
 * (a replay at its end starts over from the first recorded event).
 * Gives up (null) when `current()` turns false while the first state loads, or when it cannot load (with an
 * error toast). The engine's end returns to live (whose `playing: false` stops it); a failed page shows an
 * error toast and calls `failed`.
 */
export async function startPlayback(current: () => boolean, failed: () => void): Promise<(() => void) | null> {
  const st = useStore.getState();
  // A replay sits at its end: Play starts it over.
  let from = st.replay && st.rewound?.seq === st.historyStatus.last ? null : st.rewound;
  if (!from) {
    try {
      let start = st.historyStatus.first;
      if (!st.replay) {
        const runs = (await historySource().info()).runs;
        if (!current()) return null;
        start = runs[runs.length - 1]?.firstSeq ?? start;
      }
      const first = await historySource().stateAt(start);
      if (!current()) return null;
      st.rewind(first);
      from = { seq: first.seq, at: first.at };
    } catch {
      // Say why Play went back to idle, unless something else stopped it meanwhile.
      if (current()) st.showToast(FAILED_START, 'error');
      return null;
    }
  }
  st.setPlaying(true);
  const stop = play(historySource(), from, () => useStore.getState().historyStatus.last, {
    apply: rec => useStore.getState().applyHistorical(rec),
    live: () => void useStore.getState().backToLive(),
    failed: () => {
      useStore.getState().showToast(FAILED_PAGE, 'error');
      failed();
    },
  });
  setPlayEngine(stop);
  return stop;
}
