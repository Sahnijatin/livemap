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
const { LiveSession } = await import('./LiveSession');

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
