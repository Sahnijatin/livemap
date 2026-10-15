// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyMessage, emptyState, type ProjectState } from '@shared/state.js';
import { bucketTicks, kindOf } from '@shared/history.js';
import type { ExportPayload } from '@shared/export.js';
import type { ServerMessage } from '@shared/protocol.js';
import { useStore } from './store';
import { historySource, restHistorySource, setEmbeddedCode, setHistorySource } from './history';
import { change, event, file } from './fixtures';

vi.mock('./highlight', () => ({ MAX_HIGHLIGHT_LINES: 5000, highlight: async () => null }));
vi.mock('./api', () => ({ ApiError: class extends Error {}, addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn() }));
const { bootExport, decodePayload, embeddedSource } = await import('./exportBoot');
const { CodeView } = await import('./components/CodeView');
const { PauseButton, StatusChip } = await import('./components/Toolbar');
const { FlagBox } = await import('./components/FlagBox');
const { RewoundBanner } = await import('./components/Timeline');
const { StackView } = await import('./components/StackView');
const { AgentChips } = await import('./components/AgentChips');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.UTC(2026, 9, 15, 9, 0);

/** A payload of `n` messages after a start hello: changes, events, and a second run's hello at 700. */
function payload(n: number, code?: Record<string, string>): ExportPayload {
  const start: ProjectState = { ...emptyState('shop', 'shop'), files: [file('a.ts'), file('b.ts')] };
  const messages: ExportPayload['messages'] = [[1, T0, { type: 'hello', ...start }]];
  for (let i = 2; i <= n; i++) {
    let msg: ServerMessage;
    if (i === 700) msg = { type: 'hello', ...start, files: [file('c.ts')] };
    else if (i % 10 === 0) msg = { type: 'change', change: change(i % 20 ? 'a.ts' : 'b.ts'), files: [file(i % 20 ? 'a.ts' : 'b.ts', [], { lines: i })], removed: [] };
    else msg = { type: 'agentEvent', event: event({ id: i, type: i % 3 ? 'message' : 'tool_start' }) };
    messages.push([i, T0 + i * 1000, msg]);
  }
  return { version: 1, name: 'shop', exportedAt: T0, initial: emptyState('shop', 'shop'), messages, ...(code ? { code } : {}) };
}

async function encode(p: ExportPayload): Promise<string> {
  const gz = await new Response(new Response(JSON.stringify(p)).body!.pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return Buffer.from(gz).toString('base64');
}

const replay = (p: ExportPayload, seq: number): ProjectState => {
  let s = p.initial;
  for (const [q, , m] of p.messages) if (q <= seq) s = applyMessage(s, m);
  return s;
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setHistorySource(restHistorySource);
  setEmbeddedCode(undefined);
});

describe('decodePayload', () => {
  it('reads the base64 gzip JSON back', async () => {
    const p = payload(30);
    expect(await decodePayload(`\n${await encode(p)}\n`)).toEqual(p);
  });
});

describe('embeddedSource', () => {
  const p = payload(1300);
  const src = embeddedSource(p);

  it('replays the state at any seq from the initial state', async () => {
    for (const seq of [1, 2, 499, 500, 501, 699, 700, 701, 1000, 1299, 1300]) {
      const st = await src.stateAt(seq);
      const { seq: s, at, ...state } = st;
      expect(s).toBe(seq);
      expect(at).toBe(T0 + (seq === 1 ? 0 : seq * 1000));
      expect(state).toEqual(replay(p, seq));
    }
  });

  it('buckets ticks as the server does, with run starts', async () => {
    const cols = { length: p.messages.length, seq: p.messages.map(m => m[0]), at: p.messages.map(m => m[1]), kind: p.messages.map(m => kindOf(m[2])) };
    expect(await src.ticks(80)).toEqual(bucketTicks(cols, 80, [1, 700]));
  });

  it('pages messages and reports info; live is the end state', async () => {
    const page = await src.messages(10, 20, 5);
    expect(page.map(r => r.seq)).toEqual([10, 11, 12, 13, 14]);
    expect(page[0].msg).toEqual(p.messages[9][2]);
    expect(await src.info()).toMatchObject({ enabled: true, first: 1, last: 1300, firstAt: T0, lastAt: T0 + 1300_000 });
    const live = await src.live();
    expect(live.seq).toBe(1300);
    expect(live.files.map(f => f.path)).toEqual(replay(p, 1300).files.map(f => f.path));
  });
});

