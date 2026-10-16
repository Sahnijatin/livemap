// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, emptyDomain } from '../fixtures';
import { LAYOUT_KEY, fitLayout } from '../panelLayout';
import { restHistorySource, setHistorySource } from '../history';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn(), fetchFile: vi.fn(() => new Promise(() => {})) }));
const { Toolbar } = await import('./Toolbar');
const { FileTree } = await import('./FileTree');
const { Inspector, loadDetail } = await import('./Inspector');
// The file view loads after first paint in the app; load it up front so a selection renders at once.
await loadDetail();
const { Dock } = await import('./Dock');
const { PanelHandle } = await import('./PanelHandle');
const { useSlideOvers } = await import('../panels');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A matchMedia stand-in driven by a fake viewport width (also window.innerWidth); `resize` fires change events like a browser. */
type Listener = (e: { matches: boolean; media: string }) => void;
let width = 1440;
const lists: { media: string; listeners: Set<Listener>; last: boolean }[] = [];
const evaluate = (q: string): boolean => {
  if (q.includes('reduce')) return false;
  const max = q.match(/max-width:\s*([\d.]+)px/);
  const min = q.match(/min-width:\s*([\d.]+)px/);
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
};
/** ResizeObserver stand-in: Dock measures `.app` only through it, and a window resize resizes `.app`. */
let observers: ((entries: unknown[]) => void)[] = [];
class FakeResizeObserver { constructor(fn: (entries: unknown[]) => void) { observers.push(fn); } observe() {} unobserve() {} disconnect() {} }
function resize(w: number) {
  width = w;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  for (const fn of observers) fn([]);
  for (const l of lists) {
    const m = evaluate(l.media);
    if (m === l.last) continue;
    l.last = m;
    for (const fn of l.listeners) fn({ matches: m, media: l.media });
  }
  window.dispatchEvent(new Event('resize'));
}
const realMatchMedia = window.matchMedia;

let host: HTMLDivElement;
let root: Root;
let renders = 0;
let dockRenders = 0;
/** Counts its renders: stands in for the heavy children (FileTree, CenterTabs, Inspector). */
function Spy() {
  renders++;
  return <main className="center" />;
}

/**
 * App's shell: the toolbar and both panels inside the Dock that owns `.app`, under a Profiler that counts the Dock's
 * commits. The handles sit outside it here (in App they are inside), so their own re-renders are not counted.
 */
function Shell() {
  useSlideOvers();
  return (
    <>
      <Profiler id="dock" onRender={() => { dockRenders++; }}>
        <Dock gated={false}>
          <Toolbar />
          <FileTree />
          <Spy />
          <Inspector />
        </Dock>
      </Profiler>
      <PanelHandle panel="files" />
      <PanelHandle panel="inspector" />
    </>
  );
}

async function mount() {
  await act(async () => { root.render(<Shell />); });
}

const app = () => host.querySelector<HTMLDivElement>('.app')!;
const btn = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
/** The Widen inspector button, whatever its label says now. */
const wbtn = () => host.querySelector<HTMLButtonElement>('button.widebtn')!;
const sep = (label: string) => host.querySelector<HTMLDivElement>(`[role=separator][aria-label="${label}"]`)!;
const now = (label: string) => Number(sep(label).getAttribute('aria-valuenow'));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
/** jsdom has no PointerEvent; React reads clientX and button from a MouseEvent of the same type. */
const pointer = (el: Element, type: string, x: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true })); });
const stored = () => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
const hello = () => useStore.getState().apply({ type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts'), file('src/b.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });

beforeEach(() => {
  resize(1440);
  lists.length = 0;
  window.matchMedia = ((media: string) => {
    const l = { media, listeners: new Set<Listener>(), last: evaluate(media) };
    lists.push(l);
    return {
      get matches() { return evaluate(media); },
      media,
      addEventListener: (_: string, fn: Listener) => l.listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => l.listeners.delete(fn),
    };
  }) as unknown as typeof window.matchMedia;
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  localStorage.clear();
  useStore.getState().reset();
  hello();
  renders = 0;
  dockRenders = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = realMatchMedia;
  vi.unstubAllGlobals();
});

