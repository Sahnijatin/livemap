// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Flag } from '@shared/types.js';
import { useStore } from '../store';

vi.mock('../api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return { ApiError, addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn() };
});
const api = await import('../api');
const { FlagBox } = await import('./FlagBox');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function setControl(flags: Flag[]) {
  useStore.getState().apply({ type: 'control', control: { paused: false, flags } });
}

function type(value: string) {
  const ta = host.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = () => host.querySelector('button.btn-red') as HTMLButtonElement;

async function submit() {
  await act(async () => {
    (host.querySelector('form') as HTMLFormElement).requestSubmit();
  });
}

beforeEach(() => {
  useStore.getState().reset();
  vi.mocked(api.addFlag).mockReset();
  vi.mocked(api.removeFlag).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('FlagBox', () => {
  it('submits the note for the file and clears the field', async () => {
    vi.mocked(api.addFlag).mockResolvedValue({ id: 1, target: 'src/a.ts', note: 'Use zod here', createdAt: 1 });
    act(() => root.render(<FlagBox target="src/a.ts" />));
    expect(button().textContent).toBe('Flag');
    type('Use zod here');
    await submit();
    expect(api.addFlag).toHaveBeenCalledWith('src/a.ts', 'Use zod here');
    expect(host.querySelector('textarea')!.value).toBe('');
  });

  it('does nothing for an empty note', async () => {
    act(() => root.render(<FlagBox target="src/a.ts" />));
    type('   ');
    await submit();
    act(() => button().click());
    expect(api.addFlag).not.toHaveBeenCalled();
  });

  it('offers Update flag while an undelivered flag exists and replaces it', async () => {
    setControl([{ id: 4, target: 'src/a.ts', note: 'Old note', createdAt: 1 }, { id: 5, target: 'src/b.ts', note: 'Other', createdAt: 1 }]);
    vi.mocked(api.removeFlag).mockResolvedValue();
    vi.mocked(api.addFlag).mockResolvedValue({ id: 6, target: 'src/a.ts', note: 'New note', createdAt: 2 });
    act(() => root.render(<FlagBox target="src/a.ts" />));
    expect(button().textContent).toBe('Update flag');
    expect(host.textContent).toContain("Waiting for the agent's next action");
    expect(host.textContent).toContain('Old note');
    type('New note');
    await submit();
    expect(api.removeFlag).toHaveBeenCalledWith(4);
    expect(api.addFlag).toHaveBeenCalledWith('src/a.ts', 'New note');
  });

  it('shows who received a delivered flag', () => {
    setControl([{ id: 4, target: 'src/a.ts', note: 'Old note', createdAt: 1, deliveredAt: Date.now() - 120_000, deliveredTo: { agent: 'codex', sessionId: 'x' } }]);
    act(() => root.render(<FlagBox target="src/a.ts" />));
    expect(button().textContent).toBe('Flag');
    expect(host.textContent).toContain('Delivered 2 min ago to Codex');
  });

  it('shows an inline error when the request fails', async () => {
    vi.mocked(api.addFlag).mockRejectedValue(new Error('Agent activity is not available'));
    act(() => root.render(<FlagBox target="src/a.ts" />));
    type('Use zod here');
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Agent activity is not available');
    expect(host.querySelector('textarea')!.value).toBe('Use zod here');
  });

  it('Update flag goes on when the old flag is already gone (404) but stops on any other remove error', async () => {
    setControl([{ id: 4, target: 'src/a.ts', note: 'Old note', createdAt: 1 }]);
    vi.mocked(api.addFlag).mockResolvedValue({ id: 6, target: 'src/a.ts', note: 'New', createdAt: 2 });
    vi.mocked(api.removeFlag).mockRejectedValueOnce(new api.ApiError('Not found', 404));
    act(() => root.render(<FlagBox target="src/a.ts" />));
    type('New');
    await submit();
    expect(api.addFlag).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    vi.mocked(api.removeFlag).mockRejectedValueOnce(new api.ApiError('Agent activity is not available', 503));
    type('Newer');
    await submit();
    expect(api.addFlag).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Agent activity is not available');
    expect(host.querySelector('textarea')!.value).toBe('Newer');
  });
});
