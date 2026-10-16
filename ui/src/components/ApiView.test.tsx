// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApiRoute, DomainIndex, Table } from '@shared/domain.js';
import type { UsedByEntry } from '@shared/protocol.js';
import type { FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { emptyDomain, file, sym } from '../fixtures';

vi.mock('../highlight', () => ({ MAX_HIGHLIGHT_LINES: 5000, highlight: async () => null }));
const { ApiView, CAP } = await import('./ApiView');
const { Inspector, loadDetail } = await import('./Inspector');
// The file view loads after first paint in the app; load it up front so a selection renders at once.
await loadDetail();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const IDX = 'server/index.ts';
const ORD = 'server/routes/orders.ts';
const USR = 'server/routes/users.ts';
const SVC = 'server/services/orderService.ts';
const SCHEMA = 'prisma/schema.prisma';

const api = (method: string, fullPath: string, handler: string, line: number, f = ORD): ApiRoute => ({
  id: `${method} ${fullPath} ${f}:${line}`, method, path: fullPath, fullPath, handler, line, kind: 'api', framework: 'express', file: f, mountedVia: [IDX],
});

const orders: Table = {
  name: 'Order', table: 'orders', orm: 'prisma', sources: [{ file: SCHEMA, line: 12 }],
  fields: [{ name: 'id', type: 'String', pk: true, file: SCHEMA, line: 13 }, { name: 'total', type: 'Int', file: SCHEMA, line: 14 }],
  relations: [],
};

function files(): FileModel[] {
  return [
    file(IDX, [], { imports: { local: [ORD, USR], external: ['express'] } }),
    file(ORD, [sym('getOrders', 'function', 6), sym('createOrder', 'function', 10)], {
      imports: { local: [SVC], external: ['express'] }, env: ['ORDERS_LIMIT'],
      routes: [{ method: 'GET', path: '/', handler: 'getOrders', line: 18, kind: 'api', framework: 'express' }],
    }),
    file(USR, [sym('listUsers', 'function', 4)], { routes: [{ method: 'GET', path: '/', handler: 'listUsers', line: 9, kind: 'api', framework: 'express' }] }),
    file(SVC, [sym('listOrders', 'function', 4), sym('insertOrder', 'function', 9)]),
    file(SCHEMA, [], { lang: 'prisma', entities: [{ name: 'Order', table: 'orders', orm: 'prisma', file: SCHEMA, line: 12, fields: [] }] }),
    file('app/about/page.tsx'),
    file('app/screens.tsx'),
  ];
}

const usedBy: UsedByEntry[] = [
  { file: SVC, symbol: 'listOrders', usedIn: [ORD] },
  { file: SVC, symbol: 'insertOrder', usedIn: [ORD] },
];

function domain(extra: ApiRoute[] = []): DomainIndex {
  const d = emptyDomain();
  d.routes = [
    api('GET', '/api/orders', 'getOrders', 18),
    api('POST', '/api/orders', 'createOrder', 19),
    api('GET', '/api/users', 'listUsers', 9, USR),
    { id: 'PAGE /about app/about/page.tsx:1', method: 'PAGE', path: '/about', fullPath: '/about', line: 1, kind: 'page', framework: 'next', file: 'app/about/page.tsx' },
    { id: 'SCREEN Settings app/screens.tsx:7', method: 'SCREEN', path: 'Settings', fullPath: 'Settings', line: 7, kind: 'screen', framework: 'react-navigation', file: 'app/screens.tsx' },
    ...extra,
  ];
  d.tables = [orders];
  d.dataRefs = [{ file: SVC, tables: ['orders'] }];
  d.counts = { ...d.counts, routes: d.routes.filter(r => r.kind === 'api').length, pages: 1, screens: 1, tables: 1 };
  return d;
}

function hello(d: DomainIndex = domain()) {
  useStore.getState().apply({
    type: 'hello', root: '/p/shop', name: 'shop', files: files(), changes: [], usedBy, domain: d, indexing: false,
    events: [], sessions: [], control: { paused: false, flags: [] },
  });
}

function mount(d?: DomainIndex) {
  hello(d);
  act(() => root.render(<ApiView />));
}

const cards = (kind: string) => [...host.querySelectorAll<HTMLElement>(`.ap[data-kind="${kind}"]`)];
const routeCard = (method: string, path: string) => cards('route').find(c => c.querySelector('.mth')?.textContent === method && c.querySelector('.ap-t')?.textContent === path)!;
const card = (kind: string, text: string) => cards(kind).find(c => c.querySelector('.ap-t')?.textContent === text)!;
const enter = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
const leave = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
const pick = (el: Element) => act(() => el.querySelector<HTMLButtonElement>('.ap-pick')!.click());
/** Presses a key on an element; returns whether the view left the event alone (not default-prevented). */
const key = (el: Element, k: string): boolean => {
  let free = true;
  act(() => { free = el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
  return free;
};
const filter = () => host.querySelector<HTMLInputElement>('input[aria-label="Filter routes"]')!;
const type = (v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter(), v);
  filter().dispatchEvent(new Event('input', { bubbles: true }));
});
const edges = () => host.querySelectorAll('svg.ap-edges path.e').length;
const groups = () => [...host.querySelectorAll<HTMLElement>('.ap-gh')];

beforeEach(() => {
  useStore.getState().reset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('ApiView', () => {
  it('renders the four lane headers and a GET /api/orders route card', () => {
    mount();
    expect([...host.querySelectorAll('.lane-h b')].map(h => h.textContent)).toEqual(['Routes', 'Handlers', 'Services', 'Tables']);
    const get = routeCard('GET', '/api/orders');
    expect(get).toBeTruthy();
    expect(get.querySelector('.mth')?.classList.contains('m-GET')).toBe(true);
    expect(get.querySelector('.ap-pick')?.tagName).toBe('BUTTON');
  });

  it('draws one card per handler, service file and table, and no connectors until a route is traced', () => {
    mount();
    expect(cards('handler').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['listUsers', 'getOrders', 'createOrder']);
    expect(cards('service').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['orderService.ts']);
    expect(cards('table').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['orders']);
    expect(edges()).toBe(0);
    // route→handler, handler→service, service→table of that one route.
    enter(routeCard('GET', '/api/orders'));
    expect(edges()).toBe(3);
    enter(card('service', 'orderService.ts'));
    expect(edges()).toBe(0);
  });

  it('clicking a route picks it: its flow stays lit and drawn until another pick or Esc', () => {
    mount();
    const get = routeCard('GET', '/api/orders');
    enter(get);
    pick(get);
    leave(get);
    expect(get.classList.contains('picked')).toBe(true);
    expect(card('table', 'orders').classList.contains('on')).toBe(true);
    expect(edges()).toBe(3);
    // Hover previews another route, then the pick comes back.
    const users = routeCard('GET', '/api/users');
    enter(users);
    expect(card('handler', 'listUsers').classList.contains('on')).toBe(true);
    expect(edges()).toBe(1);
    leave(users);
    expect(card('handler', 'getOrders').classList.contains('on')).toBe(true);
    pick(users);
    expect(get.classList.contains('picked')).toBe(false);
    expect(users.classList.contains('picked')).toBe(true);
    key(host.querySelector('.apiv')!, 'Escape');
    expect(host.querySelectorAll('.ap.on, .ap.dim, .ap.picked').length).toBe(0);
    expect(edges()).toBe(0);
  });

  it('un-picking clears the trace even while the row keeps focus or hover', () => {
    mount();
    // Keyboard: Tab to the row (focus), Enter (click), Esc.
    const get = routeCard('GET', '/api/orders');
    const btn = get.querySelector<HTMLButtonElement>('.ap-pick')!;
    act(() => btn.focus());
    act(() => btn.click());
    expect(get.classList.contains('picked')).toBe(true);
    expect(key(btn, 'Escape')).toBe(false);
    expect(host.querySelectorAll('.ap.on, .ap.dim, .ap.picked').length).toBe(0);
    expect(edges()).toBe(0);
    act(() => btn.blur());
    // Mouse: hover, click, click again.
    enter(get);
    pick(get);
    pick(get);
    expect(host.querySelectorAll('.ap.on, .ap.dim, .ap.picked').length).toBe(0);
    expect(edges()).toBe(0);
    // The next hover draws again.
    leave(get);
    enter(get);
    expect(edges()).toBe(3);
  });

  it('a pick hidden by a collapse is dropped, and Esc then falls through', () => {
    mount();
    pick(routeCard('GET', '/api/orders'));
    const g = groups().find(x => x.querySelector('.ap-gk')?.textContent === '/api/orders')!;
    act(() => g.click());
    act(() => g.click());
    expect(routeCard('GET', '/api/orders').classList.contains('picked')).toBe(false);
    expect(host.querySelectorAll('.ap.on, .ap.dim').length).toBe(0);
    expect(key(host.querySelector('.apiv')!, 'Escape')).toBe(true);
  });

  it('a pick hidden by the search is dropped too', () => {
    mount();
    pick(routeCard('GET', '/api/users'));
    type('orders');
    type('');
    expect(host.querySelectorAll('.ap.picked').length).toBe(0);
  });

  it('Esc anywhere in the view clears a search first, then the pick', () => {
    mount();
    const get = routeCard('GET', '/api/orders');
    pick(get);
    type('orders');
    const btn = get.querySelector<HTMLButtonElement>('.ap-pick')!;
    expect(key(btn, 'Escape')).toBe(false);
    expect(filter().value).toBe('');
    expect(get.classList.contains('picked')).toBe(true);
    expect(key(btn, 'Escape')).toBe(false);
    expect(get.classList.contains('picked')).toBe(false);
    expect(key(btn, 'Escape')).toBe(true);
  });

  it('a focused row keeps focus when an earlier group empties', () => {
    mount();
    const btn = routeCard('GET', '/api/orders').querySelector<HTMLButtonElement>('.ap-pick')!;
    act(() => btn.focus());
    // The /api group (the users route) empties; /api/orders follows it.
    type('orders');
    expect(groups().map(x => x.querySelector('.ap-gk')?.textContent)).toEqual(['/api/orders']);
    expect(btn.isConnected).toBe(true);
    expect(document.activeElement).toBe(btn);
  });

  it('arrow keys walk from the search box through group headers and route rows, Enter picks', () => {
    mount();
    // Groups: /api (the lone users route folds into it), then /api/orders.
    key(filter(), 'ArrowDown');
    expect(document.activeElement).toBe(groups()[0]);
    key(document.activeElement!, 'ArrowDown');
    const users = document.activeElement as HTMLElement;
    expect(users.closest('.ap-route')).toBe(routeCard('GET', '/api/users'));
    key(users, 'ArrowDown');
    expect(document.activeElement).toBe(groups()[1]);
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(users);
    act(() => users.click());
    expect(routeCard('GET', '/api/users').classList.contains('picked')).toBe(true);
  });

  it('each route row shows its handler file, and clicking it opens the file without picking', () => {
    const d = domain([api('GET', '/api/reports/monthly', 'getOrders', 30, 'server/modules/billing/reports/routes/monthly-reports.ts')]);
    mount(d);
    const f = routeCard('GET', '/api/users').querySelector<HTMLButtonElement>('.ap-file')!;
    expect(f.textContent).toBe(USR);
    expect(f.title).toContain(`${USR}:9`);
    const long = routeCard('GET', '/api/reports/monthly').querySelector<HTMLButtonElement>('.ap-file')!;
    expect(long.textContent).toContain('…');
    expect(long.title).toContain('server/modules/billing/reports/routes/monthly-reports.ts');
    act(() => f.click());
    expect(useStore.getState().reveal).toMatchObject({ path: USR, line: 9 });
    expect(host.querySelectorAll('.ap.picked').length).toBe(0);
  });

  it('groups routes by path prefix with counts, and a group collapses', () => {
    const d = domain([api('DELETE', '/api/users/:id', 'listUsers', 12, USR), api('GET', '/health', 'getOrders', 40)]);
    mount(d);
    expect(groups().map(g => [g.querySelector('.ap-gk')?.textContent, g.querySelector('.ap-gn')?.textContent])).toEqual([
      ['/', '1'], ['/api/orders', '2'], ['/api/users', '2'],
    ]);
    const users = groups()[2];
    expect(users.getAttribute('aria-expanded')).toBe('true');
    act(() => users.click());
    expect(users.getAttribute('aria-expanded')).toBe('false');
    expect(routeCard('GET', '/api/users')).toBeUndefined();
    expect(cards('handler').map(c => c.querySelector('.ap-t')?.textContent)).not.toContain('listUsers');
    act(() => users.click());
    expect(routeCard('GET', '/api/users')).toBeTruthy();
  });

  it('the search matches the handler file, and Esc clears it', () => {
    mount();
    type('routes/users');
    expect(cards('route').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['/api/users']);
    key(filter(), 'Escape');
    expect(filter().value).toBe('');
    expect(cards('route')).toHaveLength(3);
  });

  it('hovering a route lights its handler, service and table and dims the rest', () => {
    mount();
    const get = routeCard('GET', '/api/orders');
    enter(get);
    for (const c of [get, card('handler', 'getOrders'), card('service', 'orderService.ts'), card('table', 'orders')]) {
      expect(c.classList.contains('on')).toBe(true);
    }
    for (const c of [routeCard('POST', '/api/orders'), card('handler', 'createOrder'), routeCard('GET', '/api/users'), card('handler', 'listUsers')]) {
      expect(c.classList.contains('dim')).toBe(true);
    }
    expect(host.querySelectorAll('path.e.flow').length).toBe(3);
    leave(get);
    expect(host.querySelectorAll('.ap.on, .ap.dim').length).toBe(0);
  });

  it('hovering a shared card lights every flow through it', () => {
    mount();
    enter(card('service', 'orderService.ts'));
    expect(routeCard('GET', '/api/orders').classList.contains('on')).toBe(true);
    expect(routeCard('POST', '/api/orders').classList.contains('on')).toBe(true);
    expect(routeCard('GET', '/api/users').classList.contains('dim')).toBe(true);
  });

  it('focusing a route traces it like hover', () => {
    mount();
    const users = routeCard('GET', '/api/users').querySelector<HTMLButtonElement>('.ap-pick')!;
    act(() => users.focus());
    expect(card('handler', 'listUsers').classList.contains('on')).toBe(true);
    expect(card('table', 'orders').classList.contains('dim')).toBe(true);
    act(() => users.blur());
    expect(host.querySelectorAll('.ap.on').length).toBe(0);
  });

  it('hovering then filtering the hovered card away clears the trace', () => {
    mount();
    enter(routeCard('GET', '/api/users'));
    type('orders');
    expect(host.querySelectorAll('.ap.on, .ap.dim').length).toBe(0);
  });

  it('two inline handlers in one file get separate cards', () => {
    const d = domain();
    d.routes = [api('GET', '/a', 'inline', 30), api('GET', '/b', 'inline', 31)];
    mount(d);
    expect(cards('handler')).toHaveLength(2);
  });

  it('the filter narrows the routes by path or method', () => {
    mount();
    type('/api/users');
    expect(cards('route').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['/api/users']);
    expect(cards('service')).toHaveLength(0);
    type('post');
    expect(cards('route').map(c => c.querySelector('.mth')?.textContent)).toEqual(['POST']);
    type('nothing-here');
    expect(cards('route')).toHaveLength(0);
    expect(host.textContent).toContain('No routes match');
  });

  it('clicking a card selects its file and line', () => {
    mount();
    act(() => routeCard('GET', '/api/orders').querySelector<HTMLButtonElement>('.ap-file')!.click());
    expect(useStore.getState().reveal).toMatchObject({ path: ORD, line: 18 });
    act(() => card('handler', 'createOrder').click());
    expect(useStore.getState().reveal).toMatchObject({ path: ORD, line: 10 });
    act(() => card('service', 'orderService.ts').click());
    expect(useStore.getState().selected).toBe(SVC);
    act(() => card('table', 'orders').click());
    expect(useStore.getState().reveal).toMatchObject({ path: SCHEMA, line: 12 });
  });

  it('marks a route first seen after hello as new', () => {
    mount();
    act(() => useStore.getState().apply({ type: 'domain', domain: domain([api('DELETE', '/api/orders/:id', 'deleteOrder', 25)]) }));
    const del = routeCard('DELETE', '/api/orders/:id');
    expect(del.classList.contains('isnew')).toBe(true);
    expect(del.querySelector('.mth')?.classList.contains('m-DELETE')).toBe(true);
    expect(routeCard('GET', '/api/orders').classList.contains('isnew')).toBe(false);
  });

  it('a route whose line moved (an edit above it) is not new', () => {
    mount();
    const d = domain();
    d.routes = d.routes.map(r => (r.kind === 'api' ? { ...r, line: r.line + 3, id: `${r.method} ${r.fullPath} ${r.file}:${r.line + 3}` } : r));
    act(() => useStore.getState().apply({ type: 'domain', domain: d }));
    expect(host.querySelectorAll('.ap.isnew').length).toBe(0);
  });

  it('lists pages and screens below the flows with their framework and file', () => {
    mount();
    const sec = (h: string) => [...host.querySelectorAll<HTMLElement>('.ap-sec')].find(s => s.querySelector('h4')?.textContent?.startsWith(h))!;
    expect(sec('Pages').textContent).toContain('/about');
    expect(sec('Pages').textContent).toContain('Next.js');
    expect(sec('Screens').textContent).toContain('Settings');
    act(() => sec('Screens').querySelector<HTMLButtonElement>('.pg-row')!.click());
    expect(useStore.getState().reveal).toMatchObject({ path: 'app/screens.tsx', line: 7 });
  });

  it('shows the hint in the head, not over the rows', () => {
    mount();
    expect(host.querySelector('.cv-hint')).toBeNull();
    expect(host.querySelector('.ap-bar .ap-hint')?.textContent).toBe('Hover or select a route to trace it. Links are approximate.');
  });

  it(`over ${CAP} routes draws the first ${CAP} by path and offers "Show all"`, () => {
    const many = Array.from({ length: CAP + 1 }, (_, i) => api('GET', `/api/r${String(i).padStart(4, '0')}`, 'getOrders', 18));
    const d = domain();
    d.routes = many;
    mount(d);
    expect(cards('route')).toHaveLength(CAP);
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent === `Show all ${(CAP + 1).toLocaleString()}`)!;
    expect(btn).toBeTruthy();
    act(() => btn.click());
    expect(cards('route')).toHaveLength(CAP + 1);
  });

  it(`group counts are the real size, and collapsed groups do not use up the ${CAP} cap`, () => {
    const a = Array.from({ length: CAP + 1 }, (_, i) => api('GET', `/api/a/r${String(i).padStart(4, '0')}`, 'getOrders', 18));
    const b = Array.from({ length: 3 }, (_, i) => api('GET', `/api/b/r${i}`, 'getOrders', 18));
    const d = domain();
    d.routes = [...a, ...b];
    mount(d);
    const head = (k: string) => groups().find(x => x.querySelector('.ap-gk')?.textContent === k)!;
    expect(head('/api/a').querySelector('.ap-gn')?.textContent).toBe((CAP + 1).toLocaleString());
    expect(cards('route')).toHaveLength(CAP);
    expect(host.textContent).toContain(`Show all ${(CAP + 4).toLocaleString()}`);
    act(() => head('/api/a').click());
    expect(cards('route').map(c => c.querySelector('.ap-t')?.textContent)).toEqual(['/api/b/r0', '/api/b/r1', '/api/b/r2']);
    expect(head('/api/b').querySelector('.ap-gn')?.textContent).toBe('3');
    expect(host.querySelector('.ap-cap')).toBeNull();
  });

  it('shows the empty state with the supported frameworks', () => {
    mount(emptyDomain());
    expect(host.textContent).toContain('No routes yet.');
    expect(host.textContent).toContain('Express');
    expect(host.textContent).toContain('FastAPI');
    expect(host.textContent).toContain('React Navigation');
  });

  it('in a narrow pane stacks each flow as a chain, without the SVG', () => {
    // The lanes measure the scroll area; give it a phone width.
    const cw = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('ap-scroll') ? 360 : 0;
    });
    mount();
    cw.mockRestore();
    expect(host.querySelector('.apiv')?.classList.contains('stacked')).toBe(true);
    expect(host.querySelector('svg.ap-edges')).toBeNull();
    expect(host.querySelector('.ap-hint')?.textContent).toBe('Tap a route to see its flow. Links are approximate.');
    const chain = routeCard('GET', '/api/orders').closest('.ap-chain')!;
    expect([...chain.querySelectorAll<HTMLElement>('.ap')].map(c => c.dataset.kind)).toEqual(['route']);
    pick(routeCard('GET', '/api/orders'));
    expect([...chain.querySelectorAll<HTMLElement>('.ap')].map(c => c.dataset.kind)).toEqual(['route', 'handler', 'service', 'table']);
    expect(host.querySelectorAll('.ap-links')).toHaveLength(1);
  });
});

