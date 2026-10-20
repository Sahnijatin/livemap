// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import type { SummaryStatus } from '@shared/summaries.js';
import { change, emptyDomain, file } from '../fixtures';
import { Inspector, loadDetail } from './Inspector';

// The file view loads after first paint in the app; load it up front so a selection renders at once.
await loadDetail();

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

describe('Inspector: In plain English', () => {
  const READY: SummaryStatus = { state: 'ready', provider: 'anthropic', model: 'claude-haiku-5-5', usedTokens: 0, capTokens: 2_000_000, month: '2026-10' };
  const block = () => host.querySelector<HTMLElement>('.ai');
  let summaryCalls: string[];

  /** /api/summary answers `status` (with `body`); other requests (the code view) never answer. */
  function serve(status: number, body: unknown = { pending: true }) {
    summaryCalls = [];
    vi.stubGlobal('fetch', (url: string) => {
      if (!url.startsWith('/api/summary')) return new Promise(() => {});
      summaryCalls.push(url);
      return Promise.resolve({ status, ok: status < 300, json: async () => body });
    });
  }
  function open(path: string, opts: { status?: SummaryStatus; files?: Record<string, { hash: string; summary: string }>; intent?: string } = {}) {
    const changes = opts.intent ? [change(path, 'modified', { attribution: { agent: 'claude-code', sessionId: 's', confidence: 'exact', intent: opts.intent } })] : [];
    useStore.getState().apply({
      type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts'), file('src/b.ts')], changes, usedBy: [], domain: emptyDomain(), indexing: false,
      events: [], sessions: [], control: { paused: false, flags: [] },
      summaries: { status: opts.status ?? { ...READY, state: 'off' }, files: opts.files ?? {} },
    });
    act(() => root.render(<Inspector />));
    act(() => useStore.getState().select(path));
    act(() => { vi.advanceTimersByTime(200); });
  }

  beforeEach(() => serve(202));

  it('shows the file summary as plain text under the heading', () => {
    open('src/a.ts', { status: READY, files: { 'src/a.ts': { hash: 'h', summary: 'Adds <b>two</b> numbers.' } }, intent: 'Add a helper' });
    expect(block()!.querySelector('small')!.textContent).toContain('In plain English');
    expect(block()!.textContent).toContain('Adds <b>two</b> numbers.');
    expect(block()!.querySelector('b')).toBeNull();
    expect(block()!.textContent).not.toContain("In the agent's words");
    expect(summaryCalls).toHaveLength(0);
  });

  it("falls back to the latest change's intent, in the agent's words", () => {
    open('src/a.ts', { intent: 'Add a helper for totals' });
    expect(block()!.textContent).toContain('In plain English');
    expect(block()!.querySelector('.ai-src')!.textContent).toBe("In the agent's words");
    expect(block()!.textContent).toContain('Add a helper for totals');
    expect(summaryCalls).toHaveLength(0); // summaries are off
  });

  it('hides the block when there is neither a summary nor an intent', () => {
    open('src/a.ts');
    expect(block()).toBeNull();
  });

  it('requests a summary once on first view, shimmers while pending, then shows it', async () => {
    open('src/a.ts', { status: READY, intent: 'Add a helper' });
    await act(async () => {});
    expect(summaryCalls).toEqual(['/api/summary?path=src%2Fa.ts']);
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => useStore.getState().apply({ type: 'fileSummary', path: 'src/a.ts', hash: 'h', summary: 'Sums order totals.' }));
    expect(block()!.querySelector('[aria-busy="true"]')).toBeNull();
    expect(block()!.textContent).toContain('Sums order totals.');
    act(() => useStore.getState().select('src/b.ts'));
    act(() => useStore.getState().select('src/a.ts'));
    await act(async () => {});
    expect(summaryCalls.filter(u => u.includes('src%2Fa.ts'))).toHaveLength(1);
  });

  it('stops shimmering after 60 s and shows the fallback', async () => {
    open('src/a.ts', { status: READY, intent: 'Add a helper' });
    await act(async () => {});
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(59_000); });
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1_100); });
    expect(block()!.querySelector('[aria-busy="true"]')).toBeNull();
    expect(block()!.querySelector('.ai-src')!.textContent).toBe("In the agent's words");
  });

  it('does not shimmer at the cap, where no new summary is written', async () => {
    open('src/a.ts', { status: { ...READY, state: 'cap' }, intent: 'Add a helper' });
    await act(async () => {});
    expect(summaryCalls).toHaveLength(1); // a cached summary may still come back
    expect(block()!.querySelector('[aria-busy="true"]')).toBeNull();
    expect(block()!.querySelector('.ai-src')!.textContent).toBe("In the agent's words");
  });

  it('withdraws a summary on a clear, then asks again and shimmers', async () => {
    open('src/a.ts', { status: READY, files: { 'src/a.ts': { hash: 'h1', summary: 'Old words.' } }, intent: 'Add a helper' });
    await act(async () => {});
    expect(block()!.textContent).toContain('Old words.');
    expect(summaryCalls).toHaveLength(0);
    act(() => useStore.getState().apply({ type: 'fileSummary', path: 'src/a.ts', hash: '', summary: '' }));
    await act(async () => {});
    expect(block()!.textContent).not.toContain('Old words.');
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(summaryCalls).toEqual(['/api/summary?path=src%2Fa.ts']);
    act(() => useStore.getState().apply({ type: 'fileSummary', path: 'src/a.ts', hash: 'h2', summary: 'New words.' }));
    expect(block()!.textContent).toContain('New words.');
  });

  it('after a clear at the cap, falls back to the agent\'s words and still asks again', async () => {
    open('src/a.ts', { status: { ...READY, state: 'cap' }, files: { 'src/a.ts': { hash: 'h1', summary: 'Old words.' } }, intent: 'Add a helper' });
    act(() => useStore.getState().apply({ type: 'fileSummary', path: 'src/a.ts', hash: '', summary: '' }));
    await act(async () => {});
    expect(block()!.textContent).not.toContain('Old words.');
    expect(block()!.querySelector('.ai-src')!.textContent).toBe("In the agent's words");
    expect(summaryCalls).toHaveLength(1);
  });

  it('a summary asked for before rewinding does not shimmer while rewound', async () => {
    open('src/a.ts', { status: READY, intent: 'Add a helper' });
    await act(async () => {});
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => useStore.getState().rewind({
      root: '/p/shop', name: 'shop', files: [file('src/a.ts'), file('src/b.ts')], changes: [change('src/a.ts', 'modified', { attribution: { agent: 'claude-code', sessionId: 's', confidence: 'exact', intent: 'Add a helper' } })],
      usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] }, seq: 3, at: 1,
    }));
    expect(block()!.querySelector('[aria-busy="true"]')).toBeNull();
    expect(block()!.querySelector('.ai-src')!.textContent).toBe("In the agent's words");
  });

  it('a failed summary stays visible with the reason and a retry, instead of vanishing', async () => {
    open('src/a.ts', { status: READY });
    await act(async () => {});
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
    act(() => useStore.getState().apply({ type: 'summaryStatus', status: { ...READY, state: 'error', error: '404 not found' } }));
    expect(block()!.querySelector('[aria-busy="true"]')).toBeNull();
    expect(block()!.textContent).toContain('Could not write a summary: 404 not found.');
    expect(block()!.textContent).toContain('Ask about this file');
    const retry = [...block()!.querySelectorAll('button')].find(b => b.textContent === 'Try again')!;
    await act(async () => { retry.click(); });
    expect(summaryCalls).toHaveLength(2);
    // The server queues it and says it is working: the shimmer is back.
    act(() => useStore.getState().apply({ type: 'summaryStatus', status: { ...READY, state: 'working' } }));
    expect(block()!.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('uses a cached summary from a 200 answer', async () => {
    serve(200, { summary: 'Cached words.', hash: 'h' });
    open('src/a.ts', { status: READY });
    await act(async () => {});
    expect(block()!.textContent).toContain('Cached words.');
    expect(useStore.getState().summaries.files['src/a.ts']).toEqual({ hash: 'h', summary: 'Cached words.' });
  });
});
