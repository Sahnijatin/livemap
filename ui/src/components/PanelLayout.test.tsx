// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, emptyDomain } from '../fixtures';
import { LAYOUT_KEY } from '../panelLayout';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn(), fetchFile: vi.fn(() => new Promise(() => {})) }));
const { Toolbar } = await import('./Toolbar');
const { FileTree } = await import('./FileTree');
const { Inspector } = await import('./Inspector');
const { PanelHandle, useDockLayout } = await import('./PanelHandle');
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

/** App's shell: the toolbar, both panels, both handles and the layout classes and widths on `.app`. */
function Shell() {
  useSlideOvers();
  const dock = useDockLayout();
  return (
    <div className={dock.className} style={dock.style}>
      <Toolbar />
      <FileTree />
      <PanelHandle panel="files" />
      <main className="center" />
      <PanelHandle panel="inspector" />
      <Inspector />
    </div>
  );
}

const app = () => host.querySelector<HTMLDivElement>('.app')!;
const btn = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const sep = (label: string) => host.querySelector<HTMLDivElement>(`[role=separator][aria-label="${label}"]`)!;
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = realMatchMedia;
});

describe('docked panels at 1080 px and wider', () => {
  it('the sidebar collapse button and the toolbar button collapse and expand the project panel', () => {
    act(() => root.render(<Shell />));
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
    expect(useStore.getState().panel).toBeNull();
  });

  it('the inspector collapse button and the toolbar button collapse and expand the inspector, in both views', () => {
    act(() => root.render(<Shell />));
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(host.querySelector('aside.insp')!.hasAttribute('inert')).toBe(true);
    expect(btn('Inspector').getAttribute('aria-expanded')).toBe('false');
    act(() => btn('Inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(false);
    // The file view has the button too.
    act(() => useStore.getState().select('src/a.ts'));
    expect(host.querySelector('aside.insp .ins-scroll:not(.leave) h3')!.textContent).toBe('a.ts');
    act(() => btn('Hide inspector').click());
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });

  it('collapsing a panel that holds focus hands focus to its toolbar button', () => {
    act(() => root.render(<Shell />));
    btn('Hide project panel').focus();
    act(() => btn('Hide project panel').click());
    expect(document.activeElement).toBe(btn('Files'));
  });

  it('arrow keys, Home, End, Enter and a double-click on the separator resize, collapse and reset', () => {
    act(() => root.render(<Shell />));
    const files = sep('Resize project panel');
    expect(files.getAttribute('aria-orientation')).toBe('vertical');
    expect(files.tabIndex).toBe(0);
    expect(files.getAttribute('aria-valuenow')).toBe('272');
    expect(files.getAttribute('aria-valuemin')).toBe('200');
    expect(files.getAttribute('aria-valuemax')).toBe('520');
    key(files, 'ArrowRight');
    expect(files.getAttribute('aria-valuenow')).toBe('288');
    key(files, 'ArrowRight', { shiftKey: true });
    expect(files.getAttribute('aria-valuenow')).toBe('352');
    key(files, 'ArrowLeft');
    expect(files.getAttribute('aria-valuenow')).toBe('336');
    expect(app().style.getPropertyValue('--left-w')).toBe('336px');
    key(files, 'Home');
    expect(files.getAttribute('aria-valuenow')).toBe('200');
    key(files, 'End');
    expect(files.getAttribute('aria-valuenow')).toBe('520');
    act(() => { files.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(files.getAttribute('aria-valuenow')).toBe('272');

    // The inspector's handle is on its left edge: Left widens it.
    const insp = sep('Resize inspector');
    expect(insp.getAttribute('aria-valuenow')).toBe('384');
    key(insp, 'ArrowLeft');
    expect(insp.getAttribute('aria-valuenow')).toBe('400');
    expect(app().style.getPropertyValue('--right-w')).toBe('400px');
    key(insp, 'ArrowRight', { shiftKey: true });
    expect(insp.getAttribute('aria-valuenow')).toBe('336');

    insp.focus();
    key(insp, 'Enter');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    expect(document.activeElement).toBe(btn('Inspector'));
  });

  it('keeps the center at least 420 px: the max follows the other panel and the window', () => {
    act(() => root.render(<Shell />));
    const insp = sep('Resize inspector');
    key(insp, 'End');
    // 1440 - 24 gutters - 420 center - 12 gap - (272 + 12) sidebar = 700.
    expect(insp.getAttribute('aria-valuenow')).toBe('700');
    act(() => btn('Hide project panel').click());
    key(insp, 'End');
    expect(insp.getAttribute('aria-valuenow')).toBe('720');
    act(() => btn('Files').click());
    // The sidebar comes back; the inspector gives up room so the center keeps its minimum.
    const center = () => 1440 - 24 - (Number(sep('Resize project panel').getAttribute('aria-valuenow')) + 12) - (Number(insp.getAttribute('aria-valuenow')) + 12);
    expect(center()).toBeGreaterThanOrEqual(420);
    act(() => resize(1100));
    expect(1100 - 24 - (Number(sep('Resize project panel').getAttribute('aria-valuenow')) + 12) - (Number(insp.getAttribute('aria-valuenow')) + 12)).toBeGreaterThanOrEqual(420);
  });

  it('remembers widths and collapsed state in localStorage', () => {
    act(() => root.render(<Shell />));
    key(sep('Resize project panel'), 'ArrowRight');
    act(() => btn('Hide inspector').click());
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual({ w: { files: 288, inspector: null }, collapsed: { files: false, inspector: true } });
    act(() => root.unmount());
    useStore.getState().reset();
    hello();
    root = createRoot(host);
    act(() => root.render(<Shell />));
    expect(sep('Resize project panel').getAttribute('aria-valuenow')).toBe('288');
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });

  it('[ and ] toggle the panels, but not while typing in the filter or with the palette open', () => {
    act(() => root.render(<Shell />));
    key(document.body, '[');
    expect(app().classList.contains('left-collapsed')).toBe(true);
    key(document.body, ']');
    expect(app().classList.contains('right-collapsed')).toBe(true);
    key(document.body, ']');
    expect(app().classList.contains('right-collapsed')).toBe(false);
    key(document.body, '[');
    expect(app().classList.contains('left-collapsed')).toBe(false);

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

  it('selecting a file expands a collapsed inspector', () => {
    act(() => root.render(<Shell />));
    act(() => btn('Hide inspector').click());
    act(() => host.querySelector<HTMLButtonElement>('[data-file="src/a.ts"]')!.click());
    expect(useStore.getState().selected).toBe('src/a.ts');
    expect(app().classList.contains('right-collapsed')).toBe(false);
    // From anywhere (Map card, palette): through the store.
    act(() => btn('Hide inspector').click());
    act(() => useStore.getState().revealLine('src/b.ts', 3));
    expect(app().classList.contains('right-collapsed')).toBe(false);
    act(() => btn('Hide inspector').click());
    act(() => useStore.getState().select(null));
    expect(app().classList.contains('right-collapsed')).toBe(true);
  });
});

describe('below 1080 px', () => {
  it('the toolbar buttons and [ ] still drive the slide-overs, and collapsed state is ignored', () => {
    act(() => root.render(<Shell />));
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

  it('selecting a file does not touch the docked state', () => {
    act(() => root.render(<Shell />));
    act(() => btn('Hide inspector').click());
    act(() => resize(900));
    act(() => useStore.getState().select('src/a.ts'));
    expect(useStore.getState().layout.collapsed.inspector).toBe(true);
  });
});
