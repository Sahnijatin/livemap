// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChangeSummary, FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { change, emptyDomain, event, file, session, sym } from '../fixtures';
import type { ElkRun } from '../layout/elk';
import { LARGE_PROJECT, buildMap, type MapInput } from './mapModel';
import { emptyPositions, placeMap } from './mapLayout';
import { pinsKey } from './pins';
import { FRESH_MS, flowEdges, freshEdgeIds, layoutBoxes } from './mapFlow';
import { LinkEdge } from './LinkEdge';
import { FOCUS_WAIT_MS, MapView, forgetMapSession } from './MapView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every camera `setCenter` call (Follow's moves among them), passed through to React Flow unless a test
 * turns `passThrough` off (the camera then stays where it is, like a move cut short at its start).
 */
const centers: { x: number; y: number; duration?: number }[] = [];
let passThrough = true;
vi.mock('@xyflow/react', async importOriginal => {
  const m = await importOriginal<typeof import('@xyflow/react')>();
  const wrapped = new WeakMap<object, ReturnType<typeof m.useReactFlow>>();
  return {
    ...m,
    useReactFlow: () => {
      const rf = m.useReactFlow();
      let w = wrapped.get(rf);
      if (!w) {
        w = { ...rf, setCenter: (x, y, o) => { centers.push({ x, y, duration: o?.duration }); return passThrough ? rf.setCenter(x, y, o) : Promise.resolve(true); } };
        wrapped.set(rf, w);
      }
      return w;
    },
  };
});

// React Flow needs these browser APIs; jsdom has neither (same stand-ins as the Schema view tests).
beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;
  class DM { m22 = 1; constructor() {} }
  (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= DM;
});

/**
 * Reduced motion makes node moves and camera changes instant, so assertions see final positions (and
 * d3-zoom transitions, which cannot run in jsdom, are skipped). The animated path runs in the browser.
 */
/** framer-motion warns once when reduced motion is on; expected here, so it is captured, not printed. */
const motionWarnings: string[] = [];
const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  const text = String(args[0]);
  if (text.includes('Reduced Motion')) motionWarnings.push(text);
  else process.stderr.write(`${text}\n`);
});
afterAll(() => {
  warn.mockRestore();
  // At most the one expected notice, nothing else.
  expect(motionWarnings.length).toBeLessThanOrEqual(1);
});

const reducedMotion = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: on && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
}));

let host: HTMLDivElement;
let tools: HTMLDivElement;
let root: Root;

/** A layout stand-in: folders in a row, so tests do not depend on ELK. */
const rowRun: ElkRun = async g => ({ ...g, children: g.children!.map((c, i) => ({ ...c, x: i * 900, y: 0 })) });

const imp = (path: string, local: string[], symbols = [sym('main')], extra: Partial<FileModel> = {}) =>
  file(path, symbols, { imports: { local, external: [] }, ...extra });

const APP = 'src/web/App.tsx';
const PAGE = 'src/web/Page.tsx';
const ORDERS = 'src/api/orders.ts';
const baseFiles = () => [
  imp(APP, [PAGE], [sym('App', 'component'), sym('helper')]),
  imp(PAGE, [ORDERS], [sym('Page', 'component')]),
  imp(ORDERS, [], [sym('listOrders'), sym('createOrder'), sym('Order', 'interface')]),
  file('README.md', [], { lang: 'markdown' }),
];

function hello(files: FileModel[], extra: { changes?: ChangeSummary[]; flags?: { target: string }[]; live?: string } = {}) {
  const events = extra.live
    ? [event({ type: 'tool_start', tool: { id: 't1', name: 'Edit', label: 'Edit', paths: [extra.live] } })]
    : [];
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files, changes: extra.changes ?? [], usedBy: [], domain: emptyDomain(), indexing: false,
    events, sessions: extra.live ? [session()] : [],
    control: { paused: false, flags: (extra.flags ?? []).map((f, i) => ({ id: i + 1, target: f.target, note: 'look', createdAt: Date.now() })) },
  });
}

async function mount(run: ElkRun = rowRun) {
  await act(async () => root.render(<MapView run={run} tools={tools} />));
  await settle();
}