describe('Inspector domain sections', () => {
  const section = (h: string) => [...host.querySelectorAll<HTMLElement>('.sec')].find(s => s.querySelector('h4')?.textContent?.startsWith(h));

  it('shows routes in a route file, its tables and env var names', async () => {
    const d = domain();
    d.dataRefs = [...d.dataRefs, { file: ORD, tables: ['orders'] }];
    hello(d);
    act(() => useStore.getState().select(ORD));
    await act(async () => { root.render(<Inspector />); await new Promise(r => setTimeout(r, 0)); });
    const routes = section('Routes in this file')!;
    expect(routes).toBeTruthy();
    const rows = [...routes.querySelectorAll('.rt-row')];
    expect(rows.map(r => r.querySelector('.mth')?.textContent)).toEqual(['GET', 'POST']);
    expect(rows[0].textContent).toContain('/api/orders');
    act(() => (rows[1] as HTMLButtonElement).click());
    expect(useStore.getState().reveal).toMatchObject({ path: ORD, line: 19 });
    expect(section('Uses tables')?.textContent).toContain('orders');
    expect(section('Env vars')?.textContent).toContain('ORDERS_LIMIT');
    expect(section('Tables defined here')).toBeUndefined();
  });

  it('shows tables defined in a schema file with their field count', async () => {
    hello();
    act(() => useStore.getState().select(SCHEMA));
    await act(async () => { root.render(<Inspector />); await new Promise(r => setTimeout(r, 0)); });
    const t = section('Tables defined here')!;
    expect(t.textContent).toContain('Order');
    expect(t.textContent).toContain('2 fields');
    expect(section('Routes in this file')).toBeUndefined();
  });
});

