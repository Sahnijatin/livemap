// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Ticks } from '@shared/history.js';
import { useStore } from '../store';
import { restHistorySource, setHistorySource, STATE_THROTTLE_MS, type HistorySource } from '../history';
import { clock } from '../agents';
import { file, emptyDomain } from '../fixtures';
import { Timeline } from './Timeline';
import { FlagBox } from './FlagBox';
import { PauseButton, Toolbar } from './Toolbar';
import { LiveHead, LiveSession } from './LiveSession';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = new Date(2026, 9, 15, 10, 42).getTime();
const WIDTH = 300;
const status = { enabled: true, first: 1, last: 100, firstAt: T0, lastAt: T0 + 600_000 };
const zero = { prompt: 0, message: 0, tool: 0, change: 0, commit: 0, other: 0 };
const TICKS: Ticks = {
  from: 1, to: 100,
  buckets: [
    { seq: 1, at: T0, counts: { ...zero, prompt: 2, message: 1 } },
    { seq: 34, at: T0 + 60_000, counts: { ...zero } },
    { seq: 67, at: T0 + 120_000, counts: { ...zero, change: 3, tool: 1 } },
  ],
  runStarts: [1, 67],
};
const projectState = (files = [file('a.ts')]) => ({
  root: '/p/shop', name: 'shop', files, changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
});

let host: HTMLDivElement;
let root: Root;
let source: { [K in keyof HistorySource]: ReturnType<typeof vi.fn> };
const original = useStore.getState().backToLive;

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}
const flush = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ backToLive: original });
  useStore.getState().apply({ type: 'hello', ...projectState(), history: status, seq: 100 });
  source = {
    info: vi.fn(async () => ({ ...status, runs: [{ id: 'r1', firstSeq: 1, lastSeq: 100, startAt: T0 }], bytes: 0 })),
    ticks: vi.fn(async () => TICKS),
    stateAt: vi.fn(async (seq: number) => ({ ...projectState(), seq, at: T0 + seq * 1000 })),
    messages: vi.fn(async () => []),
    live: vi.fn(async () => ({ ...projectState(), seq: 100 })),
  };
  setHistorySource(source as unknown as HistorySource);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: WIDTH, bottom: 30, width: WIDTH, height: 30, x: 0, y: 0, toJSON: () => ({}) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setHistorySource(restHistorySource);
});

const track = () => host.querySelector('.track') as HTMLElement;
const thumb = () => host.querySelector('[role="slider"]') as HTMLElement;
const pointer = (type: string, x: number) => act(() => { track().dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, button: 0 })); });

