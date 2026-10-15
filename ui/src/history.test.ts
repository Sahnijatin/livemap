import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServerMessage } from '@shared/protocol.js';
import { dominantKind, latestThrottle, STATE_THROTTLE_MS, type HistorySource } from './history';
import { playGap, play } from './play';

afterEach(() => vi.useRealTimers());

const counts = (c: Partial<Record<'prompt' | 'message' | 'tool' | 'change' | 'commit' | 'other', number>>) =>
  ({ prompt: 0, message: 0, tool: 0, change: 0, commit: 0, other: 0, ...c });

describe('dominantKind', () => {
  it('picks the kind with the most events', () => {
    expect(dominantKind(counts({ tool: 5, change: 2, prompt: 1 }))).toBe('tool');
    expect(dominantKind(counts({ message: 1, commit: 3 }))).toBe('commit');
    expect(dominantKind(counts({ change: 4, other: 9 }))).toBe('change');
  });
  it('is other when only uncolored records fall in the bucket, and null when it is empty', () => {
    expect(dominantKind(counts({ other: 2 }))).toBe('other');
    expect(dominantKind(counts({}))).toBeNull();
  });
});

describe('latestThrottle', () => {
  it('fetches at most once per 120 ms, with the newest seq trailing', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((seq: number) => Promise.resolve(seq));
    const apply = vi.fn();
    const t = latestThrottle(fetch, apply);
    t.request(1);
    t.request(2);
    t.request(3);
    expect(fetch.mock.calls).toEqual([[1]]);
    await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.mock.calls).toEqual([[1], [3]]);
    expect(apply.mock.calls).toEqual([[1], [3]]);
  });

  it('an older response never overrides a newer one', async () => {
    vi.useFakeTimers();
    const resolvers = new Map<number, (v: number) => void>();
    const fetch = vi.fn((seq: number) => new Promise<number>(r => resolvers.set(seq, r)));
    const apply = vi.fn();
    const t = latestThrottle(fetch, apply);
    t.request(10);
    await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS);
    t.request(20);
    expect(fetch.mock.calls).toEqual([[10], [20]]);
    resolvers.get(20)!(20); // the newer answer arrives first
    await vi.advanceTimersByTimeAsync(0);
    resolvers.get(10)!(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply.mock.calls).toEqual([[20]]);
  });

  it('reports a failure of the newest request to the error callback, not of a superseded or cancelled one', async () => {
    vi.useFakeTimers();
    const rejecters = new Map<number, (e: Error) => void>();
    const fetch = vi.fn((seq: number) => new Promise<number>((_r, j) => rejecters.set(seq, j)));
    const apply = vi.fn();
    const onError = vi.fn();
    const t = latestThrottle(fetch, apply, STATE_THROTTLE_MS, onError);
    t.request(10);
    await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS);
    t.request(20);
    rejecters.get(10)!(new Error('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    rejecters.get(20)!(new Error('new'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS);
    t.request(30);
    t.cancel();
    rejecters.get(30)!(new Error('cancelled'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it('cancel drops pending and in-flight requests', async () => {
    vi.useFakeTimers();
    let resolve!: (v: number) => void;
    const fetch = vi.fn((_seq: number) => new Promise<number>(r => { resolve = r; }));
    const apply = vi.fn();
    const t = latestThrottle(fetch, apply);
    t.request(1);
    t.request(2);
    t.cancel();
    resolve(1);
    await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('play', () => {
  it('compresses gaps eight times, capped at 400 ms', () => {
    expect(playGap(1000, 1800)).toBe(100);
    expect(playGap(0, 60_000)).toBe(400);
    expect(playGap(500, 400)).toBe(0);
  });

  it('applies pages of messages in order and returns to live at the end', async () => {
    vi.useFakeTimers();
    const msg = (n: number): ServerMessage => ({ type: 'usedBy', usedBy: [{ file: `f${n}`, symbol: 's', usedIn: [] }] });
    const pages = [
      [{ seq: 6, at: 1800, msg: msg(6) }, { seq: 7, at: 1800, msg: msg(7) }],
      [{ seq: 8, at: 2600, msg: msg(8) }],
    ];
    const messages = vi.fn(async () => pages.shift() ?? []);
    const source = { messages } as unknown as HistorySource;
    const applied: number[] = [];
    const live = vi.fn();
    play(source, { seq: 5, at: 1000 }, () => 8, { apply: r => applied.push(r.seq), live });
    await vi.advanceTimersByTimeAsync(0);
    expect(messages).toHaveBeenCalledWith(6, 8, 500);
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(applied).toEqual([6, 7]);
    await vi.advanceTimersByTimeAsync(100);
    expect(applied).toEqual([6, 7, 8]);
    expect(messages).toHaveBeenLastCalledWith(8, 8, 500);
    expect(messages).toHaveBeenCalledTimes(2); // seq 8 is the live end: no further page
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('stop ends playback without returning to live', async () => {
    vi.useFakeTimers();
    const messages = vi.fn(async () => [{ seq: 6, at: 9000, msg: { type: 'usedBy', usedBy: [] } as ServerMessage }]);
    const applied: number[] = [];
    const live = vi.fn();
    const stop = play({ messages } as unknown as HistorySource, { seq: 5, at: 1000 }, () => 100, { apply: r => applied.push(r.seq), live });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(applied).toEqual([]);
    expect(live).not.toHaveBeenCalled();
  });
});