/** Let layout promises settle and the nodes render. */
async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const card = (path: string) => host.querySelector<HTMLElement>(`.node[data-path="${path}"]`);
const viewport = () => {
  const m = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)\s*scale\(([-\d.e]+)\)/.exec(host.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) };
};
/** The file card's center on screen, relative to the canvas center (React Flow's unmeasured canvas is 500 × 500 in jsdom). */
const screenCenter = (path: string) => {
  const el = card(path)!;
  const node = el.closest<HTMLElement>('.react-flow__node')!;
  const w = parseFloat(node.style.width), h = parseFloat(node.style.height);
  const v = viewport();
  return { x: (Number(el.dataset.x) + w / 2) * v.zoom + v.x - 250, y: (Number(el.dataset.y) + h / 2) * v.zoom + v.y - 250 };
};
const levelBtn = (label: string) => [...tools.querySelectorAll<HTMLButtonElement>('.mini-seg button')].find(b => b.textContent === label)!;

beforeEach(() => {
  reducedMotion(true);
  centers.length = 0;
  passThrough = true;
  useStore.getState().reset();
  forgetMapSession();
  host = document.createElement('div');
  tools = document.createElement('div');
  document.body.append(host, tools);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  tools.remove();
  vi.unstubAllGlobals();
});

describe('MapView', () => {
  it('shows the empty state when there are no code files', async () => {
    hello([file('README.md', [], { lang: 'markdown' })]);
    await mount();
    expect(host.textContent).toContain('No code files yet.');
    expect(host.textContent).toContain('The map fills in as files appear.');
  });

  it('renders a card per code file with name, symbol count, layer and flow position', async () => {
    hello(baseFiles());
    await mount();
    const app = card(APP)!;
    expect(app).not.toBeNull();
    expect(card('README.md')).toBeNull();
    expect(app.querySelector('.nm')!.textContent).toBe('App.tsx');
    expect(app.querySelector('.sub')!.textContent).toContain('2 symbols');
    expect(app.getAttribute('aria-label')).toBe('App.tsx (Interface, 2 symbols)');
    expect(app.getAttribute('role')).toBe('button');
    expect(app.tabIndex).toBe(0);
    expect(Number.isFinite(Number(app.dataset.x))).toBe(true);
    expect(Number.isFinite(Number(app.dataset.y))).toBe(true);
    // Folder regions are labeled.
    const labels = [...host.querySelectorAll('.mglabel .gl')].map(e => e.textContent);
    expect(labels.some(l => l?.startsWith('src/web/'))).toBe(true);
    expect(host.querySelector('.cv-hint')!.textContent).toBe('Drag to pan · ⌘ + scroll to zoom · click a card to inspect');
  });

  it('marks new, live, selected and flagged files', async () => {
    const fresh = imp('src/web/New.tsx', [], [sym('New', 'component')]);
    hello([...baseFiles(), fresh], { changes: [change(fresh.path, 'created')], flags: [{ target: ORDERS }], live: PAGE });
    useStore.getState().select(APP);
    await mount();
    expect(card(fresh.path)!.classList.contains('isnew')).toBe(true);
    expect(card(fresh.path)!.querySelector('.newtag')!.textContent).toBe('NEW');
    expect(card(APP)!.classList.contains('isnew')).toBe(false);
    expect(card(PAGE)!.classList.contains('live')).toBe(true);
    expect(card(PAGE)!.textContent).toContain('Writing now');
    expect(card(APP)!.classList.contains('sel')).toBe(true);
    expect(card(PAGE)!.classList.contains('sel')).toBe(false);
    expect(card(ORDERS)!.classList.contains('flagged')).toBe(true);
    // Selection moves without rebuilding other cards.
    act(() => useStore.getState().select(ORDERS));
    expect(card(APP)!.classList.contains('sel')).toBe(false);
    expect(card(ORDERS)!.classList.contains('sel')).toBe(true);
  });

  it('the functions level shows symbol rows with new and changed tints', async () => {
    const files = baseFiles();
    const orders = files[2];
    const ref = (s: (typeof orders.symbols)[number]) => ({ name: s.name, qname: s.qname, kind: s.kind, signature: s.signature, line: s.line });
    const ch = change(ORDERS, 'modified', {
      symbols: { added: [ref(orders.symbols[1])], removed: [], modified: [{ ...ref(orders.symbols[0]), signatureChanged: false }] },
    });
    hello(files, { changes: [ch] });
    await mount();
    expect(card(ORDERS)!.querySelectorAll('.nsrow').length).toBe(0);
    act(() => levelBtn('Functions').click());
    await settle();
    const rows = [...card(ORDERS)!.querySelectorAll('.nsrow')];
    expect(rows.map(r => r.querySelector('.nsn')!.textContent)).toEqual(['listOrders', 'createOrder', 'Order']);
    expect(rows[0].classList.contains('chg')).toBe(true);
    expect(rows[1].classList.contains('new')).toBe(true);
    expect(rows[2].classList.contains('new') || rows[2].classList.contains('chg')).toBe(false);
    expect(card(ORDERS)!.classList.contains('fnz')).toBe(true);
  });

  it('the level control switches levels and reflects the level in aria-pressed', async () => {
    hello(baseFiles());
    await mount();
    expect(levelBtn('Files').getAttribute('aria-pressed')).toBe('true');
    expect(levelBtn('Folders').getAttribute('aria-pressed')).toBe('false');
    act(() => levelBtn('Folders').click());
    await settle();
    expect(useStore.getState().mapLevel).toBe('folders');
    expect(levelBtn('Folders').getAttribute('aria-pressed')).toBe('true');
    expect(levelBtn('Files').getAttribute('aria-pressed')).toBe('false');
    // Folder cards with counts replace file cards.
    const folder = host.querySelector<HTMLElement>('.folder[data-folder="dir:src/api"]')!;
    expect(folder).not.toBeNull();
    expect(folder.textContent).toContain('1 file');
    expect(folder.textContent).toContain('3 symbols');
    expect(card(APP)).toBeNull();
    // Double-clicking a folder opens the files level.
    act(() => { folder.closest('.react-flow__node')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await settle();
    expect(useStore.getState().mapLevel).toBe('files');
    expect(card(APP)).not.toBeNull();
  });

  it('under reduced motion a level switch sizes cards for the new level at once', async () => {
    hello(baseFiles());
    await mount();
    const wrapper = () => card(ORDERS)!.closest<HTMLElement>('.react-flow__node')!;
    expect(wrapper().style.height).toBe('64px');
    act(() => levelBtn('Functions').click());
    await settle();
    // Three symbol rows of 24 px each, with no in-between frames.
    expect(wrapper().style.height).toBe(`${64 + 3 * 24}px`);
  });

  it('new files during a slow first layout coalesce into one follow-up run, not one queued run each', async () => {
    const waiting: (() => void)[] = [];
    let calls = 0;
    const slow: ElkRun = g => { calls++; return new Promise(r => waiting.push(() => r(rowRun(g)))); };
    hello(baseFiles());
    await act(async () => root.render(<MapView run={slow} tools={tools} />));
    expect(calls).toBe(1);
    for (let i = 0; i < 5; i++) {
      const f = imp(`src/new${i}/f${i}.ts`, []);
      act(() => useStore.getState().apply({ type: 'change', files: [f], removed: [], change: change(f.path, 'created') }));
    }
    await settle();
    expect(calls).toBe(1);
    await act(async () => { waiting.shift()!(); });
    await settle();
    // The follow-up starts from the first result, so every later layout is incremental and skips ELK.
    while (waiting.length) await act(async () => { waiting.shift()!(); });
    await settle();
    expect(calls).toBeLessThanOrEqual(2);
    expect(card('src/new4/f4.ts')).not.toBeNull();
    expect(card(APP)).not.toBeNull();
  });

  it('Reset layout clears the pins', async () => {
    const mem = new Map<string, string>([[pinsKey('/p/shop'), JSON.stringify({ files: { [APP]: { x: 5000, y: 5000 } }, folders: {} })]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    hello(baseFiles());
    await mount();
    expect(card(APP)!.dataset.x).toBe('5000');
    const more = tools.querySelector<HTMLButtonElement>('button[aria-label="Map options"]')!;
    act(() => more.click());
    const reset = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(b => b.textContent === 'Reset layout')!;
    expect(reset).toBeTruthy();
    expect([...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent)).toEqual(['Reset layout', 'Fit to screen']);
    act(() => reset.click());
    await settle();
    expect(mem.has(pinsKey('/p/shop'))).toBe(false);
    await vi.waitFor(() => expect(card(APP)!.dataset.x).not.toBe('5000'));
  });

  it('while rewound, Reset layout is disabled and cards say why they cannot be dragged', async () => {
    hello(baseFiles());
    await mount();
    act(() => {
      const st = useStore.getState();
      st.rewind({ root: st.root, name: st.name, files: Object.values(st.files), changes: [], usedBy: [], domain: st.domain, indexing: false, events: [], sessions: [], control: st.control, seq: 3, at: 1 });
    });
    await settle();
    act(() => tools.querySelector<HTMLButtonElement>('button[aria-label="Map options"]')!.click());
    const reset = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(b => b.textContent === 'Reset layout')!;
    expect(reset.disabled).toBe(true);
    expect(reset.title).toBe('Back to live to make changes');
    expect(card(APP)!.title).toBe('Back to live to make changes');
    // Focus skips the disabled item, and the arrow keys never land on it, so Fit to screen stays reachable.
    const fit = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(b => b.textContent === 'Fit to screen')!;
    expect(document.activeElement).toBe(fit);
    for (const key of ['ArrowDown', 'ArrowUp']) {
      act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
      expect(document.activeElement).toBe(fit);
    }
  });

  it('clicking a card selects its file; Enter on a focused card does too', async () => {
    hello(baseFiles());
    await mount();
    act(() => card(PAGE)!.click());
    expect(useStore.getState().selected).toBe(PAGE);
    act(() => { card(ORDERS)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useStore.getState().selected).toBe(ORDERS);
  });

  it('arrow keys move focus to the nearest card in that direction', async () => {
    hello(baseFiles());
    await mount();
    card(APP)!.focus();
    // App.tsx and Page.tsx share a one-column folder: Page.tsx is below.
    act(() => { card(APP)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(card(PAGE));
    act(() => { card(PAGE)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(document.activeElement).toBe(card(APP));
    // src/api sits left of src/web in this layout.
    act(() => { card(APP)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(document.activeElement).toBe(card(ORDERS));
  });

  it('shows the large-project notice above 500 code files and opens at folders', async () => {
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many);
    await mount();
    expect(host.textContent).toContain('Large project: showing folders. Open one to see its files.');
    expect(useStore.getState().mapLevel).toBe('folders');
    expect(host.querySelectorAll('.folder').length).toBe(5);
  });

  it('the large-project notice is absent for a small project', async () => {
    hello(baseFiles());
    await mount();
    expect(host.textContent).not.toContain('Large project');
  });

  it('the large-project notice fits each level: never "showing folders" at the files or functions level', async () => {
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many);
    await mount();
    const note = () => host.querySelector('.map-note')?.textContent ?? null;
    act(() => useStore.getState().setMapLevel('files'));
    await settle();
    expect(note()).toBe('Large project: open a folder to see its files.');
    act(() => useStore.getState().setMapLevel('functions'));
    await settle();
    expect(note()).toBe('Large project: open a folder to see its functions.');
    act(() => useStore.getState().expandMapFolder('dir:d1'));
    await settle();
    expect(note()).toBe('4 folders are closed.');
    for (const d of ['dir:d0', 'dir:d2', 'dir:d3', 'dir:d4']) act(() => useStore.getState().expandMapFolder(d));
    await settle();
    expect(note()).toBeNull();
    act(() => useStore.getState().setMapLevel('folders'));
    await settle();
    expect(note()).toBe('Large project: showing folders. Open one to see its files.');
  });

  it('the notice and the zoom buttons sit in a bar below the canvas, not over it', async () => {
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many);
    await mount();
    const bar = host.querySelector('.mapv > .mv-foot')!;
    expect(bar.previousElementSibling?.classList.contains('mv-canvas')).toBe(true);
    expect(bar.querySelector('.map-note')).not.toBeNull();
    expect(bar.querySelector('.zoomctl')).not.toBeNull();
    // The note takes the hint's place.
    expect(bar.querySelector('.cv-hint')).toBeNull();
  });

  it('cuts long folder names in the middle and keeps the full path in the title', async () => {
    const long = '.agents/skills/supabase-row-level-security';
    hello([...baseFiles(), imp(`${long}/check.ts`, [])]);
    act(() => useStore.getState().setMapLevel('folders'));
    await mount();
    const fl = host.querySelector<HTMLElement>(`.folder[data-folder="dir:${long}"] .fl`)!;
    expect(fl.title).toBe(long);
    expect([...fl.querySelectorAll('.fn > span')].map(s => s.textContent)).toEqual(['.agents/skills/supabase-row-', 'level-security/']);
    act(() => useStore.getState().setMapLevel('files'));
    await settle();
    const gl = host.querySelector<HTMLElement>(`.mglabel[data-folder="dir:${long}"] .gl`)!;
    expect(gl.title).toBe(long);
    expect(gl.querySelector('.fn')!.textContent).toMatch(/level-security\/$/);
  });

  it('when the start cannot keep 3 characters, a card shows "…" and the end only', async () => {
    const path = 'packages/notification-hub';
    hello([...baseFiles(), imp(`${path}/a.ts`, [])]);
    act(() => useStore.getState().setMapLevel('folders'));
    await mount();
    const fn = host.querySelector<HTMLElement>(`.folder[data-folder="dir:${path}"] .fl .fn`)!;
    expect(fn.classList.contains('end')).toBe(true);
    expect(fn.textContent).toBe('\u2026notification-hub/');
  });
});

describe('level of detail (#15)', () => {
  const zoomOut = () => act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!.click());
  const far = () => host.querySelector('.mapv')!.classList.contains('far');

  it('.mapv is "far" below zoom 0.45 and not at or above it', async () => {
    hello(baseFiles());
    await mount();
    expect(far()).toBe(false);
    // Zoom out until about 0.5, then once more to about 0.4.
    for (let i = 0; i < 10 && viewport().zoom >= 0.5; i++) zoomOut();
    expect(viewport().zoom).toBeLessThan(0.5);
    expect(viewport().zoom).toBeGreaterThanOrEqual(0.45);
    expect(far()).toBe(false);
    zoomOut();
    expect(viewport().zoom).toBeLessThan(0.45);
    expect(far()).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    expect(far()).toBe(false);
  });

  it('zoomed out, folders get overview labels that keep their screen size', async () => {
    hello(baseFiles());
    await mount();
    const labels = () => [...host.querySelectorAll<HTMLElement>('.ovl')];
    expect(labels()).toHaveLength(0);
    for (let i = 0; i < 20 && viewport().zoom >= 0.3; i++) zoomOut();
    await settle();
    expect(labels().map(l => l.textContent).sort()).toEqual(['src/api/', 'src/web/']);
    // Scaled by about 1 / zoom, so the label reads at its normal size on screen.
    const scale = Number(/scale\(([\d.e-]+)\)/.exec(labels()[0].style.transform)![1]);
    expect(scale * viewport().zoom).toBeGreaterThan(0.85);
    expect(scale * viewport().zoom).toBeLessThan(1.15);
  });
});

describe('Follow', () => {
  const followBtn = () => tools.querySelector<HTMLButtonElement>('button.toggle')!;
  const memStorage = (mem: Map<string, string>) => vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  });

  it('the Follow toggle sits between the level control and the options menu, on by default', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    hello(baseFiles());
    await mount();
    const kids = [...tools.children];
    expect(kids.map(k => k.className)).toEqual(['mini-seg', 'toggle', 'mt-more']);
    expect(followBtn().textContent).toBe('Follow');
    expect(followBtn().getAttribute('aria-pressed')).toBe('true');
    expect(followBtn().querySelector('.sw')).not.toBeNull();
  });

  it('the Follow toggle persists in localStorage', async () => {
    const mem = new Map<string, string>();
    memStorage(mem);
    useStore.getState().reset();
    hello(baseFiles());
    await mount();
    act(() => followBtn().click());
    expect(followBtn().getAttribute('aria-pressed')).toBe('false');
    expect(mem.get('livemap:follow')).toBe('0');
    expect(useStore.getState().follow).toBe(false);
    // A reload reads it back.
    act(() => useStore.getState().reset());
    expect(useStore.getState().follow).toBe(false);
    act(() => useStore.getState().setFollow(true));
    expect(mem.get('livemap:follow')).toBe('1');
  });

  it('a broken localStorage still works: on by default and toggles for the page', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } });
    useStore.getState().reset();
    expect(useStore.getState().follow).toBe(true);
    hello(baseFiles());
    await mount();
    act(() => followBtn().click());
    expect(followBtn().getAttribute('aria-pressed')).toBe('false');
    act(() => followBtn().click());
    expect(followBtn().getAttribute('aria-pressed')).toBe('true');
  });

  it('a user zoom shows "Paused" next to Follow until 8 s without camera moves pass', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    hello(baseFiles());
    await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
      expect(followBtn().textContent).toBe('FollowPaused');
      expect(followBtn().getAttribute('aria-pressed')).toBe('true');
      act(() => { vi.advanceTimersByTime(7900); });
      expect(followBtn().textContent).toBe('FollowPaused');
      act(() => { vi.advanceTimersByTime(200); });
      expect(followBtn().textContent).toBe('Follow');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turning Follow back on clears a stale "Paused" (F4)', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    hello(baseFiles());
    await mount();
    act(() => followBtn().click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    act(() => followBtn().click());
    expect(followBtn().getAttribute('aria-pressed')).toBe('true');
    expect(followBtn().textContent).toBe('Follow');
  });

  it('the toggle keeps the accessible name "Follow"; "Paused" is its description (F6)', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    hello(baseFiles());
    await mount();
    expect(followBtn().getAttribute('aria-label')).toBe('Follow');
    expect(followBtn().hasAttribute('aria-describedby')).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    expect(followBtn().getAttribute('aria-label')).toBe('Follow');
    const id = followBtn().getAttribute('aria-describedby')!;
    expect(document.getElementById(id)?.textContent).toBe('Paused');
  });

  it('on a level switch Follow waits for the overview instead of moving first (F3)', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    // Twelve files in one folder: the live one sits low in its region, far from where its folder card goes.
    const web = Array.from({ length: 12 }, (_, i) => imp(`src/web/w${i}.tsx`, []));
    hello([...web, imp(ORDERS, [])], { live: 'src/web/w11.tsx' });
    await mount();
    // Zoom away from the overview's 0.85 with Follow off, then turn it back on.
    act(() => followBtn().click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    act(() => followBtn().click());
    await settle();
    expect(viewport().zoom).not.toBeCloseTo(0.85, 3);
    // Past Follow's interval since the last camera move, so nothing but the hold keeps Follow still.
    await act(async () => { await new Promise(r => setTimeout(r, 700)); });
    const vpEl = host.querySelector<HTMLElement>('.react-flow__viewport')!;
    const seen: string[] = [];
    const mo = new MutationObserver(rs => { for (const r of rs) seen.push(r.oldValue ?? ''); });
    mo.observe(vpEl, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    act(() => levelBtn('Folders').click());
    await settle();
    await settle();
    await act(async () => { await new Promise(r => setTimeout(r, 450)); });
    mo.disconnect();
    // One camera move: the overview (the two folder cards fit, capped at zoom 1); Follow, which keeps the
    // current zoom (1.02), neither moved first nor after.
    expect(seen.length).toBe(1);
    expect(viewport().zoom).toBe(1);
  });

  it('a click on empty canvas in the middle of a Follow move does not stall Follow (#15)', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    const web = Array.from({ length: 12 }, (_, i) => imp(`src/web/w${i}.tsx`, []));
    hello([...web, imp(ORDERS, [])], { live: 'src/web/w0.tsx' });
    await mount();
    // From here the camera never reaches Follow's target, as when a click interrupts the move at its start
    // (no real d3 transition, whose progress would depend on wall time). Fake clocks drive Follow's interval.
    passThrough = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // Past Follow's interval since the first view.
      act(() => { vi.advanceTimersByTime(1000); });
      centers.length = 0;
      // The agent starts writing a file off screen: Follow moves toward it.
      act(() => useStore.getState().apply({
        type: 'agentEvent', event: event({ id: 9, at: Date.now(), type: 'tool_start', tool: { id: 't9', name: 'Edit', label: 'Edit', paths: [ORDERS] } }),
      }));
      expect(centers.length).toBe(1);
      const first = centers[0];
      // A plain click on the canvas: d3-zoom ends a gesture that moved nothing.
      const pane = host.querySelector<HTMLElement>('.react-flow__pane')!;
      const win = pane.ownerDocument.defaultView!;
      // d3-zoom listens for the mouseup on `event.view` (jsdom refuses vitest's window in the constructor).
      const mouse = (type: string) => {
        const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: 100, clientY: 100 });
        Object.defineProperty(e, 'view', { value: win });
        return e;
      };
      act(() => {
        pane.dispatchEvent(mouse('mousedown'));
        win.dispatchEvent(mouse('mouseup'));
      });
      // Follow asks for the same file again once its interval has passed, instead of waiting for the next file.
      act(() => { vi.advanceTimersByTime(1000); });
      expect(followBtn().textContent).toBe('Follow');
      expect(centers.length).toBe(2);
      expect(centers[1]).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('in a large project, Follow opens the collapsed folder the agent is writing in', async () => {
    memStorage(new Map());
    useStore.getState().reset();
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many, { live: 'd3/f8.ts' });
    useStore.getState().setMapLevel('files');
    await mount();
    expect(useStore.getState().mapExpanded['dir:d3']).toBe(true);
    expect(Object.keys(useStore.getState().mapExpanded)).toEqual(['dir:d3']);
    await settle();
    expect(card('d3/f8.ts')).not.toBeNull();
  });

  it('with Follow off, a large project leaves folders collapsed', async () => {
    memStorage(new Map([['livemap:follow', '0']]));
    useStore.getState().reset();
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many, { live: 'd3/f8.ts' });
    useStore.getState().setMapLevel('files');
    await mount();
    expect(Object.keys(useStore.getState().mapExpanded)).toEqual([]);
  });
});

