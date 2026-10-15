// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApiRoute, Table } from '@shared/domain.js';
import { useStore } from '../store';
import { change, emptyDomain, file, sym } from '../fixtures';
import { SearchButton } from '../components/Toolbar';
import { PaletteHost } from './PaletteHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // cmdk measures its list and scrolls the active row into view; jsdom has neither.
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= RO;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const route = (method: string, fullPath: string, f: string, line: number): ApiRoute => ({
  id: `${method} ${fullPath} ${f}:${line}`, method, path: fullPath, fullPath, file: f, line, kind: 'api', framework: 'express',
});
const table = (name: string): Table => ({ name, table: name, orm: 'prisma', sources: [{ file: 'prisma/schema.prisma', line: 7 }], fields: [], relations: [] });

const SERVICE = 'src/services/orderService.ts';
function hello() {
  const domain = { ...emptyDomain(), routes: [route('POST', '/api/orders', 'src/routes/orders.ts', 8)], tables: [table('orders')] };
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', usedBy: [], changes: [], indexing: false, events: [], sessions: [], control: { paused: false, flags: [] },
    domain,
    files: [
      file(SERVICE, [sym('createOrder', 'function', 14), sym('OrderService', 'class', 30)]),
      file('src/routes/orders.ts', [sym('router', 'variable', 2)]),
      file('src/components/Cart.tsx', [sym('Cart', 'component', 5)]),
      file('prisma/schema.prisma', [], { lang: 'prisma' }),
    ],
  });
}

let host: HTMLDivElement;
let root: Root;

async function frames(n = 3) {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

function key(k: string, opts: KeyboardEventInit = {}, target: Element | null = document.activeElement) {
  act(() => { (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })); });
}

const dialog = () => document.querySelector<HTMLElement>('[cmdk-dialog]');
const input = () => document.querySelector<HTMLInputElement>('[cmdk-input]')!;
const headings = () => [...document.querySelectorAll('[cmdk-group-heading]')].map(h => h.textContent);
const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')];

async function type(text: string) {
  const el = input();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await frames();
}

async function openWithKeys(from: HTMLElement) {
  from.focus();
  key('k', { ctrlKey: true }, from);
  // The first open loads the lazy chunk.
  for (let i = 0; i < 50 && !dialog(); i++) await frames(1);
  await frames();
}

beforeEach(async () => {
  useStore.getState().reset();
  hello();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(
    <>
      <button type="button" id="before">Before</button>
      <input id="tree-filter" placeholder="Filter files and functions" />
      <SearchButton />
      <PaletteHost />
    </>,
  ));
});

afterEach(async () => {
  act(() => useStore.getState().setPalette(false));
  await frames(1);
  act(() => root.unmount());
  host.remove();
});

