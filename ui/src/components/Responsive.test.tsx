// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../store';
import { file, emptyDomain } from '../fixtures';

vi.mock('../api', () => ({ addFlag: vi.fn(), removeFlag: vi.fn(), setPaused: vi.fn(), fetchFile: vi.fn(() => new Promise(() => {})) }));
const { Toolbar } = await import('./Toolbar');
const { FileTree } = await import('./FileTree');
const { useSlideOvers, closePanel, panelAfterSelect } = await import('../panels');
const { MapTools } = await import('../map/MapTools');
const { Inspector } = await import('./Inspector');
const { CenterTabs } = await import('./CenterTabs');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A matchMedia stand-in driven by a fake viewport width; `resize` fires change events like a browser. */
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
  for (const l of lists) {
    const m = evaluate(l.media);
    if (m === l.last) continue;
    l.last = m;
    for (const fn of l.listeners) fn({ matches: m, media: l.media });
  }
}
const realMatchMedia = window.matchMedia;

let host: HTMLDivElement;
let root: Root;

/** The App's slide-over wiring with stand-in panels (the real ones are covered further down). */
function Shell() {
  useSlideOvers();
  const panel = useStore(s => s.panel);
  return (
    <>
      <Toolbar />
      <aside data-panel="files" tabIndex={-1} className={panel === 'files' ? 'open' : ''}><button type="button" id="in-files">row</button></aside>
      <aside data-panel="inspector" tabIndex={-1} className={panel === 'inspector' ? 'open' : ''}><button type="button" id="in-insp">x</button></aside>
      <div className={panel ? 'scrim open' : 'scrim'} onClick={() => closePanel()} />
    </>
  );
}

const btn = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  width = 1440;
  lists.length = 0;
  window.matchMedia = ((media: string) => {
    const l = { media, listeners: new Set<Listener>(), last: evaluate(media) };
    lists.push(l);
    return {
      get matches() { return evaluate(media); },
      media,
      addEventListener: (_: string, fn: Listener) => l.listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => l.listeners.delete(fn),
      addListener: (fn: Listener) => l.listeners.add(fn),
      removeListener: (fn: Listener) => l.listeners.delete(fn),
    };
  }) as unknown as typeof window.matchMedia;
  localStorage.clear();
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.matchMedia = realMatchMedia;
});

describe('slide-over panels below 1080 px', () => {
  it('opening a slide-over from its toolbar button moves focus into the panel', () => {
    resize(900);
    act(() => root.render(<Shell />));
    btn('Files').focus();
    act(() => btn('Files').click());
    expect(document.activeElement).toBe(host.querySelector('[data-panel="files"]'));
    act(() => btn('Inspector').click());
    expect(document.activeElement).toBe(host.querySelector('[data-panel="inspector"]'));
    // A second press on the open panel's button closes it and keeps focus on the button.
    btn('Inspector').focus();
    act(() => btn('Inspector').click());
    expect(useStore.getState().panel).toBeNull();
    expect(document.activeElement).toBe(btn('Inspector'));
  });

  // The toolbar buttons show at every width: at 1080 px and wider they collapse and expand the docked panels.
  it('resizing to wide with the sidebar open closes it and returns focus to the Files button', () => {
    resize(900);
    act(() => root.render(<Shell />));
    act(() => btn('Files').click());
    expect(useStore.getState().panel).toBe('files');
    btn('Files').focus();
    act(() => resize(1300));
    expect(useStore.getState().panel).toBeNull();
    expect(host.querySelector('.scrim.open')).toBeNull();
    expect(document.activeElement).toBe(btn('Files'));
  });

  it('resizing to wide with focus inside the inspector keeps focus there, now docked; collapsed, it goes to the button', () => {
    resize(390);
    act(() => root.render(<Shell />));
    act(() => btn('Inspector').click());
    host.querySelector<HTMLButtonElement>('#in-insp')!.focus();
    act(() => resize(1440));
    expect(useStore.getState().panel).toBeNull();
    expect(document.activeElement!.id).toBe('in-insp');

    const { layout } = useStore.getState();
    act(() => useStore.getState().setLayout({ ...layout, collapsed: { ...layout.collapsed, inspector: true } }));
    act(() => resize(390));
    act(() => btn('Inspector').click());
    host.querySelector<HTMLButtonElement>('#in-insp')!.focus();
    act(() => resize(1440));
    expect(document.activeElement).toBe(btn('Inspector'));
  });

  it('a resize that stays narrow, or a wide resize with nothing open, leaves focus and state alone', () => {
    resize(900);
    act(() => root.render(<Shell />));
    act(() => btn('Files').click());
    host.querySelector<HTMLButtonElement>('#in-files')!.focus();
    act(() => resize(700));
    expect(useStore.getState().panel).toBe('files');
    expect(document.activeElement!.id).toBe('in-files');
    act(() => useStore.getState().setPanel(null));
    const other = document.createElement('button');
    host.appendChild(other);
    other.focus();
    act(() => resize(1300));
    expect(document.activeElement).toBe(other);
  });

  it('Esc and a scrim click close the panel and give focus back to its button', () => {
    resize(900);
    act(() => root.render(<Shell />));
    act(() => btn('Files').click());
    host.querySelector<HTMLButtonElement>('#in-files')!.focus();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(useStore.getState().panel).toBeNull();
    expect(document.activeElement).toBe(btn('Files'));

    act(() => btn('Inspector').click());
    expect(host.querySelector('.scrim.open')).not.toBeNull();
    act(() => host.querySelector<HTMLDivElement>('.scrim')!.click());
    expect(useStore.getState().panel).toBeNull();
  });

  it('Esc leaves the panel open while the palette is open (the palette closes first)', () => {
    resize(900);
    act(() => root.render(<Shell />));
    act(() => btn('Files').click());
    act(() => useStore.getState().setPalette(true));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(useStore.getState().panel).toBe('files');
  });
});

