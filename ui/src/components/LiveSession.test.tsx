// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Flag } from '@shared/types.js';
import { useStore } from '../store';
import { READ_ONLY_TIP } from '../history';

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return { ApiError, addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn() };
});
const api = await import('../api');
const { LiveHead, LiveSession } = await import('./LiveSession');
const { session } = await import('../fixtures');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const flag: Flag = { id: 7, target: null, note: 'Use zod', createdAt: 1 };
const removeBtn = () => host.querySelector('button.fl-x') as HTMLButtonElement | null;

beforeEach(() => {
  useStore.getState().reset();
  vi.mocked(api.removeFlag).mockReset();
  vi.mocked(api.removeFlag).mockResolvedValue(undefined as never);
  useStore.getState().apply({ type: 'control', control: { paused: false, flags: [flag] } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('LiveSession flags', () => {
  it('removes a pending flag when live', () => {
    act(() => root.render(<LiveSession />));
    const btn = removeBtn()!;
    expect(btn.disabled).toBe(false);
    act(() => btn.click());
    expect(api.removeFlag).toHaveBeenCalledWith(7);
  });

  it('shows the latest commits, newest first, without merges, apart from agent events', () => {
    const now = Date.now();
    const commit = (id: number, text: string, extra: object = {}) =>
      ({ id, agent: 'git' as const, sessionId: 'Ada Park', at: now - 60_000 + id, type: 'commit' as const, text, paths: ['a.ts', 'b.ts'], ...extra });
    useStore.getState().apply({ type: 'agentEvents', events: [
      commit(1, 'Add login form\n\nBody'),
      commit(2, 'Merge pull request #12 from acme/login', { merge: true }),
      commit(3, 'Fix typo', { paths: ['c.ts'] }),
    ] });
    act(() => root.render(<LiveSession />));
    const rows = [...host.querySelectorAll('.gitlist .gitrow')];
    expect(rows.map(r => r.querySelector('b')?.textContent)).toEqual(['Fix typo', 'Add login form']);
    expect(rows[0].textContent).toContain('Ada Park');
    expect(rows[0].textContent).toContain('1 file');
    expect(rows[1].textContent).toContain('2 files');
    expect(rows[0].textContent).toContain('1 min ago');
    expect(host.querySelector('.gitlist')?.closest('.sec')?.querySelector('h4')?.textContent).toBe('Recent commits');
  });

  it('orders recent commits by commit time, not arrival', () => {
    const now = Date.now();
    const c = (id: number, text: string, at: number) => ({ id, agent: 'git' as const, sessionId: 'Ada', at, type: 'commit' as const, text, merge: false });
    useStore.getState().apply({ type: 'agentEvents', events: [c(1, 'Newer', now - 1000), c(2, 'Older', now - 90_000)] });
    act(() => root.render(<LiveSession />));
    expect([...host.querySelectorAll('.gitrow b')].map(b => b.textContent)).toEqual(['Newer', 'Older']);
  });

  it('orders commits made in the same second newest first, by the order LiveMap read them', () => {
    const at = Math.floor(Date.now() / 1000) * 1000 - 5000;
    const c = (id: number, text: string) => ({ id, agent: 'git' as const, sessionId: 'dev.user1', at, type: 'commit' as const, text, merge: false });
    useStore.getState().apply({ type: 'agentEvents', events: [c(1, 'Add refund endpoint'), c(2, 'Feature work')] });
    act(() => root.render(<LiveSession />));
    expect([...host.querySelectorAll('.gitrow b')].map(b => b.textContent)).toEqual(['Feature work', 'Add refund endpoint']);
  });

  it('shows no commits section without commits', () => {
    act(() => root.render(<LiveSession />));
    expect(host.querySelector('.gitlist')).toBeNull();
  });

  it('makes the remove button read-only while rewound', () => {
    useStore.setState({ rewound: { seq: 1, at: 1 } });
    act(() => root.render(<LiveSession />));
    const btn = removeBtn()!;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(READ_ONLY_TIP);
    act(() => btn.click());
    expect(api.removeFlag).not.toHaveBeenCalled();
  });
});

describe('LiveHead', () => {
  const tag = () => host.querySelector('.livetag')?.textContent ?? null;

  it('shows Live while the agent works, Paused when paused, nothing when idle or rewound', () => {
    act(() => root.render(<LiveHead />));
    expect(tag()).toBeNull();
    act(() => useStore.getState().apply({ type: 'session', session: session({ id: 's1', status: 'working', hooks: true }) }));
    expect(tag()).toBe('Live');
    act(() => useStore.getState().apply({ type: 'control', control: { paused: true, flags: [] } }));
    expect(tag()).toBe('Paused');
    act(() => useStore.getState().apply({ type: 'control', control: { paused: false, flags: [] } }));
    act(() => useStore.setState({ rewound: { seq: 1, at: 1 } }));
    expect(tag()).toBeNull();
    act(() => useStore.setState({ rewound: null }));
    act(() => useStore.getState().apply({ type: 'session', session: session({ id: 's1', status: 'idle', hooks: true }) }));
    expect(tag()).toBeNull();
  });

  it('Message the agent sends a message (not a flag) and lists it as waiting for the turn to end', async () => {
    vi.mocked(api.addFlag).mockResolvedValue({ id: 9, target: null, note: 'Run the tests', createdAt: 2, kind: 'message' } as never);
    act(() => root.render(<LiveSession />));
    const box = host.querySelector('textarea[aria-label="Message for the agent"]') as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Run the tests');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...host.querySelectorAll('button')].find(b => b.textContent === 'Send')!;
    await act(async () => { send.click(); });
    expect(api.addFlag).toHaveBeenCalledWith(null, 'Run the tests', 'message');
    act(() => useStore.getState().apply({ type: 'control', control: { paused: false, flags: [flag, { id: 9, target: null, note: 'Run the tests', createdAt: 2, kind: 'message' }] } }));
    expect(host.textContent).toContain('Waiting for the agent to finish its turn');
    // The project flag box still shows only the flag.
    expect(host.querySelectorAll('.flag-pending')).toHaveLength(2);
  });
});
