import { describe, it, expect } from 'vitest';
import type { ApiRoute, DomainIndex, Table } from '@shared/domain.js';
import type { FileModel } from '@shared/types.js';
import { emptyDomainIndex } from '../store';
import { file, sym } from '../fixtures';
import { INITIALS, PATH, SUBSTRING, WORD, buildIndex, query, type Entry } from './searchIndex';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const route = (method: string, fullPath: string, file: string, line: number, kind: ApiRoute['kind'] = 'api'): ApiRoute => ({
  id: `${method} ${fullPath} ${file}:${line}`, method, path: fullPath, fullPath, file, line, kind, framework: 'express',
});
const table = (name: string, orm = 'prisma', file = 'prisma/schema.prisma', line = 3): Table => ({
  name, table: name, orm, sources: [{ file, line }], fields: [], relations: [],
});

function domain(extra: Partial<DomainIndex> = {}): DomainIndex {
  return { ...emptyDomainIndex(), ...extra };
}

const files = (list: FileModel[]): Record<string, FileModel> => Object.fromEntries(list.map(f => [f.path, f]));

const project = () => files([
  file('src/services/orderService.ts', [sym('createOrder', 'function', 4), sym('OrderService', 'class', 10, [sym('cancel', 'method', 12)])]),
  file('src/components/reorderList.tsx', [sym('ReorderList', 'component', 3)]),
  file('src/routes/orders.ts', [sym('router', 'variable', 1)]),
  file('docs/guide.md', [sym('Getting started', 'heading', 1)], { lang: 'markdown' }),
]);
const dom = () => domain({
  routes: [route('POST', '/api/orders', 'src/routes/orders.ts', 8), route('GET', '/api/orders', 'src/routes/orders.ts', 4), route('PAGE', '/about', 'src/app/about/page.tsx', 1, 'page')],
  tables: [table('orders'), table('order_items', 'drizzle', 'src/db/schema.ts', 20)],
});

const labels = (r: { entry: Entry }[]) => r.map(x => x.entry.label);

describe('buildIndex', () => {
  it('indexes files, flattened symbols, routes (pages too) and tables with their labels and details', () => {
    const idx = buildIndex(project(), dom());
    const f = idx.find(e => e.kind === 'file' && e.path === 'src/services/orderService.ts')!;
    expect(f).toMatchObject({ label: 'orderService.ts', detail: 'src/services', layer: 'logic' });
    const nested = idx.find(e => e.kind === 'symbol' && e.label === 'cancel')!;
    expect(nested).toMatchObject({ detail: 'src/services/orderService.ts:12', path: 'src/services/orderService.ts', line: 12, symKind: 'method' });
    const post = idx.find(e => e.kind === 'route' && e.method === 'POST')!;
    expect(post).toMatchObject({ label: 'POST /api/orders', detail: 'src/routes/orders.ts:8', path: 'src/routes/orders.ts', line: 8 });
    expect(idx.some(e => e.kind === 'route' && e.label === 'PAGE /about')).toBe(true);
    const t = idx.find(e => e.kind === 'table' && e.label === 'order_items')!;
    expect(t).toMatchObject({ detail: 'table · drizzle', path: 'src/db/schema.ts', line: 20 });
  });

  it('excludes headings', () => {
    const idx = buildIndex(project(), dom());
    expect(idx.some(e => e.symKind === 'heading')).toBe(false);
    expect(idx.some(e => e.label === 'Getting started')).toBe(false);
  });
});

describe('query', () => {
  it('ranks a label prefix above a substring: `order` puts orderService.ts before reorderList', () => {
    const r = labels(query(buildIndex(project(), dom()), 'order'));
    expect(r.indexOf('orderService.ts')).toBeGreaterThanOrEqual(0);
    expect(r.indexOf('orderService.ts')).toBeLessThan(r.indexOf('reorderList.tsx'));
  });

  it('an exact label match ranks first', () => {
    const r = labels(query(buildIndex(project(), dom()), 'orders'));
    expect(r[0]).toBe('orders');
  });

  it('matches camelCase and path segment initials: `ordsvc` finds orderService.ts', () => {
    const r = query(buildIndex(project(), dom()), 'ordsvc');
    expect(labels(r)[0]).toBe('orderService.ts');
  });

  it('ranks initials above substring and substring above a fuzzy subsequence', () => {
    const idx = buildIndex(files([
      file('a/xxsvcyy.ts'), // substring "svc"
      file('a/xsyvzc.ts'), // fuzzy only: no word starts with s
      file('a/saveVoiceCache.ts'), // initials s-v-c
    ]), domain());
    expect(labels(query(idx, 'svc'))).toEqual(['saveVoiceCache.ts', 'xxsvcyy.ts', 'xsyvzc.ts']);
  });

  it('a file matched only through its folders ranks below files matched by name', () => {
    const idx = buildIndex(files([
      file('apps/orders/page.tsx'), // folder substring only
      file('src/ordersvc/index.ts'), // folder initials only
      file('src/reorderList.tsx'), // name substring
    ]), domain());
    expect(labels(query(idx, 'order'))).toEqual(['reorderList.tsx', 'page.tsx', 'index.ts']);
    expect(query(idx, 'order').map(r => r.score)).toEqual([SUBSTRING, PATH, PATH]);
  });

  it('breaks ties by kind (file, symbol, route, table), then the shorter label', () => {
    const idx = buildIndex(files([file('src/orders.ts', [sym('orders', 'function', 2)])]), domain({ tables: [table('orders')] }));
    expect(query(idx, 'orders').map(r => r.entry.kind)).toEqual(['symbol', 'table', 'file']);
    // "orders" exactly matches the symbol and table labels; the file "orders.ts" is a prefix match.
    const prefix = query(idx, 'ord');
    expect(prefix.map(r => r.entry.kind)).toEqual(['file', 'symbol', 'table']);
    const idx2 = buildIndex(files([file('a/orderLongName.ts'), file('a/orderX.ts')]), domain());
    expect(labels(query(idx2, 'order'))).toEqual(['orderX.ts', 'orderLongName.ts']);
  });

  it('is case-insensitive', () => {
    expect(labels(query(buildIndex(project(), dom()), 'ORDERSERVICE'))[0]).toBe('OrderService');
  });

  it('finds routes by method and path: `post orders` finds POST /api/orders', () => {
    const r = query(buildIndex(project(), dom()), 'post orders');
    expect(r[0].entry.label).toBe('POST /api/orders');
    expect(labels(r)).not.toContain('GET /api/orders');
  });

  it('finds tables by name', () => {
    const r = query(buildIndex(project(), dom()), 'order_items');
    expect(r[0].entry).toMatchObject({ kind: 'table', label: 'order_items' });
  });

  it('returns nothing for an empty query or no match, and respects the limit', () => {
    const idx = buildIndex(project(), dom());
    expect(query(idx, '')).toEqual([]);
    expect(query(idx, '   ')).toEqual([]);
    expect(query(idx, 'zzzqqq')).toEqual([]);
    expect(query(idx, 'o', 3)).toHaveLength(3);
  });
});