describe('map edges', () => {
  const input = (files: FileModel[], helloEdges: Set<string>): MapInput => {
    const byPath: Record<string, FileModel> = {};
    for (const f of files) byPath[f.path] = f;
    return { files: byPath, recent: {}, changes: [], flags: [], target: null, helloEdges };
  };

  it('a new edge is fresh for a few seconds; an old one never is', async () => {
    const g = buildMap(input(baseFiles(), new Set([`${APP}->${PAGE}`])), 'files', new Set());
    const pos = await placeMap(g, emptyPositions(), { files: {}, functions: {}, folders: {} }, rowRun);
    const seen = new Map<string, number>();
    const fresh = freshEdgeIds(g, seen, 1000);
    expect([...fresh]).toEqual([`${PAGE}->${ORDERS}`]);
    const edges = flowEdges(g, layoutBoxes(g, pos), fresh);
    const byId = new Map(edges.map(e => [e.id, e]));
    expect(byId.get(`${PAGE}->${ORDERS}`)!.className).toContain('fresh');
    expect(byId.get(`${APP}->${PAGE}`)!.className ?? '').not.toContain('fresh');
    // First seen at 1000: still fresh just before FRESH_MS, settled after it.
    expect(freshEdgeIds(g, seen, 1000 + FRESH_MS - 1).size).toBe(1);
    expect(freshEdgeIds(g, seen, 1000 + FRESH_MS).size).toBe(0);
  });

  it('LinkEdge draws a curve; a fresh one uses the gradient and the draw animation', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg);
    const r = createRoot(svg as unknown as HTMLElement);
    const props = { id: 'a->b', source: 'a', target: 'b', sourceX: 0, sourceY: 10, targetX: 300, targetY: 120, sourcePosition: 'right', targetPosition: 'left' } as const;
    act(() => r.render(<LinkEdge {...(props as object as Parameters<typeof LinkEdge>[0])} data={{ fresh: true, weight: 1 }} />));
    let path = svg.querySelector('path')!;
    expect(path.getAttribute('d')).toMatch(/^M0,10 C/);
    expect(path.getAttribute('class')).toContain('draw');
    expect(path.getAttribute('pathLength')).toBe('1');
    act(() => r.render(<LinkEdge {...(props as object as Parameters<typeof LinkEdge>[0])} data={{ fresh: false, weight: 1 }} />));
    path = svg.querySelector('path')!;
    expect(path.getAttribute('class')).not.toContain('draw');
    act(() => r.unmount());
    svg.remove();
  });
});