describe('Timeline', () => {
  it('renders colored ticks for buckets with events and a separator per restart', async () => {
    render(<Timeline />);
    await flush();
    expect(source.ticks).toHaveBeenCalledWith(Math.floor(WIDTH / 3));
    const ticks = host.querySelectorAll('.tick');
    expect([...ticks].map(t => t.getAttribute('data-kind'))).toEqual(['prompt', 'change']);
    const runs = host.querySelectorAll('.tl-run');
    expect(runs).toHaveLength(1); // the first run's start is the left edge, not a restart
    expect(runs[0].getAttribute('title')).toBe('LiveMap restarted');
  });

  it('shows LIVE and a slider at the live end', async () => {
    render(<Timeline />);
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('LIVE');
    const s = thumb();
    expect(s.getAttribute('aria-valuemin')).toBe('1');
    expect(s.getAttribute('aria-valuemax')).toBe('100');
    expect(s.getAttribute('aria-valuenow')).toBe('100');
  });

  it('the End key calls backToLive', async () => {
    const backToLive = vi.fn(async () => {});
    useStore.setState({ backToLive });
    useStore.getState().rewind({ ...projectState(), seq: 40, at: T0 + 60_000 });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(backToLive).toHaveBeenCalledTimes(1);
  });

  it('arrow keys step by a bucket and Home goes to the first event', async () => {
    useStore.getState().rewind({ ...projectState(), seq: 34, at: T0 + 60_000 });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(source.stateAt).toHaveBeenLastCalledWith(67);
    await act(async () => { await new Promise(r => setTimeout(r, STATE_THROTTLE_MS + 10)); });
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(source.stateAt).toHaveBeenLastCalledWith(1);
    await flush();
  });

  it('Home from live keeps REWOUND and the aimed thumb while the state is pending', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    source.stateAt.mockImplementation(async (seq: number) => { await gate; return { ...projectState(), seq, at: T0 + seq * 1000 }; });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    await flush();
    expect(useStore.getState().rewound).toBeNull();
    expect(host.querySelector('.tl-state')!.textContent).toBe('REWOUND');
    expect(thumb().getAttribute('aria-valuenow')).toBe('1');
    expect(thumb().style.left).toBe('0%');
    await act(async () => { resolve(); await gate; await Promise.resolve(); });
    expect(useStore.getState().rewound?.seq).toBe(1);
    expect(host.querySelector('.tl-state')!.textContent).toBe('REWOUND');
    expect(thumb().getAttribute('aria-valuenow')).toBe('1');
  });

  it('Back to live during the first rewind returns to live and drops the pending seek', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    source.stateAt.mockImplementation(async (seq: number) => { await gate; return { ...projectState(), seq, at: T0 + seq * 1000 }; });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('REWOUND');
    act(() => { (host.querySelector('.tl-back-inline') as HTMLElement).click(); });
    await flush();
    await act(async () => { resolve(); await gate; await Promise.resolve(); });
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('LIVE');
    expect(useStore.getState().rewound).toBeNull();
  });

  it('a failed state request drops the aim and shows live again', async () => {
    source.stateAt.mockImplementation(async () => { throw new Error('nope'); });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    await flush();
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('LIVE');
    expect(thumb().getAttribute('aria-valuenow')).toBe('100');
  });

  it('a rewound state replaced by live (Back to live elsewhere) clears the aim', async () => {
    source.stateAt.mockImplementation(() => new Promise(() => {}));
    useStore.getState().rewind({ ...projectState(), seq: 34, at: T0 + 60_000 });
    render(<Timeline />);
    await flush();
    act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    await flush();
    expect(thumb().getAttribute('aria-valuenow')).toBe('1');
    act(() => useStore.setState({ rewound: null }));
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('LIVE');
  });

  it('dragging fetches the state at most once per 120 ms', async () => {
    render(<Timeline />);
    await flush();
    vi.useFakeTimers();
    pointer('pointerdown', 30);
    expect(source.stateAt).toHaveBeenCalledTimes(1);
    pointer('pointermove', 60);
    pointer('pointermove', 90);
    await act(async () => { await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS - 1); });
    expect(source.stateAt).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(source.stateAt).toHaveBeenCalledTimes(2);
    expect(source.stateAt).toHaveBeenLastCalledWith(Math.round(1 + (90 / WIDTH) * 99));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(useStore.getState().rewound?.seq).toBe(31);
  });

  it('a seek queued in the throttle before Back to live (banner) never rewinds again', async () => {
    useStore.getState().rewind({ ...projectState(), seq: 1, at: T0 });
    render(<Timeline />);
    await flush();
    vi.useFakeTimers();
    const press = (key: string) => act(() => { thumb().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    press('ArrowRight');
    expect(source.stateAt).toHaveBeenLastCalledWith(34);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Within 120 ms: the next seek waits in the throttle.
    press('ArrowRight');
    expect(source.stateAt).toHaveBeenCalledTimes(1);
    // Back to live from the banner or the inline button, which do not cancel the timeline's throttle.
    await act(async () => { await useStore.getState().backToLive(); });
    expect(useStore.getState().rewound).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(STATE_THROTTLE_MS); });
    expect(useStore.getState().rewound).toBeNull();
  });

  it('releasing at the live end goes back to live', async () => {
    const backToLive = vi.fn(async () => {});
    useStore.setState({ backToLive });
    render(<Timeline />);
    await flush();
    pointer('pointerdown', 100);
    pointer('pointermove', WIDTH + 20);
    pointer('pointerup', WIDTH + 20);
    expect(backToLive).toHaveBeenCalledTimes(1);
  });

  it('shows REWOUND with the formatted time and a Back to live button', async () => {
    const at = T0 + 125_000;
    useStore.getState().rewind({ ...projectState(), seq: 70, at });
    render(<Timeline />);
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('REWOUND');
    expect(host.querySelector('.tl-time')!.textContent).toBe(clock(at));
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Back to live')).toBe(true);
    expect(thumb().getAttribute('aria-valuetext')).toBe(`${clock(at)}, 4 events`);
  });

  it('reserves the REWOUND side in both states, so the track keeps its width when a drag rewinds', async () => {
    render(<Timeline />);
    await flush();
    const ghost = () => host.querySelector('.tl-side .tl-ghost') as HTMLElement;
    expect(host.querySelector('.tl-state')!.textContent).toBe('LIVE');
    expect(ghost().getAttribute('aria-hidden')).toBe('true');
    expect(ghost().querySelector('.g-state')!.textContent).toBe('REWOUND');
    expect(ghost().querySelector('.g-back')!.textContent).toBe('Back to live');
    // The time slot is sized by the widest times (two-digit hours, morning and evening).
    expect([...ghost().querySelectorAll('.g-time > span')].map(e => e.textContent)).toEqual([
      clock(new Date(2000, 0, 1, 10, 58).getTime()), clock(new Date(2000, 0, 1, 22, 58).getTime()),
    ]);
    expect(ghost().querySelectorAll('button, [tabindex]')).toHaveLength(0);

    act(() => useStore.getState().rewind({ ...projectState(), seq: 70, at: T0 + 125_000 }));
    await flush();
    expect(host.querySelector('.tl-state')!.textContent).toBe('REWOUND');
    expect(ghost().querySelector('.g-state')!.textContent).toBe('REWOUND');
    expect(host.querySelectorAll('.tl-side .tl-ghost')).toHaveLength(1);
  });

  it('a second click while playback is starting cancels it', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    source.stateAt.mockImplementation(async (seq: number) => { await gate; return { ...projectState(), seq, at: T0 }; });
    source.messages.mockImplementation(() => new Promise(() => {}));
    render(<Timeline />);
    await flush();
    const play = () => host.querySelector('button.play') as HTMLButtonElement;
    act(() => { play().click(); });
    expect(play().getAttribute('aria-label')).toBe('Pause playback'); // starting
    act(() => { play().click(); });
    expect(play().getAttribute('aria-label')).toBe('Play history');
    resolve();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(source.messages).not.toHaveBeenCalled();
    expect(useStore.getState().playing).toBe(false);
    expect(useStore.getState().rewound).toBeNull();
  });

  it('Play, Pause, Play while the engine loads runs a single engine', async () => {
    useStore.getState().rewind({ ...projectState(), seq: 40, at: T0 });
    source.messages.mockImplementation(() => new Promise(() => {}));
    render(<Timeline />);
    await flush();
    const play = () => host.querySelector('button.play') as HTMLButtonElement;
    act(() => { play().click(); });
    act(() => { play().click(); });
    act(() => { play().click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(source.messages).toHaveBeenCalledTimes(1);
  });

  it('unmounting stops playback', async () => {
    useStore.getState().rewind({ ...projectState(), seq: 40, at: T0 });
    source.messages.mockImplementation(() => new Promise(() => {}));
    render(<Timeline />);
    await flush();
    act(() => { (host.querySelector('button.play') as HTMLButtonElement).click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(useStore.getState().playing).toBe(true);
    act(() => root.render(null));
    expect(useStore.getState().playing).toBe(false);
  });

  it('says History is off, not unavailable, when the user turned history off', async () => {
    useStore.getState().apply({ type: 'history', history: { enabled: false, first: 0, last: 0, firstAt: 0, lastAt: 0, off: true } });
    render(<Timeline />);
    await flush();
    expect(host.querySelector('.tl-msg')!.textContent).toBe('History is off');
    expect(host.textContent).not.toContain('unavailable');
  });

  it('shows the unavailable banner when history is disabled', async () => {
    useStore.getState().apply({ type: 'history', history: { ...status, enabled: false, error: 'disk full' } });
    render(<Timeline />);
    await flush();
    expect(host.querySelector('.tl-msg')!.textContent).toBe('History is unavailable: disk full');
    expect(host.querySelector('.timeline')!.classList.contains('off')).toBe(true);
  });
});

describe('read-only while rewound', () => {
  it('disables the Flag box and Pause with the tooltip', () => {
    useStore.getState().rewind({ ...projectState(), seq: 40, at: T0 });
    render(<><FlagBox target={null} /><PauseButton /></>);
    const ta = host.querySelector('textarea')!;
    expect(ta.disabled).toBe(true);
    expect(host.querySelector('form')!.getAttribute('title')).toBe('Back to live to make changes');
    const pause = host.querySelector('button.pause') as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
    expect(pause.title).toBe('Back to live to make changes');
  });

  it('the status chip and the Inspector stop claiming Live', () => {
    const now = Date.now();
    useStore.getState().setConnection('open');
    useStore.getState().apply({ type: 'session', session: { id: 's1', agent: 'claude-code', title: 't', cwd: '/p', startedAt: now - 1000, lastAt: now, status: 'working', hooks: true } });
    render(<><Toolbar /><LiveHead /><LiveSession /></>);
    expect(host.querySelector('.statuschip')!.textContent).toContain('Live');
    expect(host.querySelector('.livetag')).not.toBeNull();
    act(() => useStore.getState().rewind({ ...projectState(), sessions: [{ id: 's1', agent: 'claude-code', title: 't', cwd: '/p', startedAt: now - 1000, lastAt: now, status: 'working', hooks: true }], seq: 40, at: T0 }));
    expect(host.querySelector('.statuschip')!.textContent).toBe('Rewound');
    expect(host.querySelector('.livetag')).toBeNull();
  });
});