describe('ApiView palette trace (routeTrace)', () => {
  const scrolled: Element[] = [];
  beforeEach(() => {
    scrolled.length = 0;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  });

  it('traces the route and scrolls it into view', () => {
    mount();
    act(() => useStore.getState().traceRoute(`GET /api/users ${USR}:9`));
    const users = routeCard('GET', '/api/users');
    expect(users.classList.contains('on')).toBe(true);
    expect(card('handler', 'listUsers').classList.contains('on')).toBe(true);
    expect(routeCard('GET', '/api/orders').classList.contains('dim')).toBe(true);
    expect(scrolled).toContain(users);
    expect(users.classList.contains('picked')).toBe(true);
    // Hovering something else takes over the trace until the pointer leaves.
    enter(routeCard('GET', '/api/orders'));
    expect(users.classList.contains('dim')).toBe(true);
    leave(routeCard('GET', '/api/orders'));
    expect(users.classList.contains('on')).toBe(true);
  });

  it('expands a collapsed group to show the traced route', () => {
    mount();
    const g = groups().find(x => x.querySelector('.ap-gk')?.textContent === '/api/orders')!;
    act(() => g.click());
    expect(routeCard('POST', '/api/orders')).toBeUndefined();
    act(() => useStore.getState().traceRoute(`POST /api/orders ${ORD}:19`));
    expect(routeCard('POST', '/api/orders').classList.contains('picked')).toBe(true);
  });

  it('clears a filter that hides the route, and turns on "Show all" for one beyond the cap', () => {
    const many = Array.from({ length: CAP + 1 }, (_, i) => api('GET', `/api/r${String(i).padStart(4, '0')}`, 'getOrders', 18));
    const d = domain();
    d.routes = many;
    mount(d);
    const input = filter();
    type('r0001');
    const last = many[CAP];
    act(() => useStore.getState().traceRoute(last.id));
    expect(input.value).toBe('');
    const el = routeCard('GET', last.fullPath);
    expect(el).toBeTruthy();
    expect(el.classList.contains('on')).toBe(true);
    expect(scrolled).toContain(el);
  });

  it('a page scrolls its row into view', () => {
    mount();
    act(() => useStore.getState().traceRoute('PAGE /about app/about/page.tsx:1'));
    expect(scrolled.some(e => e.classList.contains('pg-row') && e.textContent!.includes('/about'))).toBe(true);
  });
});