describe('palette focus (mapFocus)', () => {
  const followBtn = () => tools.querySelector<HTMLButtonElement>('button.toggle')!;

  it('centers the camera on the file and selects it; like a user camera move, it pauses Follow', async () => {
    hello(baseFiles());
    await mount();
    act(() => useStore.getState().focusMap(ORDERS));
    await settle();
    expect(useStore.getState().selected).toBe(ORDERS);
    const c = screenCenter(ORDERS);
    expect(Math.abs(c.x)).toBeLessThan(1);
    expect(Math.abs(c.y)).toBeLessThan(1);
    expect(followBtn().textContent).toBe('FollowPaused');
    // The same request again (new seq) fires again; an old request is not replayed on remount.
    act(() => useStore.getState().focusMap(APP));
    await settle();
    expect(Math.abs(screenCenter(APP).x)).toBeLessThan(1);
  });

  it('at the folders level, switches to files and centers the file', async () => {
    hello(baseFiles());
    useStore.getState().setMapLevel('folders');
    await mount();
    act(() => useStore.getState().focusMap(PAGE));
    await settle();
    expect(useStore.getState().mapLevel).toBe('files');
    await settle();
    expect(card(PAGE)).not.toBeNull();
    const c = screenCenter(PAGE);
    expect(Math.abs(c.x)).toBeLessThan(1);
    expect(Math.abs(c.y)).toBeLessThan(1);
  });

  /** A layout that can be held, to keep a palette focus waiting for its layout. */
  function holdableRun() {
    let hold = false;
    let release: () => void = () => {};
    const run: ElkRun = async g => {
      if (hold) await new Promise<void>(r => { release = r; });
      return rowRun(g);
    };
    return { run, hold: () => { hold = true; }, release: async () => { hold = false; await act(async () => release()); await settle(); await settle(); } };
  }

  it('a focus waiting for its layout pauses Follow at once (F5)', async () => {
    const h = holdableRun();
    hello(baseFiles());
    useStore.getState().setMapLevel('folders');
    await mount(h.run);
    h.hold();
    act(() => useStore.getState().focusMap(PAGE));
    await settle();
    expect(card(PAGE)).toBeNull();
    expect(followBtn().textContent).toBe('FollowPaused');
    await h.release();
  });

  it('a focus still waiting for its layout is dropped by a user camera move', async () => {
    const h = holdableRun();
    hello(baseFiles());
    useStore.getState().setMapLevel('folders');
    await mount(h.run);
    h.hold();
    act(() => useStore.getState().focusMap(PAGE));
    await settle();
    expect(useStore.getState().mapLevel).toBe('files');
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    await settle();
    const before = viewport();
    await h.release();
    expect(card(PAGE)).not.toBeNull();
    expect(viewport()).toEqual(before);
  });

  it('a focus still waiting for its layout is dropped after 3 s', async () => {
    const h = holdableRun();
    hello(baseFiles());
    useStore.getState().setMapLevel('folders');
    await mount(h.run);
    h.hold();
    const t0 = Date.now();
    act(() => useStore.getState().focusMap(PAGE));
    await settle();
    const before = viewport();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + FOCUS_WAIT_MS + 100);
    try {
      await h.release();
    } finally {
      now.mockRestore();
    }
    expect(card(PAGE)).not.toBeNull();
    expect(viewport()).toEqual(before);
  });

  it('in a large project, opens the collapsed folder and centers the file', async () => {
    const many = Array.from({ length: LARGE_PROJECT + 1 }, (_, i) => file(`d${i % 5}/f${i}.ts`, [sym(`f${i}`)]));
    hello(many);
    await mount();
    expect(useStore.getState().mapLevel).toBe('folders');
    act(() => useStore.getState().focusMap('d2/f7.ts'));
    await settle();
    await settle();
    expect(useStore.getState().mapLevel).toBe('files');
    expect(useStore.getState().mapExpanded['dir:d2']).toBe(true);
    expect(card('d2/f7.ts')).not.toBeNull();
    expect(Math.abs(screenCenter('d2/f7.ts').x)).toBeLessThan(1);
  });
});