describe('bootExport', () => {
  it('installs the embedded history and opens rewound at the end, in replay mode', async () => {
    const el = document.createElement('script');
    el.textContent = await encode(payload(40, { 'a.ts': 'const a = 1;\n' }));
    await bootExport(el);
    const st = useStore.getState();
    expect(st.replay).toBe(true);
    expect(st.loaded).toBe(true);
    expect(st.rewound).toEqual({ seq: 40, at: T0 + 40_000 });
    expect(st.historyStatus).toMatchObject({ enabled: true, first: 1, last: 40 });
    expect(historySource()).not.toBe(restHistorySource);
  });

  it('Back to live in replay returns to the end state, still rewound', async () => {
    const el = document.createElement('script');
    el.textContent = await encode(payload(40));
    await bootExport(el);
    useStore.getState().rewind(await historySource().stateAt(5));
    await useStore.getState().backToLive();
    expect(useStore.getState().rewound).toEqual({ seq: 40, at: T0 + 40_000 });
  });
});

describe('replay mode UI', () => {
  async function boot(code?: Record<string, string>) {
    const el = document.createElement('script');
    el.textContent = await encode(payload(40, code));
    await bootExport(el);
  }

  it('shows Replay in place of the live status and hides Pause, Flag and Back to live', async () => {
    await boot();
    act(() => root.render(<><StatusChip /><PauseButton /><FlagBox target={null} /><RewoundBanner /></>));
    expect(host.querySelector('.statuschip')!.textContent).toBe('Replay');
    expect(host.querySelector('button.pause')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).not.toContain('Back to live');
    expect(host.textContent).toContain('Changes made since then are hidden.');
  });

  it('shows embedded code without a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await boot({ 'a.ts': 'const embedded = 1;\n' });
    await act(async () => root.render(<CodeView file={file('a.ts')} change={undefined} />));
    expect(host.querySelector('pre.code')!.textContent).toContain('const embedded = 1;');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('notes the code is as of the export, not current', async () => {
    await boot({ 'a.ts': 'const embedded = 1;\n' });
    await act(async () => root.render(<CodeView file={file('a.ts')} change={undefined} />));
    expect(host.querySelector('.code-past')!.textContent).toBe('Code as of the export.');
    expect(host.textContent).not.toContain('Current code');
  });

  it('a live rewound view keeps the Current code note', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    useStore.getState().rewind({ ...emptyState('shop', 'shop'), files: [file('a.ts')], seq: 3, at: T0 });
    await act(async () => root.render(<CodeView file={file('a.ts')} change={undefined} />));
    expect(host.querySelector('.code-past')!.textContent).toBe('Current code. Past file contents are not stored.');
    fetchSpy.mockRestore();
  });

  it('hides the AI summaries box, so the exporter\'s provider, model, use and config link never show', async () => {
    await boot();
    const ready = { state: 'ready' as const, provider: 'anthropic' as const, model: 'secret-model', usedTokens: 5, capTokens: 100, month: '2026-10' };
    act(() => useStore.setState({ summaries: { status: ready, files: {} } }));
    act(() => root.render(<StackView />));
    expect(host.querySelector('.b-ai')).toBeNull();
    expect(host.textContent).not.toContain('AI summaries');
    expect(host.textContent).not.toContain('secret-model');
    expect(host.textContent).not.toContain('Copy an example config');
  });

  it('shows no agent chips, so nothing says not connected', async () => {
    await boot();
    const now = Date.now();
    act(() => useStore.setState({ sessions: { s1: { id: 's1', agent: 'claude-code', title: 't', cwd: '/p', startedAt: now - 1000, lastAt: now, status: 'working', hooks: false } } }));
    act(() => root.render(<AgentChips />));
    expect(host.querySelector('.agentchips')).toBeNull();
    expect(host.textContent).not.toContain('not connected');
  });

  it('says the code is not included when the export has none', async () => {
    await boot();
    await act(async () => root.render(<CodeView file={file('a.ts')} change={undefined} />));
    expect(host.textContent).toContain('Code not included in this export');
  });
});
