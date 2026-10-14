// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn() }));
const api = await import('../api');
const { PauseButton } = await import('./Toolbar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const button = () => host.querySelector('button.pause') as HTMLButtonElement;
const click = async () => { await act(async () => button().click()); };

beforeEach(() => {
  useStore.getState().reset();
  vi.mocked(api.setPaused).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PauseButton', () => {
  it('pauses, reads Resume agent while paused, and resumes', async () => {
    vi.mocked(api.setPaused).mockResolvedValue();
    act(() => root.render(<PauseButton />));
    expect(button().textContent).toBe('Pause agent');
    await click();
    expect(api.setPaused).toHaveBeenLastCalledWith(true);
    act(() => useStore.getState().apply({ type: 'control', control: { paused: true, flags: [] } }));
    expect(button().textContent).toBe('Resume agent');
    expect(button().classList.contains('on')).toBe(true);
    await click();
    expect(api.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('shows a failure inline next to the button and clears it on the next attempt', async () => {
    vi.mocked(api.setPaused).mockRejectedValueOnce(new Error('Agent activity is not available'));
    act(() => root.render(<PauseButton />));
    await click();
    const alert = host.querySelector('.pausewrap [role="alert"]');
    expect(alert?.textContent).toBe('Agent activity is not available');
    expect(useStore.getState().toast).toBeNull();

    let resolve!: () => void;
    vi.mocked(api.setPaused).mockReturnValueOnce(new Promise<void>(r => { resolve = r; }));
    act(() => button().click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button().disabled).toBe(true);
    await act(async () => resolve());
    expect(button().disabled).toBe(false);
  });
});
