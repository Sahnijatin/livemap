// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { emptyDomain, file } from '../fixtures';
import { Inspector } from './Inspector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  // The file pane's code view fetches the file; a request that never answers keeps its state updates out of these tests.
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Inspector transitions', () => {
  const panes = () => [...host.querySelectorAll<HTMLElement>('.ins-scroll')];

  it('cross-fades from Live session to a file and between files; the old content is unreachable while it fades', () => {
    act(() => root.render(<Inspector />));
    expect(panes()).toHaveLength(1);
    act(() => useStore.getState().select('src/a.ts'));
    expect(panes()).toHaveLength(2);
    const [old, cur] = panes();
    expect(old.classList.contains('leave')).toBe(true);
    expect(old.hasAttribute('inert')).toBe(true);
    expect(old.getAttribute('aria-hidden')).toBe('true');
    expect(cur.classList.contains('in')).toBe(true);
    expect(cur.querySelector('h3')!.textContent).toBe('a.ts');
    act(() => { vi.advanceTimersByTime(200); });
    expect(panes()).toHaveLength(1);
    expect(panes()[0].hasAttribute('inert')).toBe(false);

    act(() => useStore.getState().select('src/b.ts'));
    expect(panes().map(p => p.querySelector('h3')?.textContent)).toEqual(['a.ts', 'b.ts']);
    act(() => { vi.advanceTimersByTime(200); });
    expect(panes().map(p => p.querySelector('h3')?.textContent)).toEqual(['b.ts']);
  });

  it('keeps the leaving pane mounted rather than rebuilding it', () => {
    act(() => root.render(<Inspector />));
    act(() => useStore.getState().select('src/a.ts'));
    act(() => { vi.advanceTimersByTime(200); });
    const a = panes()[0];
    act(() => useStore.getState().select('src/b.ts'));
    expect(panes()[0]).toBe(a);
  });
});