describe('selecting a file in the sidebar', () => {
  it('closes the sidebar below 1080 px, opens the inspector on a phone, and leaves wide layouts alone', () => {
    resize(900);
    expect(panelAfterSelect()).toBeNull();
    resize(640);
    expect(panelAfterSelect()).toBe('inspector');
    resize(360);
    expect(panelAfterSelect()).toBe('inspector');
    resize(1080);
    expect(panelAfterSelect()).toBeUndefined();
  });

  it('in the real tree: at 900 px the sidebar closes; at 390 px the inspector opens', () => {
    vi.useFakeTimers();
    try {
      useStore.getState().apply({ type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts'), file('src/b.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });
      resize(900);
      act(() => root.render(<FileTree />));
      act(() => useStore.getState().setPanel('files'));
      act(() => host.querySelector<HTMLButtonElement>('[data-file="src/a.ts"]')!.click());
      expect(useStore.getState().selected).toBe('src/a.ts');
      expect(useStore.getState().panel).toBeNull();

      resize(390);
      act(() => useStore.getState().setPanel('files'));
      act(() => host.querySelector<HTMLButtonElement>('[data-file="src/b.ts"]')!.click());
      expect(useStore.getState().panel).toBe('inspector');
    } finally {
      vi.useRealTimers();
    }
  });

  it('on a phone a file picked in the tree hands focus to the inspector after it opens', () => {
    useStore.getState().apply({ type: 'hello', root: '/p/shop', name: 'shop', files: [file('src/a.ts')], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] } });
    resize(390);
    function Phone() { useSlideOvers(); return <><FileTree /><Inspector /></>; }
    act(() => root.render(<Phone />));
    act(() => useStore.getState().setPanel('files'));
    const row = host.querySelector<HTMLButtonElement>('[data-file="src/a.ts"]')!;
    row.focus();
    act(() => row.click());
    const insp = host.querySelector('aside.insp')!;
    expect(useStore.getState().panel).toBe('inspector');
    expect(insp.hasAttribute('inert')).toBe(false);
    expect(insp.contains(document.activeElement)).toBe(true);
    expect(host.querySelector('aside.sidebar')!.hasAttribute('inert')).toBe(true);
  });

  it('while a slide-over is open below 1080 px the center pane is inert', () => {
    resize(900);
    act(() => root.render(<CenterTabs />));
    const center = () => host.querySelector('main.center')!;
    expect(center().hasAttribute('inert')).toBe(false);
    act(() => useStore.getState().setPanel('files'));
    expect(center().hasAttribute('inert')).toBe(true);
    act(() => useStore.getState().setPanel(null));
    expect(center().hasAttribute('inert')).toBe(false);
  });

  it('a closed slide-over is inert (out of the tab order); open or docked it is not', () => {
    resize(900);
    act(() => root.render(<FileTree />));
    const aside = () => host.querySelector('aside.sidebar')!;
    expect(aside().hasAttribute('inert')).toBe(true);
    act(() => useStore.getState().setPanel('files'));
    expect(aside().hasAttribute('inert')).toBe(false);
    act(() => useStore.getState().setPanel(null));
    act(() => resize(1300));
    expect(aside().hasAttribute('inert')).toBe(false);
  });
});

describe('phone toolbar and map tools', () => {
  it('on a phone the map head shows only the options menu, which holds the level, Follow and Reset layout', () => {
    resize(390);
    act(() => root.render(<MapTools />));
    expect(host.querySelector('.mini-seg')).toBeNull();
    expect(host.querySelector('.toggle')).toBeNull();
    act(() => btn('Map options').click());
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')];
    expect(radios.map(r => r.textContent)).toEqual(['Folders', 'Files', 'Functions']);
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    act(() => radios[0].click());
    expect(useStore.getState().mapLevel).toBe('folders');

    act(() => btn('Map options').click());
    const follow = document.querySelector<HTMLButtonElement>('[role=menuitemcheckbox]')!;
    expect(follow.textContent).toContain('Follow');
    expect(follow.getAttribute('aria-checked')).toBe(String(useStore.getState().follow));
    const before = useStore.getState().follow;
    act(() => follow.click());
    expect(useStore.getState().follow).toBe(!before);

    act(() => btn('Map options').click());
    expect([...document.querySelectorAll('[role=menuitem]')].map(b => b.textContent)).toEqual(['Reset layout', 'Fit to screen']);
  });

  it('wider than a phone the level control and Follow stay in the head', () => {
    resize(900);
    act(() => root.render(<MapTools />));
    expect(host.querySelector('.mini-seg')).not.toBeNull();
    expect(host.querySelector('.toggle')).not.toBeNull();
    act(() => resize(390));
    expect(host.querySelector('.mini-seg')).toBeNull();
  });

  it('the Files and Inspector buttons carry aria-controls for their panels', () => {
    act(() => root.render(<Toolbar />));
    expect(btn('Files').getAttribute('aria-controls')).toBe('sidebar');
    expect(btn('Inspector').getAttribute('aria-controls')).toBe('inspector');
  });
});

describe('closePanel', () => {
  it('does nothing when no panel is open', () => {
    act(() => root.render(<Shell />));
    const other = document.createElement('button');
    host.appendChild(other);
    other.focus();
    closePanel();
    expect(document.activeElement).toBe(other);
  });
});