describe('Palette', () => {
  it('Ctrl+K opens it with the input focused; Esc closes it and focus returns', async () => {
    const before = document.getElementById('before')!;
    await openWithKeys(before);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.getAttribute('role')).toBe('dialog');
    expect(input().placeholder).toBe('Search files, functions, routes, tables…');
    expect(document.activeElement).toBe(input());

    key('Escape', {}, input());
    await frames();
    expect(dialog()).toBeNull();
    expect(useStore.getState().paletteOpen).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('Cmd+K works too, and Ctrl+K again closes it', async () => {
    await openWithKeys(document.getElementById('before')!);
    expect(dialog()).not.toBeNull();
    key('k', { ctrlKey: true }, input());
    await frames();
    expect(dialog()).toBeNull();
    key('K', { metaKey: true }, document.body);
    await frames();
    expect(dialog()).not.toBeNull();
  });

  it('Ctrl+K while typing in the tree filter does not open it; the toolbar button always does', async () => {
    const filter = document.getElementById('tree-filter') as HTMLInputElement;
    filter.focus();
    key('k', { ctrlKey: true }, filter);
    await frames();
    expect(dialog()).toBeNull();

    const btn = document.querySelector<HTMLButtonElement>('.pillbtn.search')!;
    expect(btn.getAttribute('aria-label')).toBe('Search everything');
    act(() => btn.click());
    await frames();
    expect(dialog()).not.toBeNull();
  });

  it('typing filters, and results render in groups with headings', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('order');
    // Groups follow their best match: the "orders" table is a prefix match, the route only an initials match.
    expect(headings()).toEqual(['Files', 'Functions and components', 'Tables', 'Routes']);
    const labels = rows().map(r => r.querySelector('.pl')!.textContent);
    expect(labels).toContain('orderService.ts');
    expect(labels).toContain('OrderService');
    expect(labels).not.toContain('Cart.tsx');
    // A file row has its layer dot and its folder as detail.
    const svc = rows().find(r => r.textContent!.includes('orderService.ts'))!;
    expect(svc.querySelector('.ldot')).not.toBeNull();
    expect(svc.querySelector('small')!.textContent).toContain('src/services');
    // The first row is active.
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
  });

  it('shows a friendly line when nothing matches', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('zzqqx');
    expect(rows()).toHaveLength(0);
    expect(dialog()!.textContent).toContain('No matches for “zzqqx”');
  });

  it('Enter on a symbol opens its file at that line', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('createOrder');
    expect(rows()[0].textContent).toContain('createOrder');
    key('Enter', {}, input());
    await frames();
    const s = useStore.getState();
    expect(s.selected).toBe(SERVICE);
    expect(s.reveal).toMatchObject({ path: SERVICE, line: 14 });
    expect(s.paletteOpen).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('Enter right after typing (before the next frame) opens the best match for the typed text', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('Cart');
    const el = input();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'createOrder');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    key('Enter', {}, input());
    await frames();
    expect(useStore.getState().reveal).toMatchObject({ path: SERVICE, line: 14 });
  });

  it('the Enter that commits an IME conversion in Safari (keyCode 229) opens nothing', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('Cart');
    const el = input();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'createOrder');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'keyCode', { value: 229 });
    act(() => { el.dispatchEvent(e); });
    await frames();
    expect(useStore.getState().paletteOpen).toBe(true);
    expect(useStore.getState().reveal).toBeNull();
  });

  it('Ctrl+K opens the palette on a non-Latin layout (key л, code KeyK)', async () => {
    document.getElementById('before')!.focus();
    key('л', { ctrlKey: true, code: 'KeyK' }, document.getElementById('before'));
    await frames();
    expect(dialog()).not.toBeNull();
  });

  it('arrow keys move the active row', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('order');
    const first = rows()[0];
    key('ArrowDown', {}, input());
    expect(first.getAttribute('data-selected')).not.toBe('true');
    expect(rows()[1].getAttribute('data-selected')).toBe('true');
  });

  it('with the Map tab active, choosing a file asks the Map to fly to it', async () => {
    act(() => useStore.getState().setTab('map'));
    await openWithKeys(document.getElementById('before')!);
    await type('Cart');
    key('Enter', {}, input());
    await frames();
    const s = useStore.getState();
    expect(s.selected).toBe('src/components/Cart.tsx');
    expect(s.mapFocus).toMatchObject({ path: 'src/components/Cart.tsx' });
  });

  it('with the Schema tab active, a table is focused; with the API tab active, a route is traced', async () => {
    act(() => useStore.getState().setTab('schema'));
    await openWithKeys(document.getElementById('before')!);
    await type('orders');
    const t = rows().find(r => r.textContent!.includes('table · prisma'))!;
    act(() => t.click());
    await frames();
    expect(useStore.getState().tableFocus).toMatchObject({ key: 'orders' });
    expect(useStore.getState().selected).toBe('prisma/schema.prisma');

    act(() => useStore.getState().setTab('api'));
    await openWithKeys(document.getElementById('before')!);
    await type('post orders');
    key('Enter', {}, input());
    await frames();
    expect(useStore.getState().routeTrace).toMatchObject({ id: 'POST /api/orders src/routes/orders.ts:8' });
    expect(useStore.getState().reveal).toMatchObject({ path: 'src/routes/orders.ts', line: 8 });
  });

  it('the empty query shows recent files, most recent first', async () => {
    act(() => {
      useStore.getState().select('src/components/Cart.tsx');
      useStore.getState().select(SERVICE);
    });
    await openWithKeys(document.getElementById('before')!);
    expect(headings()).toEqual(['Recent']);
    expect(rows().map(r => r.querySelector('.pl')!.textContent)).toEqual(['orderService.ts', 'Cart.tsx']);
  });

  it('a live store update while open keeps the active row (and the query)', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('order');
    key('ArrowDown', {}, input());
    const active = () => document.querySelector('[cmdk-item][data-selected="true"] .pl')!.textContent;
    const was = active();
    expect(was).not.toBe(rows()[0].querySelector('.pl')!.textContent);
    await act(async () => {
      useStore.getState().apply({ type: 'files', files: [file('src/components/Cart.tsx', [sym('Cart', 'component', 6), sym('CartRow', 'component', 20)])], removed: [] });
      useStore.getState().apply({ type: 'change', files: [], removed: [], change: change('src/components/Cart.tsx') });
    });
    await frames();
    expect(active()).toBe(was);
    expect(input().value).toBe('order');
    // A new query starts again from the first row.
    await type('orders');
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
  });

  it('a held-down Ctrl+K (key repeat) does not toggle the palette', async () => {
    const before = document.getElementById('before')!;
    await openWithKeys(before);
    key('k', { ctrlKey: true, repeat: true }, input());
    await frames();
    expect(dialog()).not.toBeNull();
  });

  it('a held-down Ctrl+K in another text field is left to that field (F8)', async () => {
    const filter = document.getElementById('tree-filter') as HTMLInputElement;
    filter.focus();
    const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    act(() => { filter.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('reopening starts from the first row, not the row picked last time (F7)', async () => {
    act(() => {
      useStore.getState().select('src/components/Cart.tsx');
      useStore.getState().select(SERVICE);
    });
    await openWithKeys(document.getElementById('before')!);
    key('ArrowDown', {}, input());
    expect(rows()[1].getAttribute('data-selected')).toBe('true');
    key('Escape', {}, input());
    await frames();
    await openWithKeys(document.getElementById('before')!);
    expect(rows()[0].getAttribute('data-selected')).toBe('true');
    expect(rows()[1].getAttribute('data-selected')).not.toBe('true');
  });

  it('closes when the app becomes gated, and Ctrl+K does nothing while gated', async () => {
    await openWithKeys(document.getElementById('before')!);
    act(() => useStore.getState().setConnection('unauthorized'));
    await frames();
    expect(dialog()).toBeNull();
    expect(useStore.getState().paletteOpen).toBe(false);
    key('k', { ctrlKey: true }, document.body);
    await frames();
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it('the closing overlay never takes pointer events, even with Radix inline pointer-events', async () => {
    // jsdom runs no exit animations: check the rule that must beat Radix's inline pointer-events:auto.
    // Tests run from ui/.
    const css = (await import('node:fs')).readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    const rule = /\.pscrim\[data-state=closed\][^{]*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/pointer-events:\s*none\s*!important/);
    // jsdom's cascade does not rank !important above inline styles; the real browser check is in the report (Playwright).
  });

  it('reopening starts from an empty query', async () => {
    await openWithKeys(document.getElementById('before')!);
    await type('order');
    key('Escape', {}, input());
    await frames();
    await openWithKeys(document.getElementById('before')!);
    expect(input().value).toBe('');
  });
});
