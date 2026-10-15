// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { emptyDomain, file } from '../fixtures';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn(), fetchFile: vi.fn(() => new Promise(() => {})) }));
// A fresh Inspector module per file: its file view has not loaded yet.
const mod = await import('./Inspector');
const { Inspector, detailLoader } = mod;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  useStore.getState().reset();
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts'), file('src/b.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the file view fails to load', () => {
  it('shows a message with Retry, retries on the next selection of any file (the same one too), and recovers', async () => {
    const real = detailLoader.load;
    const load = vi.fn<typeof real>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(real);
    detailLoader.load = load;

    await act(async () => { root.render(<Inspector />); });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    act(() => useStore.getState().select('src/a.ts'));
    await flush();
    // The mount load failed; this selection tried again and failed too.
    expect(load).toHaveBeenCalledTimes(2);
    const alert = () => host.querySelector('.ins-scroll:not(.leave) [role=alert]');
    expect(alert()?.textContent).toContain('Could not load the file view.');

    // Selecting the same file again retries (and succeeds).
    act(() => useStore.getState().select('src/a.ts'));
    await act(async () => { await mod.loadDetail(); });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(alert()).toBeNull();
    expect(host.querySelector('.ins-scroll:not(.leave) h3')?.textContent).toBe('a.ts');
    detailLoader.load = real;
  });

  it('the Retry button tries again', async () => {
    // The module already loaded the view in the test above; a fresh state needs a fresh module.
    vi.resetModules();
    const fresh = await import('./Inspector');
    const { useStore: store } = await import('../store');
    store.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
      events: [], sessions: [], control: { paused: false, flags: [] },
    });
    const real = fresh.detailLoader.load;
    fresh.detailLoader.load = vi.fn<typeof real>().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockImplementation(real);
    await act(async () => { root.render(<fresh.Inspector />); });
    act(() => store.getState().select('src/a.ts'));
    await flush();
    const retry = host.querySelector<HTMLButtonElement>('.ins-scroll:not(.leave) [role=alert] button')!;
    expect(retry.textContent).toBe('Retry');
    act(() => retry.click());
    await act(async () => { await fresh.loadDetail(); });
    await flush();
    expect(host.querySelector('.ins-scroll:not(.leave) h3')?.textContent).toBe('a.ts');
  });
});
