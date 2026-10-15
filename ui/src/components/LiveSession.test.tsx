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