describe('docked panels at 1080 px and wider', () => {
  it('the sidebar collapse button and the toolbar button collapse and expand the project panel', async () => {
    await mount();
    expect(app().classList.contains('left-collapsed')).toBe(false);
    expect(btn('Files').getAttribute('aria-expanded')).toBe('true');
    act(() => btn('Hide project panel').click());
    expect(app().classList.contains('left-collapsed')).toBe(true);
    expect(host.querySelector('aside.sidebar')!.hasAttribute('inert')).toBe(true);
    expect(btn('Files').getAttribute('aria-expanded')).toBe('false');
    expect(useStore.getState().panel).toBeNull();
    act(() => btn('Files').click());
    expect(app().classList.contains('left-collapsed')).toBe(false);
    expect(host.querySelector('aside.sidebar')!.hasAttribute('inert')).toBe(false);
  });

  it('the inspector collapse button and the toolbar button collapse and expand the inspector, in both views', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(host.querySelector('aside.insp')!.hasAttribute('inert')).toBe(true);
    expect(btn('Inspector').getAttribute('aria-expanded')).toBe('false');
    act(() => btn('Inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(false);
    act(() => useStore.getState().select('src/a.ts'));
    expect(host.querySelector('aside.insp .ins-scroll:not(.leave) h3')!.textContent).toBe('a.ts');
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });

  it('the toolbar buttons show state with a filled panel side at this width, not a pressed background', async () => {
    await mount();
    const filled = (label: string) => !!btn(label).querySelector('path[fill="currentColor"]');
    expect([filled('Files'), filled('Inspector')]).toEqual([true, true]);
    act(() => btn('Hide project panel').click());
    expect(filled('Files')).toBe(false);
    act(() => resize(900));
    expect([filled('Files'), filled('Inspector')]).toEqual([false, false]);
  });

  it('collapsing a panel that holds focus hands focus to its toolbar button', async () => {
    await mount();
    btn('Hide project panel').focus();
    act(() => btn('Hide project panel').click());
    expect(document.activeElement).toBe(btn('Files'));
  });

  it('arrow keys, Home, End, Enter and a double-click on the separator resize, collapse and reset', async () => {
    await mount();
    const files = sep('Resize project panel');
    expect(files.getAttribute('aria-orientation')).toBe('vertical');
    expect(files.tabIndex).toBe(0);
    expect(now('Resize project panel')).toBe(272);
    expect(files.getAttribute('aria-valuemin')).toBe('200');
    expect(files.getAttribute('aria-valuemax')).toBe('520');
    key(files, 'ArrowRight');
    expect(now('Resize project panel')).toBe(288);
    key(files, 'ArrowRight', { shiftKey: true });
    expect(now('Resize project panel')).toBe(352);
    key(files, 'ArrowLeft');
    expect(now('Resize project panel')).toBe(336);
    expect(app().style.getPropertyValue('--left-w')).toBe('336px');
    key(files, 'Home');
    expect(now('Resize project panel')).toBe(200);
    key(files, 'End');
    expect(now('Resize project panel')).toBe(520);
    act(() => { files.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(now('Resize project panel')).toBe(272);
    expect(stored().w.files).toBeNull();

    const insp = sep('Resize inspector');
    expect(now('Resize inspector')).toBe(384);
    key(insp, 'ArrowLeft');
    expect(now('Resize inspector')).toBe(400);
    expect(app().style.getPropertyValue('--right-w')).toBe('400px');
    key(insp, 'ArrowRight', { shiftKey: true });
    expect(now('Resize inspector')).toBe(336);

    insp.focus();
    key(insp, 'Enter');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(document.activeElement).toBe(btn('Inspector'));
  });

  it('End on the inspector handle goes to the widest the box allows, with no fixed maximum: the project panel gives way', async () => {
    resize(1920);
    await mount();
    const insp = sep('Resize inspector');
    expect(insp.getAttribute('aria-valuemax')).toBe(String(1896 - 420 - 12 - 212));
    key(insp, 'End');
    expect(now('Resize inspector')).toBe(1252);
    expect(now('Resize project panel')).toBe(200);
    expect(stored().w).toEqual({ files: null, inspector: 1252 });
  });

  it('Widen inspector expands it to its reach and restores both widths, in both views, with the collapse glide', async () => {
    resize(1920);
    await mount();
    const insp = sep('Resize inspector');
    key(insp, 'ArrowLeft', { shiftKey: true });
    expect(now('Resize inspector')).toBe(448);
    expect(wbtn().getAttribute('aria-label')).toBe('Widen inspector');
    expect(wbtn().title).toBe('Widen inspector');
    expect(app().classList.contains('glide')).toBe(false);
    act(() => wbtn().click());
    expect(app().classList.contains('glide')).toBe(true);
    expect([now('Resize project panel'), now('Resize inspector')]).toEqual([200, 1252]);
    expect(app().style.getPropertyValue('--right-w')).toBe('1252px');
    expect(wbtn().getAttribute('aria-label')).toBe('Restore inspector width');
    expect(wbtn().title).toBe('Restore inspector width');
    expect(stored()).toMatchObject({ w: { files: null, inspector: 448 }, wide: { w: { files: null, inspector: 448 }, last: 'inspector' } });
    // It follows the window while widened.
    act(() => resize(1440));
    expect(now('Resize inspector')).toBe(1416 - 444 - 200);
    // In the file view too.
    act(() => useStore.getState().select('src/a.ts'));
    expect(wbtn().getAttribute('aria-label')).toBe('Restore inspector width');
    act(() => wbtn().click());
    expect([now('Resize project panel'), now('Resize inspector')]).toEqual([272, 448]);
    expect(wbtn().getAttribute('aria-label')).toBe('Widen inspector');
    expect(stored().w.inspector).toBe(448);
    expect(stored().wide).toBeUndefined();
  });

  it('a reload keeps the widened state and the width to restore', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 500 }, last: 'inspector', wide: { w: { files: null, inspector: 500 } } }));
    useStore.getState().reset();
    hello();
    resize(1920);
    await mount();
    expect(now('Resize inspector')).toBe(1252);
    expect(wbtn().getAttribute('aria-label')).toBe('Restore inspector width');
    act(() => wbtn().click());
    expect(now('Resize inspector')).toBe(500);
  });

  it('a 980 px inspector set on a 1920 px screen gives way first on a 1440 px one: the project panel keeps its width', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 980 }, last: 'inspector', at: 1896 }));
    useStore.getState().reset();
    hello();
    await mount();
    expect([now('Resize project panel'), now('Resize inspector')]).toEqual([272, 1416 - 444 - 272]);
    act(() => resize(1920));
    expect([now('Resize project panel'), now('Resize inspector')]).toEqual([272, 980]);
  });

  it('dragging or keys on the handle while widened end the widened state: the new width is kept', async () => {
    resize(1920);
    await mount();
    act(() => wbtn().click());
    const insp = sep('Resize inspector');
    pointer(insp, 'pointerdown', 800);
    pointer(insp, 'pointermove', 1000);
    pointer(insp, 'pointerup', 1000);
    expect(now('Resize inspector')).toBe(1052);
    expect(wbtn().getAttribute('aria-label')).toBe('Widen inspector');
    expect(stored().w.inspector).toBe(1052);
    expect(stored().wide).toBeUndefined();
    act(() => resize(2200));
    expect(now('Resize inspector')).toBe(1052);

    act(() => wbtn().click());
    key(insp, 'ArrowRight');
    expect(now('Resize inspector')).toBe(2176 - 444 - 200 - 16);
    expect(stored().wide).toBeUndefined();
    // A double-click still resets to the default width, and ends the widened state.
    act(() => wbtn().click());
    act(() => { insp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(now('Resize inspector')).toBe(384);
    expect(stored().w.inspector).toBeNull();
    expect(stored().wide).toBeUndefined();
  });

  it('an input that changes nothing drawn keeps the widened state: End or ArrowLeft at reach, a click, a 0 px drag', async () => {
    resize(1920);
    await mount();
    act(() => wbtn().click());
    const insp = sep('Resize inspector');
    const before = localStorage.getItem(LAYOUT_KEY);
    key(insp, 'End');
    key(insp, 'ArrowLeft');
    pointer(insp, 'pointerdown', 800);
    pointer(insp, 'pointerup', 800);
    pointer(insp, 'pointerdown', 800);
    pointer(insp, 'pointermove', 800);
    pointer(insp, 'pointerup', 800);
    const files = sep('Resize project panel');
    key(files, 'Home');
    pointer(files, 'pointerdown', 300);
    pointer(files, 'pointermove', 300);
    pointer(files, 'pointerup', 300);
    expect(now('Resize inspector')).toBe(1252);
    expect(wbtn().getAttribute('aria-label')).toBe('Restore inspector width');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
  });

  it('dragging the project panel while a widened inspector is hidden keeps the width Widen replaced (1920 px)', async () => {
    resize(1920);
    await mount();
    act(() => wbtn().click());
    key(document.body, ']');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    pointer(files, 'pointermove', 340);
    pointer(files, 'pointerup', 340);
    expect(stored().wide).toBeUndefined();
    expect(stored().w).toEqual({ files: 312, inspector: null });
    key(document.body, ']');
    expect([now('Resize project panel'), now('Resize inspector')]).toEqual([312, 384]);
  });

  it('Widen with no room is aria-disabled, not disabled: focus stays on it and a click does nothing', async () => {
    resize(1920);
    await mount();
    wbtn().focus();
    act(() => useStore.getState().setLayout({ ...useStore.getState().layout, w: { files: null, inspector: 1252 }, last: 'inspector', at: 1896 }));
    expect(wbtn().getAttribute('aria-disabled')).toBe('true');
    expect(wbtn().disabled).toBe(false);
    expect(document.activeElement).toBe(wbtn());
    const before = localStorage.getItem(LAYOUT_KEY);
    act(() => wbtn().click());
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
    expect(app().classList.contains('glide')).toBe(false);
  });

  it('one glide, from the store: collapse and Widen glide and it ends; a drag, a resize or a reload never glides', async () => {
    await mount();
    expect(app().classList.contains('glide')).toBe(false);
    act(() => resize(1500));
    expect(app().classList.contains('glide')).toBe(false);
    act(() => btn('Hide project panel').click());
    expect(useStore.getState().glideUntil).toBeGreaterThan(Date.now());
    expect(app().classList.contains('glide')).toBe(true);
    await act(async () => { await new Promise(r => setTimeout(r, 600)); });
    expect(app().classList.contains('glide')).toBe(false);
    act(() => wbtn().click());
    expect(app().classList.contains('glide')).toBe(true);
    // A drag drops it at once and it does not come back after.
    pointer(sep('Resize inspector'), 'pointerdown', 800);
    expect(app().classList.contains('glide')).toBe(false);
    pointer(sep('Resize inspector'), 'pointerup', 800);
    expect(app().classList.contains('glide')).toBe(false);
  });

  it('Widen then Restore puts back exactly the layout it replaced (files 400, inspector 600, files resized last)', async () => {
    const before = { w: { files: 400, inspector: 600 }, collapsed: { files: false, inspector: false }, last: 'files', at: 1176 };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(before));
    useStore.getState().reset();
    hello();
    resize(1200);
    await mount();
    const widths = () => [now('Resize project panel'), now('Resize inspector')];
    expect(widths()).toEqual([400, 332]);
    act(() => wbtn().click());
    expect(widths()).toEqual([200, 532]);
    act(() => wbtn().click());
    expect(widths()).toEqual([400, 332]);
    expect(stored()).toEqual(before);
  });

  it('collapsing a widened inspector keeps its width while it slides away', async () => {
    resize(1920);
    await mount();
    act(() => wbtn().click());
    expect(app().style.getPropertyValue('--right-w')).toBe('1252px');
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(app().style.getPropertyValue('--right-w')).toBe('1252px');
    expect(app().style.getPropertyValue('--left-w')).toBe('272px');
  });

  it('only the Widen button glides: a key or drag that ends the widened state does not', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ last: 'inspector', wide: { w: { files: null, inspector: null } } }));
    useStore.getState().reset();
    hello();
    resize(1920);
    await mount();
    expect(app().classList.contains('glide')).toBe(false);
    key(sep('Resize inspector'), 'ArrowRight', { shiftKey: true });
    expect(stored().wide).toBeUndefined();
    expect(app().classList.contains('glide')).toBe(false);
    act(() => wbtn().click());
    expect(app().classList.contains('glide')).toBe(true);
  });

  it('a drag that starts widened writes the new width on its first pointermove', async () => {
    resize(1920);
    await mount();
    act(() => wbtn().click());
    const insp = sep('Resize inspector');
    pointer(insp, 'pointerdown', 800);
    let seen = '';
    act(() => {
      insp.dispatchEvent(new MouseEvent('pointermove', { clientX: 900, button: 0, bubbles: true, cancelable: true }));
      // Before React renders: the store subscriber has already written it.
      seen = app().style.getPropertyValue('--right-w');
    });
    expect(seen).toBe('1152px');
    pointer(insp, 'pointerup', 900);
  });

  it('Widen is disabled when the inspector is within 24 px of its reach, and stores nothing', async () => {
    resize(1920);
    await mount();
    const insp = sep('Resize inspector');
    key(insp, 'End');
    expect(wbtn().getAttribute('aria-disabled')).toBe('true');
    expect(wbtn().title).toBe('No room to widen');
    const before = localStorage.getItem(LAYOUT_KEY);
    act(() => wbtn().click());
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
    key(insp, 'ArrowRight');
    expect(now('Resize inspector')).toBe(1236);
    expect(wbtn().getAttribute('aria-disabled')).toBe('true');
    key(insp, 'ArrowRight');
    expect(wbtn().hasAttribute('aria-disabled')).toBe(false);
    expect(wbtn().title).toBe('Widen inspector');
  });

  it('keeps the center at least 420 px wide, with the panels and the window', async () => {
    await mount();
    const center = (w: number) => w - (now('Resize project panel') + 12) - (now('Resize inspector') + 12);
    key(sep('Resize inspector'), 'End');
    expect(center(1416)).toBeGreaterThanOrEqual(420);
    expect(center(1416)).toBeLessThanOrEqual(421);
    act(() => btn('Hide project panel').click());
    key(sep('Resize inspector'), 'End');
    expect(now('Resize inspector')).toBe(1416 - 420 - 12);
    act(() => btn('Files').click());
    expect(center(1416)).toBeGreaterThanOrEqual(420);
    act(() => resize(1100));
    expect(center(1076)).toBeGreaterThanOrEqual(420);
  });

  it('a drag follows the pointer, also in a squeezed window (stored inspector 720 at 1200 px)', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 720 }, last: 'inspector', at: 1176 }));
    useStore.getState().reset();
    hello();
    resize(1200);
    await mount();
    const files = sep('Resize project panel');
    const start = now('Resize project panel');
    expect(start).toBeLessThan(248);
    pointer(files, 'pointerdown', 100);
    for (let dx = 1; dx <= 40; dx++) {
      pointer(files, 'pointermove', 100 + dx);
      expect(now('Resize project panel')).toBe(start + dx);
    }
    pointer(files, 'pointerup', 140);
    expect(now('Resize project panel')).toBe(start + 40);
    // Persisted: the same drawing after a reload at this size.
    const l = useStore.getState().layout;
    expect(fitLayout(l, 1176, 1200).files).toBe(start + 40);
  });

  it('a click on the handle without moving saves nothing; keys save only when the drawn width changes', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { files: 520 } }));
    useStore.getState().reset();
    hello();
    resize(1100);
    await mount();
    const files = sep('Resize project panel');
    const before = localStorage.getItem(LAYOUT_KEY);
    pointer(files, 'pointerdown', 300);
    pointer(files, 'pointermove', 300);
    pointer(files, 'pointerup', 300);
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
    // End draws the widest this box allows (the inspector gives way) and stores exactly that.
    key(files, 'End');
    expect(now('Resize project panel')).toBe(1076 - 420 - 12 - (300 + 12));
    expect(stored().w.files).toBe(332);
    const after = localStorage.getItem(LAYOUT_KEY);
    key(files, 'ArrowRight');
    key(files, 'End');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(after);
  });

  it('what a drag shows is what is stored: 300 in a squeezed window stays 300 when the window grows', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 720 }, last: 'inspector', at: 1176 }));
    useStore.getState().reset();
    hello();
    resize(1200);
    await mount();
    const files = sep('Resize project panel');
    expect(now('Resize project panel')).toBe(200);
    pointer(files, 'pointerdown', 100);
    pointer(files, 'pointermove', 200);
    pointer(files, 'pointerup', 200);
    expect(now('Resize project panel')).toBe(300);
    expect(stored().w).toEqual({ files: 300, inspector: 720 });
    act(() => resize(1920));
    expect(now('Resize project panel')).toBe(300);
    expect(now('Resize inspector')).toBe(720);
  });

  it('the drag is a state the .app class follows: it survives re-renders and stops the collapse glide', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('glide')).toBe(true);
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    expect(app().classList.contains('resizing')).toBe(true);
    expect(app().classList.contains('glide')).toBe(false);
    act(() => btn('Inspector').click());
    pointer(files, 'pointermove', 310);
    expect(app().classList.contains('resizing')).toBe(true);
    expect(app().classList.contains('glide')).toBe(false);
    pointer(files, 'pointerup', 310);
    expect(app().classList.contains('resizing')).toBe(false);
    expect(app().classList.contains('glide')).toBe(false);
  });

  it('the stored layout applies on first paint: no glide, the widths set, and a toggle right away sticks', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 500 }, collapsed: { files: true } }));
    useStore.getState().reset();
    hello();
    act(() => root.render(<Shell />));
    expect(app().classList.contains('left-collapsed')).toBe(true);
    expect(app().classList.contains('glide')).toBe(false);
    expect(app().style.getPropertyValue('--right-w')).toBe('500px');
    key(document.body, ']');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(stored().collapsed).toEqual({ files: true, inspector: true });
  });

  it('a toggle made before anything else settles is never undone by a later load', async () => {
    act(() => root.render(<Shell />));
    key(document.body, '[');
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(app().classList.contains('left-collapsed')).toBe(true);
    expect(stored().collapsed.files).toBe(true);
  });

  it('the Dock itself does not re-render while a panel edge is dragged', async () => {
    await mount();
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    const base = dockRenders;
    for (let x = 301; x < 340; x += 3) pointer(files, 'pointermove', x);
    expect(now('Resize project panel')).toBe(272 + 37);
    expect(dockRenders).toBe(base);
    pointer(files, 'pointerup', 340);
  });

  it('a lost pointer capture or a window blur ends the drag', async () => {
    await mount();
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    pointer(files, 'pointermove', 320);
    expect(app().classList.contains('resizing')).toBe(true);
    act(() => { files.dispatchEvent(new Event('lostpointercapture', { bubbles: true })); });
    expect(app().classList.contains('resizing')).toBe(false);
    expect(stored().w.files).toBe(292);
    pointer(files, 'pointermove', 360);
    expect(now('Resize project panel')).toBe(292);

    pointer(files, 'pointerdown', 300);
    expect(useStore.getState().dock.dragging).toBe(true);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(useStore.getState().dock.dragging).toBe(false);
    expect(app().classList.contains('resizing')).toBe(false);
  });

  it('a drag and a window resize re-render the Dock and handles, not the panels and center', async () => {
    await mount();
    const base = renders;
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    for (let x = 301; x < 340; x += 3) pointer(files, 'pointermove', x);
    pointer(files, 'pointerup', 340);
    act(() => resize(1300));
    expect(now('Resize project panel')).toBeGreaterThan(272);
    expect(renders).toBe(base);
  });

  it('fits the measured .app box, not the viewport', async () => {
    await mount();
    // 1416 - 420 center - 12 gap - (200 + 12) for the project panel at its minimum.
    expect(sep('Resize inspector').getAttribute('aria-valuemax')).toBe('772');
    // Safe-area insets or a larger gutter: the box is narrower than the viewport minus 24.
    Object.defineProperty(app(), 'clientWidth', { configurable: true, value: 1200 });
    act(() => observers.forEach(fn => fn([])));
    expect(sep('Resize inspector').getAttribute('aria-valuemax')).toBe(String(1200 - 420 - 12 - 212));
    key(sep('Resize inspector'), 'End');
    expect(now('Resize inspector')).toBe(556);
    expect(now('Resize project panel')).toBe(200);
    expect(1200 - (now('Resize project panel') + 12) - (now('Resize inspector') + 12)).toBe(420);
  });

  it('reset keeps the measured box and an ongoing drag', async () => {
    await mount();
    Object.defineProperty(app(), 'clientWidth', { configurable: true, value: 1300 });
    act(() => observers.forEach(fn => fn([])));
    pointer(sep('Resize project panel'), 'pointerdown', 300);
    act(() => useStore.getState().reset());
    expect(useStore.getState().dock).toEqual({ width: 1300, vw: 1440, dragging: true });
    pointer(sep('Resize project panel'), 'pointerup', 300);
  });

  it('[ and ] toggle the panels, but not while typing in the filter or with the palette open', async () => {
    await mount();
    key(document.body, '[');
    expect(app().classList.contains('left-collapsed')).toBe(true);
    key(document.body, ']');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    key(document.body, ']');
    key(document.body, '[');
    expect(app().className).not.toMatch(/collapsed/);

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter files and functions"]')!;
    input.focus();
    key(input, '[');
    key(input, ']');
    expect(app().className).not.toMatch(/collapsed/);

    input.blur();
    act(() => useStore.getState().setPalette(true));
    key(document.body, '[');
    expect(app().classList.contains('left-collapsed')).toBe(false);
    act(() => useStore.getState().setPalette(false));
    key(document.body, '[', { ctrlKey: true });
    key(document.body, '[', { metaKey: true });
    expect(app().classList.contains('left-collapsed')).toBe(false);
  });

  it('selecting a file shows a collapsed inspector for the session, without saving it, in one update', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    expect(stored().collapsed.inspector).toBe(true);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    let updates = 0;
    const off = useStore.subscribe(() => { updates++; });
    act(() => host.querySelector<HTMLButtonElement>('[data-file="src/a.ts"]')!.click());
    expect(app().classList.contains('right-collapsed')).toBe(false);
    expect(btn('Inspector').getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('aside.insp')!.hasAttribute('inert')).toBe(false);
    updates = 0;
    act(() => useStore.getState().revealLine('src/b.ts', 3));
    expect(updates).toBe(1);
    off();
    expect(setItem).not.toHaveBeenCalled();
    expect(stored().collapsed.inspector).toBe(true);
    setItem.mockRestore();
    // An explicit toggle ends the peek: the inspector hides and stays hidden.
    act(() => btn('Inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
    act(() => useStore.getState().select(null));
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });

  it('a peek ends whenever the selection goes away: Live session, a deleted file, a new state without it', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    const peek = () => act(() => useStore.getState().select('src/a.ts'));
    const hidden = () => app().classList.contains('right-collapsed');

    peek();
    expect(hidden()).toBe(false);
    // A peek glides like an expand.
    expect(app().classList.contains('glide')).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('.backbtn')!.click());
    expect(hidden()).toBe(true);

    peek();
    act(() => useStore.getState().apply({ type: 'files', files: [], removed: ['src/a.ts'] }));
    expect(useStore.getState().selected).toBeNull();
    expect(hidden()).toBe(true);

    hello();
    peek();
    act(() => useStore.getState().apply({ type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/b.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } }));
    expect(hidden()).toBe(true);

    // Rewound to before the file existed: the selection stays (for going back to live), the peek does not show.
    hello();
    peek();
    act(() => useStore.getState().rewind({ seq: 1, at: 1, root: '/p/shop', name: 'shop', files: [file('src/b.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } }));
    expect(useStore.getState().selected).toBe('src/a.ts');
    expect(hidden()).toBe(true);
    expect(stored().collapsed.inspector).toBe(true);
  });

  it('a selection at narrow width peeks too: widening with the file selected shows the collapsed inspector', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => resize(900));
    act(() => useStore.getState().select('src/a.ts'));
    act(() => resize(1440));
    expect(app().classList.contains('right-collapsed')).toBe(false);
    expect(stored().collapsed.inspector).toBe(true);
  });

  it('when a peek ends with focus in the inspector, focus goes to the toolbar Inspector button', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => useStore.getState().select('src/a.ts'));
    const back = host.querySelector<HTMLButtonElement>('aside.insp .backbtn')!;
    back.focus();
    act(() => back.click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(document.activeElement).toBe(btn('Inspector'));

    // The selected file is deleted while focus is in the inspector.
    act(() => useStore.getState().select('src/b.ts'));
    host.querySelector<HTMLButtonElement>('aside.insp .backbtn')!.focus();
    act(() => useStore.getState().apply({ type: 'files', files: [], removed: ['src/b.ts'] }));
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(document.activeElement).toBe(btn('Inspector'));

    // Focus elsewhere stays put.
    act(() => useStore.getState().select('src/a.ts'));
    const filter = host.querySelector<HTMLInputElement>('input[aria-label="Filter files and functions"]')!;
    filter.focus();
    act(() => useStore.getState().select(null));
    expect(document.activeElement).toBe(filter);
  });

  it('two pointer moves before a render: the second (back to the start) still applies', async () => {
    await mount();
    const files = sep('Resize project panel');
    pointer(files, 'pointerdown', 300);
    act(() => {
      files.dispatchEvent(new MouseEvent('pointermove', { clientX: 320, button: 0, bubbles: true }));
      files.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, button: 0, bubbles: true }));
    });
    expect(now('Resize project panel')).toBe(272);
    pointer(files, 'pointerup', 300);
  });

  it('[ and ] ignore modifiers, the Gate, and every form control', async () => {
    await mount();
    const collapsed = () => app().className.includes('collapsed');
    // Ctrl or Meta shortcuts are not brackets.
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { metaKey: true, altKey: true }]) {
      key(document.body, '[', mod);
      key(document.body, ']', mod);
    }
    expect(collapsed()).toBe(false);
    // Layouts that type brackets with AltGr (Ctrl+Alt on Windows), Option or Shift: e.key is the bracket, so it counts.
    key(document.body, '[', { ctrlKey: true, altKey: true });
    expect(app().classList.contains('left-collapsed')).toBe(true);
    key(document.body, '[', { altKey: true });
    key(document.body, ']', { shiftKey: true });
    expect(app().classList.contains('left-collapsed')).toBe(false);
    expect(app().classList.contains('right-collapsed')).toBe(true);
    key(document.body, ']');
    expect(collapsed()).toBe(false);

    act(() => useStore.getState().setConnection('unauthorized'));
    key(document.body, '[');
    expect(collapsed()).toBe(false);
    act(() => useStore.getState().setConnection('open'));

    const controls = [
      Object.assign(document.createElement('input'), { type: 'checkbox' }),
      document.createElement('select'),
      document.createElement('textarea'),
      Object.assign(document.createElement('div'), { tabIndex: 0 }),
      Object.assign(document.createElement('div'), { tabIndex: 0 }),
    ];
    // jsdom does not reflect the contentEditable property; the attribute is what the check reads.
    controls[3].setAttribute('contenteditable', 'true');
    controls[4].setAttribute('role', 'combobox');
    for (const el of controls) {
      host.appendChild(el);
      el.focus();
      key(el, '[');
      expect(collapsed()).toBe(false);
      el.remove();
    }
    key(document.body, '[');
    expect(collapsed()).toBe(true);
  });

  it('two key presses before a render both apply', async () => {
    await mount();
    const files = sep('Resize project panel');
    act(() => {
      files.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      files.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(now('Resize project panel')).toBe(272 + 32);
  });

  it('a live deletion of the peeked file ends the peek; the file coming back does not reopen the inspector', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => useStore.getState().select('src/a.ts'));
    expect(useStore.getState().peek).toBe('src/a.ts');
    expect(app().classList.contains('right-collapsed')).toBe(false);
    act(() => useStore.getState().apply({ type: 'files', files: [], removed: ['src/a.ts'] }));
    expect(useStore.getState().peek).toBeNull();
    expect(app().classList.contains('right-collapsed')).toBe(true);
    act(() => useStore.getState().apply({ type: 'files', files: [file('src/a.ts')], removed: [] }));
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });

  it('scrubbing past the peeked file\'s deletion keeps the peek: back to live with the file, the inspector shows', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => useStore.getState().select('src/a.ts'));
    const state = (files: string[]) => ({ root: '/p/shop', name: 'shop', files: files.map(f => file(f)), changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });
    act(() => useStore.getState().rewind({ ...state(['src/b.ts']), seq: 1, at: 1 }));
    expect(useStore.getState().selected).toBe('src/a.ts');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(useStore.getState().peek).toBe('src/a.ts');
    setHistorySource({ ...restHistorySource, live: async () => ({ ...state(['src/a.ts', 'src/b.ts']), seq: 2 }) });
    try {
      await act(async () => { await useStore.getState().backToLive(); });
    } finally {
      setHistorySource(restHistorySource);
    }
    expect(useStore.getState().rewound).toBeNull();
    expect(app().classList.contains('right-collapsed')).toBe(false);
    expect(stored().collapsed.inspector).toBe(true);
  });

});

