import { describe, it, expect } from 'vitest';
import type { ApiRoute, DomainIndex } from '@shared/domain.js';
import type { UsedByEntry } from '@shared/protocol.js';
import type { FileModel } from '@shared/types.js';
import { emptyDomain, file, sym } from './fixtures';
import { buildFlows, flowGraph } from './api-flow';

const IDX = 'server/index.ts';
const ORD = 'server/routes/orders.ts';
const SVC = 'server/services/orderService.ts';
const DB = 'server/db.ts';
const SCHEMA = 'prisma/schema.prisma';

const route = (method: string, path: string, handler: string | undefined, line: number, extra: Partial<ApiRoute> = {}): ApiRoute => ({
  id: `${method} /api/orders${path === '/' ? '' : path} ${ORD}:${line}`, method, path, fullPath: `/api/orders${path === '/' ? '' : path}`,
  handler, line, kind: 'api', framework: 'express', file: ORD, mountedVia: [IDX], ...extra,
});

function project(): { domain: DomainIndex; files: Record<string, FileModel>; usedBy: UsedByEntry[] } {
  const files: Record<string, FileModel> = {
    [IDX]: file(IDX, [], { imports: { local: [ORD], external: ['express'] } }),
    [ORD]: file(ORD, [sym('router', 'variable', 3), sym('getOrders', 'function', 6), sym('createOrder', 'function', 12)], {
      imports: { local: [SVC], external: ['express'] },
      routes: [{ method: 'GET', path: '/', handler: 'getOrders', line: 18, kind: 'api', framework: 'express' }],
    }),
    [SVC]: file(SVC, [sym('listOrders', 'function', 4), sym('insertOrder', 'function', 9), sym('unused', 'function', 14)], { imports: { local: [DB], external: [] } }),
    [DB]: file(DB, [sym('prisma', 'variable', 2)]),
    [SCHEMA]: file(SCHEMA, [], { lang: 'prisma', entities: [{ name: 'Order', table: 'orders', orm: 'prisma', file: SCHEMA, line: 1, fields: [] }] }),
  };
  const domain = emptyDomain();
  domain.routes = [
    route('GET', '/', 'getOrders', 18),
    route('POST', '/', 'inline', 19),
    { id: `PAGE /about app/about/page.tsx:1`, method: 'PAGE', path: '/about', fullPath: '/about', line: 1, kind: 'page', framework: 'next', file: 'app/about/page.tsx' },
  ];
  domain.dataRefs = [{ file: SVC, tables: ['orders'] }];
  const usedBy: UsedByEntry[] = [
    { file: SVC, symbol: 'listOrders', usedIn: [ORD] },
    { file: SVC, symbol: 'insertOrder', usedIn: ['server/jobs/import.ts'] },
    { file: DB, symbol: 'prisma', usedIn: [SVC] },
  ];
  return { domain, files, usedBy };
}

describe('buildFlows', () => {
  it('gives one flow per API route with its handler line, services and tables', () => {
    const { domain, files, usedBy } = project();
    const flows = buildFlows(domain, files, usedBy);
    expect(flows).toHaveLength(2);
    const [get] = flows;
    expect(get.route.method).toBe('GET');
    expect(get.handler).toEqual({ name: 'getOrders', file: ORD, line: 6 });
    expect(get.services).toEqual([{ file: SVC, symbols: ['listOrders'] }]);
    expect(get.tables).toEqual(['orders']);
  });

  it('uses the route line for an inline handler', () => {
    const { domain, files, usedBy } = project();
    const post = buildFlows(domain, files, usedBy)[1];
    expect(post.handler).toEqual({ name: 'inline', file: ORD, line: 19 });
  });

  it('a route without a handler has none, and a handler not in the file has no line', () => {
    const { domain, files, usedBy } = project();
    domain.routes = [route('GET', '/', undefined, 18), route('PUT', '/:id', 'ctrl.updateOrder', 20)];
    const flows = buildFlows(domain, files, usedBy);
    expect(flows[0].handler).toBeNull();
    expect(flows[1].handler).toEqual({ name: 'ctrl.updateOrder', file: ORD });
  });

  it('finds a dotted handler by its last name in the route file, nested symbols included', () => {
    const { domain, files, usedBy } = project();
    files[ORD] = { ...files[ORD], symbols: [sym('OrdersController', 'class', 2, [sym('list', 'method', 7, [], 'OrdersController.list')])] };
    domain.routes = [route('GET', '/', 'OrdersController.list', 18)];
    expect(buildFlows(domain, files, usedBy)[0].handler).toEqual({ name: 'OrdersController.list', file: ORD, line: 7 });
  });

  it('leaves out imports that are route files or define entities', () => {
    const { domain, files, usedBy } = project();
    const MODELS = 'server/models.ts';
    const OTHER = 'server/routes/users.ts';
    files[MODELS] = file(MODELS, [], { entities: [{ name: 'Order', table: 'orders', orm: 'typeorm', file: MODELS, line: 1, fields: [] }] });
    files[OTHER] = file(OTHER);
    files[ORD] = { ...files[ORD], imports: { local: [SVC, MODELS, OTHER], external: [] } };
    domain.routes = [...domain.routes, { ...route('GET', '/', 'listUsers', 4), id: 'u', file: OTHER, fullPath: '/api/users' }];
    const get = buildFlows(domain, files, usedBy)[0];
    expect(get.services.map(s => s.file)).toEqual([SVC]);
  });

  it('unions the tables of the route file and its services', () => {
    const { domain, files, usedBy } = project();
    domain.dataRefs = [{ file: ORD, tables: ['audit_log', 'orders'] }, { file: SVC, tables: ['orders', 'customers'] }];
    expect(buildFlows(domain, files, usedBy)[0].tables).toEqual(['audit_log', 'orders', 'customers']);
  });

  it('dedupes tables case-insensitively, keeping the first spelling', () => {
    const { domain, files, usedBy } = project();
    domain.dataRefs = [{ file: ORD, tables: ['Orders'] }, { file: SVC, tables: ['orders', 'customers'] }];
    expect(buildFlows(domain, files, usedBy)[0].tables).toEqual(['Orders', 'customers']);
  });

  it('gives each inline handler its own card, while named handlers in a file share one', () => {
    const { domain, files, usedBy } = project();
    domain.routes = [route('POST', '/', 'inline', 19), route('PUT', '/', 'inline', 22), route('GET', '/', 'getOrders', 18), route('HEAD', '/', 'getOrders', 25)];
    const g = flowGraph(buildFlows(domain, files, usedBy), domain.dataRefs);
    expect(g.lanes[1]).toHaveLength(3);
    expect(g.lanes[1].map(n => n.flows)).toEqual([[0], [1], [2, 3]]);
  });

  it('never throws when a route file is missing from the file map', () => {
    const { domain, usedBy } = project();
    const flows = buildFlows(domain, {}, usedBy);
    expect(flows[0]).toMatchObject({ handler: { name: 'getOrders', file: ORD }, services: [], tables: [] });
  });
});