describe('performance (Review Focus 3)', () => {
  it('builds a 5,000-file, 40,000-symbol index fast and answers a query fast', () => {
    const words = ['order', 'user', 'cart', 'payment', 'invoice', 'session', 'product', 'search', 'review', 'account'];
    const verbs = ['create', 'update', 'list', 'get', 'remove', 'validate', 'render', 'load'];
    // Fresh objects per build: buildIndex reuses entries of files it has already seen.
    const make = () => {
      const list: FileModel[] = [];
      for (let i = 0; i < 5000; i++) {
        const w = words[i % words.length];
        const syms = [];
        for (let j = 0; j < 8; j++) syms.push(sym(`${verbs[j]}${w[0].toUpperCase()}${w.slice(1)}${i}`, j % 3 ? 'function' : 'component', j * 5 + 1));
        list.push(file(`src/${w}s/mod${i % 40}/${w}Service${i}.ts`, syms));
      }
      return list;
    };
    const list = make();
    const fm = files(list);
    const mkDomain = () => domain({
      routes: Array.from({ length: 500 }, (_, i) => route('GET', `/api/${words[i % 10]}s/${i}`, `src/routes/r${i}.ts`, 3)),
      tables: Array.from({ length: 200 }, (_, i) => table(`${words[i % 10]}_${i}`)),
    });
    const d = mkDomain();
    // Best of three cold builds, so a busy CI runner (other test workers share its CPUs) measures the code, not the contention.
    let build = Infinity;
    for (let k = 0; k < 2; k++) {
      const other = files(make());
      const t = performance.now();
      buildIndex(other, mkDomain());
      build = Math.min(build, performance.now() - t);
    }
    const t0 = performance.now();
    const idx = buildIndex(fm, d);
    build = Math.min(build, performance.now() - t0);
    expect(idx.filter(e => e.kind === 'symbol')).toHaveLength(40_000);

    // A live edit of one file re-derives only that file.
    const one = list[123];
    const t1 = performance.now();
    const idx2 = buildIndex({ ...fm, [one.path]: { ...one } }, d);
    const rebuild = performance.now() - t1;
    expect(idx2).toHaveLength(idx.length);

    // Warm once (JIT), then time the slowest of a few realistic queries.
    query(idx, 'ord');
    let worst = 0;
    for (const q of ['o', 'ordsvc', 'createOrder12', 'get api users', 'xyz']) {
      const s = performance.now();
      query(idx, q);
      worst = Math.max(worst, performance.now() - s);
    }
    console.log(`[perf] buildIndex 5,000 files / 40,000 symbols: ${build.toFixed(1)} ms; after one edit: ${rebuild.toFixed(1)} ms; slowest query: ${worst.toFixed(1)} ms`);
    expect(rebuild).toBeLessThan(60 * TIME_SCALE);
    expect(build).toBeLessThan(600 * TIME_SCALE);
    expect(worst).toBeLessThan(100 * TIME_SCALE);
  });
});

describe('incremental rebuild', () => {
  it('reuses the entries of unchanged files and the domain; an edited file is re-derived', () => {
    const fm = project();
    const d = dom();
    const a = buildIndex(fm, d);
    const edited = { ...fm, 'src/routes/orders.ts': file('src/routes/orders.ts', [sym('router', 'variable', 1), sym('mount', 'function', 9)]) };
    const b = buildIndex(edited, d);
    const same = (idx: Entry[], label: string) => idx.find(e => e.label === label)!;
    expect(same(b, 'orderService.ts')).toBe(same(a, 'orderService.ts'));
    expect(same(b, 'POST /api/orders')).toBe(same(a, 'POST /api/orders'));
    expect(same(b, 'orders.ts')).not.toBe(same(a, 'orders.ts'));
    expect(b.some(e => e.label === 'mount')).toBe(true);
  });

  it('a match at the start of a word ranks above letters scattered through one word', () => {
    const idx = buildIndex(files([file('src/overrider.ts', [sym('overrider', 'function', 1), sym('placeOrder', 'function', 2)]), file('src/r.ts', [sym('currentUser', 'function', 2)])]), domain());
    const order = query(idx, 'order').filter(r => r.entry.kind === 'symbol');
    expect(order.map(r => [r.entry.label, r.score])).toEqual([['placeOrder', WORD], ['overrider', INITIALS]]);
    expect(query(idx, 'user').find(r => r.entry.label === 'currentUser')?.score).toBe(WORD);
  });
});
