// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SummaryStatus } from '@shared/summaries.js';
import { useStore } from '../store';
import { emptyDomain, file } from '../fixtures';
import { AskView, useAsk } from './Ask';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READY: SummaryStatus = { state: 'ready', provider: 'anthropic', model: 'claude-haiku-5-5', usedTokens: 0, capTokens: 2_000_000, month: '2026-10' };
let host: HTMLDivElement;
let root: Root;
let posted: unknown[];

function mount(status: SummaryStatus, reply: { status: number; body: unknown }) {
  posted = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(init.body as string));
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  });
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] }, summaries: { status, files: {} },
  });
  act(() => root.render(<AskView />));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  useAsk.setState({ items: [], about: null, draft: '' });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('AskView', () => {
  it('explains how to turn AI on when it is off', () => {
    mount({ ...READY, state: 'off' }, { status: 200, body: {} });
    expect(host.textContent).toContain('AI is off');
    expect(host.textContent).not.toContain('config.json');
    const open = [...host.querySelectorAll('button')].find(b => b.textContent === 'Open Settings')!;
    act(() => open.click());
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('posts the question with the file it is about and renders the answer with clickable file refs', async () => {
    mount(READY, { status: 200, body: { answer: 'It is in `src/a.ts`:\n- step one\n- step two' } });
    act(() => useAsk.getState().setAbout('src/a.ts'));
    await act(async () => { useAsk.getState().ask('What does it do?'); });
    expect(posted).toEqual([{ question: 'What does it do?', path: 'src/a.ts' }]);
    expect(host.querySelector('.ask-q')!.textContent).toContain('What does it do?');
    expect(host.querySelectorAll('.ask-a li')).toHaveLength(2);
    act(() => host.querySelector<HTMLButtonElement>('.ask-ref')!.click());
    expect(useStore.getState().selected).toBe('src/a.ts');
  });

  it('shows the provider error with a hint instead of nothing', async () => {
    mount(READY, { status: 502, body: { error: '401 unauthorized' } });
    await act(async () => { useAsk.getState().ask('Why?'); });
    expect(host.querySelector('.ask-a.err')!.textContent).toContain('401 unauthorized');
    expect(host.querySelector('.ask-a.err')!.textContent).toContain('Check the API key');
  });
});
