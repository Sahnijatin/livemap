// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, emptyDomain } from '../fixtures';
import { LAYOUT_KEY, LIMITS, fitLayout } from '../panelLayout';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn(), fetchFile: vi.fn(() => new Promise(() => {})) }));
const { Toolbar } = await import('./Toolbar');
const { FileTree } = await import('./FileTree');
const { Inspector, loadDetail } = await import('./Inspector');
// The file view loads after first paint in the app; load it up front so a selection renders at once.
await loadDetail();
const { Dock } = await import('./Dock');
const { PanelHandle, loadDrag } = await import('./PanelHandle');
const { useSlideOvers } = await import('../panels');
// The handles' drag and key code loads on first focus or pointerdown; load it up front so key events apply at once.
await loadDrag();

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
function resize(w: number) {
  width = w;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
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

  it('keeps the center at least 420 px wide, with the panels and the window', async () => {
    await mount();
    const center = (w: number) => w - (now('Resize project panel') + 12) - (now('Resize inspector') + 12);
    key(sep('Resize inspector'), 'End');
    expect(center(1416)).toBeGreaterThanOrEqual(420);
    expect(center(1416)).toBeLessThanOrEqual(421);
    act(() => btn('Hide project panel').click());
    key(sep('Resize inspector'), 'End');
    expect(now('Resize inspector')).toBe(720);
    act(() => btn('Files').click());
    expect(center(1416)).toBeGreaterThanOrEqual(420);
    act(() => resize(1100));
    expect(center(1076)).toBeGreaterThanOrEqual(420);
  });

  it('a drag follows the pointer, also in a squeezed window (stored inspector 720 at 1200 px)', async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ w: { inspector: 720 } }));
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
    // Already as wide as this window allows: End and Right change nothing, so the 520 survives.
    key(files, 'End');
    key(files, 'ArrowRight');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
    act(() => resize(1920));
    expect(now('Resize project panel')).toBe(520);
    key(files, 'ArrowLeft');
    expect(stored().w.files).toBe(504);
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
    const observers: ((entries: unknown[]) => void)[] = [];
    const notify = () => observers.forEach(fn => fn([]));
    vi.stubGlobal('ResizeObserver', class { constructor(fn: (entries: unknown[]) => void) { observers.push(fn); } observe() {} unobserve() {} disconnect() {} });
    await mount();
    expect(sep('Resize inspector').getAttribute('aria-valuemax')).toBe(String(fitLayout({ w: { files: null, inspector: LIMITS.inspector[1] }, collapsed: { files: false, inspector: false } }, 1416, 1440).inspector));
    // Safe-area insets or a larger gutter: the box is narrower than the viewport minus 24.
    Object.defineProperty(app(), 'clientWidth', { configurable: true, value: 1200 });
    act(() => notify());
    const max = Number(sep('Resize inspector').getAttribute('aria-valuemax'));
    expect(max).toBe(fitLayout({ w: { files: null, inspector: LIMITS.inspector[1] }, collapsed: { files: false, inspector: false } }, 1200, 1440).inspector);
    key(sep('Resize inspector'), 'End');
    expect(1200 - (now('Resize project panel') + 12) - (now('Resize inspector') + 12)).toBeGreaterThanOrEqual(420);
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

  it('selecting a file does not touch the stored docked state', async () => {
    await mount();
    act(() => btn('Hide inspector').click());
    act(() => resize(900));
    act(() => useStore.getState().select('src/a.ts'));
    expect(useStore.getState().layout.collapsed.inspector).toBe(true);
    expect(stored().collapsed.inspector).toBe(true);
  });
});
