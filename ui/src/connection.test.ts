// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
}
const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

async function start(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const conn = await import('./connection');
  const { useStore } = await import('./store');
  conn.connect();
  return { conn, useStore };
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connect', () => {
  it('takes ?t=, strips it from the address bar, and uses it for the socket and API', async () => {
    const { conn } = await start('?t=abc123&keep=1#x');
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#x');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(last().url).toBe(`ws://${window.location.host}/ws?t=abc123`);
    expect(conn.authHeaders()).toEqual({ 'x-livemap-token': 'abc123' });
  });

  it('keeps the token in sessionStorage so a reload without ?t= still connects', async () => {
    await start('?t=abc123');
    const { conn } = await start('');
    expect(last().url).toBe(`ws://${window.location.host}/ws?t=abc123`);
    expect(conn.authHeaders()).toEqual({ 'x-livemap-token': 'abc123' });
  });

  it('reports unauthorized without opening a socket when there is no token at all', async () => {
    const { useStore } = await start('');
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(useStore.getState().connection).toBe('unauthorized');
  });

  it('a new ?t= replaces the stored token', async () => {
    await start('?t=old');
    const { conn } = await start('?t=new');
    expect(conn.authHeaders()).toEqual({ 'x-livemap-token': 'new' });
    expect(window.sessionStorage.getItem('livemap.token')).toBe('new');
  });

  it('reconnects with backoff 0.5 s doubling to a 5 s cap, and resets after a successful open', async () => {
    const { useStore } = await start('?t=k');
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = FakeWebSocket.instances.length;
      last().onclose!({ code: 1006 });
      expect(useStore.getState().connection).toBe('closed');
      let waited = 0;
      while (FakeWebSocket.instances.length === before) { vi.advanceTimersByTime(50); waited += 50; }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);

    last().onopen!();
    expect(useStore.getState().connected).toBe(true);
    const before = FakeWebSocket.instances.length;
    last().onclose!({ code: 1006 });
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it('never retries after close code 4401 and reports unauthorized', async () => {
    const { useStore } = await start('?t=bad');
    last().onclose!({ code: 4401 });
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(useStore.getState().connection).toBe('unauthorized');
    expect(useStore.getState().connected).toBe(false);
  });

  it('feeds messages to the store and ignores malformed ones', async () => {
    const { useStore } = await start('?t=k');
    last().onopen!();
    last().onmessage!({ data: 'not json' });
    last().onmessage!({ data: JSON.stringify({ type: 'hello', root: '/p/x', name: 'x', files: [], changes: [], usedBy: [], indexing: false }) });
    expect(useStore.getState().loaded).toBe(true);
    expect(useStore.getState().name).toBe('x');
  });
});