describe('below 1080 px', () => {
  it('the toolbar buttons and [ ] still drive the slide-overs, and collapsed state is ignored', async () => {
    await mount();
    act(() => btn('Hide project panel').click());
    act(() => resize(900));
    expect(host.querySelector('aside.sidebar')!.hasAttribute('inert')).toBe(true);
    expect(btn('Files').getAttribute('aria-expanded')).toBe('false');
    act(() => btn('Files').click());
    expect(useStore.getState().panel).toBe('files');
    expect(host.querySelector('aside.sidebar')!.hasAttribute('inert')).toBe(false);
    expect(btn('Files').getAttribute('aria-expanded')).toBe('true');
    act(() => btn('Files').click());
    expect(useStore.getState().panel).toBeNull();
    expect(useStore.getState().layout.collapsed.files).toBe(true);

    key(document.body, ']');
    expect(useStore.getState().panel).toBe('inspector');
    key(document.body, ']');
    expect(useStore.getState().panel).toBeNull();
    expect(useStore.getState().layout.collapsed.inspector).toBe(false);
  });

  it('has no Widen inspector button: the inspector is a slide-over', async () => {
    await mount();
    expect(wbtn()).not.toBeNull();
    act(() => resize(900));
    expect(wbtn()).toBeNull();
    act(() => useStore.getState().select('src/a.ts'));
    expect(wbtn()).toBeNull();
    act(() => resize(1440));
    expect(wbtn()).not.toBeNull();
  });

  it('selecting a file does not touch the stored docked state', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => resize(900));
    act(() => useStore.getState().select('src/a.ts'));
    expect(useStore.getState().layout.collapsed.inspector).toBe(true);
    expect(stored().collapsed.inspector).toBe(true);
  });
});