describe('first view camera (readable map)', () => {
  // rowRun puts folders 900 px apart, so fitting all three would need a zoom far below 0.7.
  it('centers the live file at 0.85 when fitting everything would be unreadable; live wins over the selection', async () => {
    hello(baseFiles(), { live: PAGE });
    useStore.getState().select(APP);
    await mount();
    await settle();
    expect(viewport().zoom).toBeCloseTo(0.85, 5);
    const c = screenCenter(PAGE);
    expect(Math.abs(c.x)).toBeLessThan(1);
    expect(Math.abs(c.y)).toBeLessThan(1);
  });

  it('centers the selected file when nothing is live', async () => {
    hello(baseFiles());
    useStore.getState().select(ORDERS);
    await mount();
    await settle();
    expect(viewport().zoom).toBeCloseTo(0.85, 5);
    expect(Math.abs(screenCenter(ORDERS).x)).toBeLessThan(1);
  });

  it('anchors the top-left cluster at 0.85 with nothing to focus', async () => {
    hello(baseFiles());
    await mount();
    await settle();
    const v = viewport();
    expect(v.zoom).toBeCloseTo(0.85, 5);
    expect(v.x).toBeCloseTo(40, 0);
    expect(v.y).toBeCloseTo(40, 0);
  });

  it('fits everything when the fitted zoom is readable', async () => {
    // Folders 300 px apart: the whole map fits a 500 px canvas above 0.7 (React Flow caps the fit at 1).
    const near: ElkRun = async g => ({ ...g, children: g.children!.map((c, i) => ({ ...c, x: i * 10, y: i * 200 })) });
    hello([imp(ORDERS, [], [sym('listOrders')])]);
    await mount(near);
    await settle();
    expect(viewport().zoom).toBeGreaterThanOrEqual(0.7);
    expect(viewport().zoom).not.toBeCloseTo(0.85, 5);
  });
});
