// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { emptyDomain } from '../fixtures';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn() }));
const api = await import('../api');
const { PauseButton, ProjectChip } = await import('./Toolbar');

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

describe('ProjectChip', () => {
  const chip = () => host.querySelector('button.projsel') as HTMLButtonElement;
  const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const realExec = document.execCommand;
  const setClipboard = (writeText: ((t: string) => Promise<void>) | undefined) =>
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText ? { writeText } : undefined });
  const hello = () => useStore.getState().apply({
    type: 'hello', root: '/home/dev/code/shop', name: 'shop', files: [], changes: [], usedBy: [], domain: emptyDomain(),
    indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
  });
  afterEach(() => {
    if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
    document.execCommand = realExec;
  });

  it('shows the project name and its folder, with no menu chevron', () => {
    hello();
    act(() => root.render(<ProjectChip />));
    expect(chip().querySelector('.pn')!.textContent).toBe('shop');
    expect(chip().querySelector('small')!.textContent).toBe('~/code');
    expect(chip().querySelector('svg')).toBeNull();
    expect(chip().getAttribute('aria-haspopup')).toBeNull();
    expect(chip().getAttribute('aria-label')).toBe('shop, copy project path');
    expect(chip().title).toBe('/home/dev/code/shop · click to copy');
  });

  it('copies the root path and says so', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard(writeText);
    hello();
    act(() => root.render(<ProjectChip />));
    await act(async () => chip().click());
    expect(writeText).toHaveBeenCalledWith('/home/dev/code/shop');
    expect(useStore.getState().toast).toMatchObject({ text: 'Path copied', tone: 'info' });
  });

  it('falls back to a selected hidden field when the Clipboard API fails', async () => {
    setClipboard(vi.fn(async () => { throw new Error('denied'); }));
    let copied = '';
    document.execCommand = vi.fn(() => { copied = (document.activeElement as HTMLInputElement).value; return true; });
    hello();
    act(() => root.render(<ProjectChip />));
    await act(async () => chip().click());
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('/home/dev/code/shop');
    expect(useStore.getState().toast).toMatchObject({ text: 'Path copied' });
    // The helper field is gone and focus is back on the chip.
    expect(document.querySelectorAll('textarea, input').length).toBe(0);
    expect(document.activeElement).toBe(chip());
  });

  it("shows \"Couldn't copy path\" when nothing can copy", async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    hello();
    act(() => root.render(<ProjectChip />));
    await act(async () => chip().click());
    expect(useStore.getState().toast).toMatchObject({ text: "Couldn't copy path", tone: 'error' });
  });
});
