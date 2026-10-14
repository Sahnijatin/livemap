import { describe, it, expect } from 'vitest';
import { buildDomainIndex } from '../../../src/engine/domain/build-index.js';
import type { Entity, FileModel, Mount, Route } from '../../../src/shared/types.js';

const fm = (path: string, extra: Partial<FileModel> = {}): FileModel => ({
  path, lang: path.endsWith('.tsx') ? 'tsx' : 'typescript', size: 1, lines: 1, symbols: [],
  imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {}, ...extra,
});
const api = (method: string, path: string, line = 1, framework = 'express'): Route => ({ method, path, line, kind: 'api', framework });
const mount = (prefix: string, target: string | null, line = 1): Mount => ({ prefix, spec: './x', target, line, framework: 'express' });
const noText = () => null;
const texts = (m: Record<string, string>) => (p: string) => m[p] ?? null;

describe('buildDomainIndex: routes', () => {
  it('applies a mount prefix and records mountedVia', () => {
    const idx = buildDomainIndex([
      fm('server/index.ts', { mounts: [mount('/api', 'server/routes/orders.ts', 4)] }),
      fm('server/routes/orders.ts', { routes: [api('GET', '/orders', 3), api('POST', '/orders', 7)] }),
    ], noText);
    expect(idx.routes.map(r => [r.method, r.fullPath, r.mountedVia])).toEqual([
      ['GET', '/api/orders', ['server/index.ts']],
      ['POST', '/api/orders', ['server/index.ts']],
    ]);
    expect(idx.routes[0]).toMatchObject({ id: 'GET /api/orders server/routes/orders.ts:3', file: 'server/routes/orders.ts', path: '/orders', line: 3 });
  });

  it('applies nested mounts outermost first, and a root route keeps the prefix only', () => {
    const idx = buildDomainIndex([
      fm('a.ts', { mounts: [mount('/api', 'b.ts')] }),
      fm('b.ts', { mounts: [mount('/v1', 'c.ts')] }),
      fm('c.ts', { routes: [api('GET', '/items'), api('GET', '/', 2)] }),
    ], noText);
    expect(idx.routes.map(r => [r.fullPath, r.mountedVia])).toEqual([
      ['/api/v1', ['a.ts', 'b.ts']],
      ['/api/v1/items', ['a.ts', 'b.ts']],
    ]);
  });

  it('yields one route per mount of a file mounted twice', () => {
    const idx = buildDomainIndex([
      fm('a.ts', { mounts: [mount('/v1', 'r.ts'), mount('/v2', 'r.ts', 2)] }),
      fm('r.ts', { routes: [api('GET', '/x')] }),
    ], noText);
    expect(idx.routes.map(r => r.fullPath)).toEqual(['/v1/x', '/v2/x']);
    expect(new Set(idx.routes.map(r => r.id)).size).toBe(2);
  });

  it('merges one router mounted at the same prefix by two files into one route', () => {
    const idx = buildDomainIndex([
      fm('tests/app.ts', { mounts: [mount('/api', 'src/r.ts')] }),
      fm('src/app.ts', { mounts: [mount('/api', 'src/r.ts')] }),
      fm('src/r.ts', { routes: [api('GET', '/x'), api('POST', '/x', 2)] }),
    ], noText);
    expect(idx.routes.map(r => [r.id, r.mountedVia])).toEqual([
      ['GET /api/x src/r.ts:1', ['src/app.ts', 'tests/app.ts']],
      ['POST /api/x src/r.ts:2', ['src/app.ts', 'tests/app.ts']],
    ]);
    expect(idx.counts.routes).toBe(2);
    expect(new Set(idx.routes.map(r => r.id)).size).toBe(idx.routes.length);
  });

  it('terminates on a mount cycle', () => {
    const idx = buildDomainIndex([
      fm('a.ts', { mounts: [mount('/a', 'b.ts')] }),
      fm('b.ts', { mounts: [mount('/b', 'a.ts')], routes: [api('GET', '/x')] }),
    ], noText);
    expect(idx.routes.map(r => r.fullPath)).toEqual(['/a/x']);
  });

  it('caps mount depth at 5', () => {
    const files = [0, 1, 2, 3, 4, 5, 6, 7].map(i => fm(`f${i}.ts`, { mounts: [mount(`/p${i}`, `f${i + 1}.ts`)] }));
    files.push(fm('f8.ts', { routes: [api('GET', '/x')] }));
    const idx = buildDomainIndex(files, noText);
    expect(idx.routes.map(r => r.fullPath)).toEqual(['/p3/p4/p5/p6/p7/x']);
    expect(idx.routes[0].mountedVia).toHaveLength(5);
  });

  it('sorts by fullPath then method, and leaves screen paths unnormalized', () => {
    const idx = buildDomainIndex([
      fm('nav.tsx', { routes: [{ method: 'SCREEN', path: 'Home', line: 4, kind: 'screen', framework: 'react-navigation' }] }),
      fm('r.ts', { routes: [api('POST', '/b'), api('GET', '/b', 2), api('DELETE', '/a', 3)] }),
    ], noText);
    expect(idx.routes.map(r => `${r.method} ${r.fullPath}`)).toEqual(['DELETE /a', 'GET /b', 'POST /b', 'SCREEN Home']);
    expect(idx.routes[3].mountedVia).toBeUndefined();
  });

  it('drops next routes unless an npm manifest depends on next (R3)', () => {
    const files = [
      fm('src/pages/about.tsx', { routes: [{ method: 'PAGE', path: '/about', line: 1, kind: 'page', framework: 'next' }] }),
      fm('package.json', { lang: 'json', deps: { deps: [{ name: 'react', version: '18', eco: 'npm' }] } }),
    ];
    expect(buildDomainIndex(files, noText).routes).toEqual([]);
    files[1] = fm('package.json', { lang: 'json', deps: { deps: [{ name: 'next', version: '14', eco: 'npm' }] } });
    expect(buildDomainIndex(files, noText).routes.map(r => r.fullPath)).toEqual(['/about']);
  });

  it('promotes Expo files beside a _layout.tsx to screens', () => {
    const idx = buildDomainIndex([
      fm('mobile/app/_layout.tsx'),
      fm('mobile/app/index.tsx'),
      fm('mobile/app/(tabs)/settings.tsx'),
      fm('mobile/app/orders/[id].tsx'),
      fm('mobile/app/+not-found.tsx'),
      fm('mobile/app/profile.tsx', { routes: [{ method: 'SCREEN', path: '/profile', line: 2, handler: 'Profile', kind: 'screen', framework: 'expo-router' }] }),
      fm('mobile/app/util.ts'),
      fm('web/app/page.tsx'),
    ], texts({ 'mobile/app/orders/[id].tsx': 'import x from "y";\nexport default function OrderScreen() {}\n' }));
    expect(idx.routes.map(r => [r.method, r.fullPath, r.file, r.handler ?? null, r.line])).toEqual([
      ['SCREEN', '/', 'mobile/app/index.tsx', null, 1],
      ['SCREEN', '/orders/:id', 'mobile/app/orders/[id].tsx', 'OrderScreen', 2],
      ['SCREEN', '/profile', 'mobile/app/profile.tsx', 'Profile', 2],
      ['SCREEN', '/settings', 'mobile/app/(tabs)/settings.tsx', null, 1],
    ]);
    expect(idx.routes.every(r => r.kind === 'screen' && r.framework === 'expo-router')).toBe(true);
  });
});

const prismaOrder: Entity = {
  name: 'Order', table: 'orders', orm: 'prisma', file: 'prisma/schema.prisma', line: 10,
  fields: [
    { name: 'id', type: 'Int', pk: true, line: 11 },
    { name: 'userId', type: 'Int', line: 12, fk: { table: 'users', field: 'id' } },
    { name: 'user', type: 'User', line: 13, relation: { model: 'User', many: false } },
    { name: 'items', type: 'Item[]', line: 14, relation: { model: 'Item', many: true } },
  ],
};
const sqlOrders: Entity = {
  name: 'orders', table: 'orders', orm: 'sql', file: 'db/001.sql', line: 1,
  fields: [{ name: 'id', type: 'INT', line: 2 }, { name: 'total', type: 'NUMERIC', line: 3 }],
};
const alterOrders: Entity = {
  name: 'orders', table: 'orders', orm: 'sql', file: 'db/002.sql', line: 1, partial: true,
  fields: [{ name: 'status', type: 'TEXT', line: 1 }],
};
const user: Entity = { name: 'User', table: 'users', orm: 'prisma', file: 'prisma/schema.prisma', line: 1, fields: [{ name: 'id', type: 'Int' }] };

describe('buildDomainIndex: tables', () => {
  it('merges a Prisma model, a CREATE TABLE and an ALTER fragment into one table (Review Focus 3)', () => {
    const idx = buildDomainIndex([
      fm('db/002.sql', { lang: 'sql', entities: [alterOrders] }),
      fm('db/001.sql', { lang: 'sql', entities: [sqlOrders] }),
      fm('prisma/schema.prisma', { lang: 'prisma', entities: [user, prismaOrder] }),
    ], noText);
    expect(idx.tables.map(t => t.table)).toEqual(['orders', 'users']);
    const t = idx.tables[0];
    expect(t.name).toBe('Order');
    expect(t.sources).toEqual([{ file: 'db/001.sql', line: 1 }, { file: 'db/002.sql', line: 1 }, { file: 'prisma/schema.prisma', line: 10 }]);
    expect(t.fields.map(f => [f.name, f.file])).toEqual([
      ['id', 'prisma/schema.prisma'], ['userId', 'prisma/schema.prisma'], ['user', 'prisma/schema.prisma'], ['items', 'prisma/schema.prisma'],
      ['total', 'db/001.sql'],
      ['status', 'db/002.sql'],
    ]);
  });

  it('heads a merged table with the ORM entity over SQL migrations, whatever the path order', () => {
    const idx = buildDomainIndex([
      fm('a/001.sql', { lang: 'sql', entities: [sqlOrders] }),
      fm('z/schema.prisma', { lang: 'prisma', entities: [prismaOrder] }),
    ], noText);
    const t = idx.tables[0];
    expect([t.name, t.table, t.orm]).toEqual(['Order', 'orders', 'prisma']);
    expect(t.fields.map(f => [f.name, f.type, f.file])).toEqual([
      ['id', 'Int', 'z/schema.prisma'], ['userId', 'Int', 'z/schema.prisma'], ['user', 'User', 'z/schema.prisma'], ['items', 'Item[]', 'z/schema.prisma'],
      ['total', 'NUMERIC', 'a/001.sql'],
    ]);
  });

  it('names a table after its first non-partial entity', () => {
    const idx = buildDomainIndex([
      fm('a.sql', { lang: 'sql', entities: [alterOrders] }),
      fm('b.prisma', { lang: 'prisma', entities: [prismaOrder] }),
    ], noText);
    expect(idx.tables[0].name).toBe('Order');
    expect(idx.tables[0].orm).toBe('prisma');
  });

  it('derives relations from fk and relation fields', () => {
    const item: Entity = { name: 'Item', table: 'order_items', orm: 'prisma', file: 'p.prisma', line: 30, fields: [] };
    const idx = buildDomainIndex([fm('p.prisma', { lang: 'prisma', entities: [user, prismaOrder, item] })], noText);
    expect(idx.tables.find(t => t.table === 'orders')!.relations).toEqual([
      { field: 'userId', to: 'users', many: false, via: 'fk' },
      { field: 'user', to: 'users', many: false, via: 'relation' },
      { field: 'items', to: 'order_items', many: true, via: 'relation' },
    ]);
  });

  it('normalizes relation targets to the merged table name, keeping unmatched names raw', () => {
    const payments: Entity = { name: 'payments', table: 'payments', orm: 'sql', file: 'db.sql', line: 5, fields: [
      { name: 'user_id', type: 'INT', fk: { table: 'Users', field: 'id' } },
      { name: 'ledger_id', type: 'INT', fk: { table: 'Ledgers', field: 'id' } },
    ] };
    const users: Entity = { name: 'users', table: 'users', orm: 'sql', file: 'db.sql', line: 1, fields: [{ name: 'id', type: 'INT' }] };
    const idx = buildDomainIndex([fm('db.sql', { lang: 'sql', entities: [users, payments] })], noText);
    expect(idx.tables.find(t => t.table === 'payments')!.relations.map(r => r.to)).toEqual(['users', 'Ledgers']);
  });

  it('maps a foreign key naming a model in another file to that model\'s table (Room, Drizzle)', () => {
    const roomUser: Entity = { name: 'User', table: 'users', orm: 'room', file: 'app/User.kt', line: 3, fields: [{ name: 'id', type: 'Long', pk: true }] };
    const roomOrder: Entity = { name: 'Order', table: 'orders', orm: 'room', file: 'app/Order.kt', line: 5, fields: [
      { name: 'userId', type: 'Long', fk: { table: 'User', field: 'id' } },
    ] };
    const usersTable: Entity = { name: 'usersTable', table: 'app_users', orm: 'drizzle', file: 'db/users.ts', line: 1, fields: [{ name: 'id', type: 'serial', pk: true }] };
    const posts: Entity = { name: 'posts', table: 'posts', orm: 'drizzle', file: 'db/posts.ts', line: 1, fields: [
      { name: 'authorId', type: 'integer', fk: { table: 'usersTable', field: 'id' } },
    ] };
    const idx = buildDomainIndex([
      fm('app/Order.kt', { lang: 'kotlin', entities: [roomOrder] }), fm('app/User.kt', { lang: 'kotlin', entities: [roomUser] }),
      fm('db/posts.ts', { entities: [posts] }), fm('db/users.ts', { entities: [usersTable] }),
    ], noText);
    expect(idx.tables.find(t => t.table === 'orders')!.relations).toEqual([{ field: 'userId', to: 'users', many: false, via: 'fk' }]);
    expect(idx.tables.find(t => t.table === 'posts')!.relations).toEqual([{ field: 'authorId', to: 'app_users', many: false, via: 'fk' }]);
  });
});

describe('buildDomainIndex: dataRefs', () => {
  it('records model accessors, model and table names as whole words only', () => {
    const files = [
      fm('prisma/schema.prisma', { lang: 'prisma', entities: [user, prismaOrder] }),
      fm('src/orderService.ts'), fm('src/list.ts'), fm('src/user.ts'), fm('src/sql.ts'), fm('src/dollar.ts'), fm('.env', { lang: 'secret', flags: { secret: true } }),
    ];
    const idx = buildDomainIndex(files, texts({
      'prisma/schema.prisma': 'model Order {}',
      'src/orderService.ts': 'export const all = () => prisma.order.findMany();\n',
      'src/list.ts': 'const ordersList = []; const Orders2 = 1; const $Order = 2; const User_ = 3;\n',
      'src/user.ts': 'import type { User } from "@prisma/client";\n',
      'src/sql.ts': 'db.query(`select * from "orders"`); knex("users");\n',
      'src/dollar.ts': 'const x = order;\n',
    }));
    expect(idx.dataRefs).toEqual([
      { file: 'src/orderService.ts', tables: ['orders'] },
      { file: 'src/sql.ts', tables: ['orders', 'users'] },
      { file: 'src/user.ts', tables: ['users'] },
    ]);
  });

  it('counts model accessors only on a database client receiver', () => {
    const files = [
      fm('prisma/schema.prisma', { lang: 'prisma', entities: [user, prismaOrder] }),
      fm('src/a.ts'), fm('src/b.ts'), fm('src/c.ts'), fm('src/d.ts'), fm('src/e.ts'),
    ];
    const idx = buildDomainIndex(files, texts({
      'src/a.ts': 'const u = req.user; this.order = 1; self.user = 2; foo.prisma.order;\n',
      'src/b.ts': 'await this.prisma.user.findMany();\n',
      'src/c.ts': 'ctx.db.order.create(); await tx.user.update();\n',
      'src/d.ts': 'await db.order.findMany();\n',
      'src/e.ts': 'knex.order; drizzle.user;\n',
    }));
    expect(idx.dataRefs).toEqual([
      { file: 'src/b.ts', tables: ['users'] },
      { file: 'src/c.ts', tables: ['orders', 'users'] },
      { file: 'src/d.ts', tables: ['orders'] },
      { file: 'src/e.ts', tables: ['orders', 'users'] },
    ]);
  });

  it('scans code files only, not docs, config, styles or markup', () => {
    const langs = { 'README.md': 'markdown', 'a.json': 'json', 'a.yaml': 'yaml', 'a.toml': 'toml', 'a.txt': 'text', 'a.css': 'css', 'a.html': 'html', 'a.ts': 'typescript', 'a.py': 'python', 'q.sql': 'sql' } as const;
    const files = [fm('db.sql', { lang: 'sql', entities: [sqlOrders] }), ...Object.entries(langs).map(([p, lang]) => fm(p, { lang }))];
    const idx = buildDomainIndex(files, p => (p in langs ? 'select * from orders' : null));
    expect(idx.dataRefs.map(r => r.file)).toEqual(['a.py', 'a.ts', 'q.sql']);
  });

  it('skips files over 1 MB of text', () => {
    const big = 'x'.repeat(1_000_001) + ' orders';
    const idx = buildDomainIndex([fm('db.sql', { lang: 'sql', entities: [sqlOrders] }), fm('big.ts')], texts({ 'big.ts': big }));
    expect(idx.dataRefs).toEqual([]);
  });
});

describe('buildDomainIndex: deps, env, counts', () => {
  it('aggregates deps, scripts, env and counts', () => {
    const idx = buildDomainIndex([
      fm('package.json', { lang: 'json', deps: { deps: [{ name: 'express', version: '4', eco: 'npm', line: 3 }], scripts: { dev: 'tsx watch', test: 'vitest' } } }),
      fm('api/requirements.txt', { lang: 'text', deps: { deps: [{ name: 'fastapi', version: '', eco: 'pypi', line: 1 }] } }),
      fm('src/a.ts', { env: ['API_KEY', 'DB_URL'], routes: [api('GET', '/a')] }),
      fm('src/b.ts', { env: ['DB_URL'], routes: [{ method: 'PAGE', path: '/', line: 1, kind: 'page', framework: 'sveltekit' }] }),
      fm('.env', { lang: 'secret', env: ['DB_URL', 'ONLY_HERE'], flags: { secret: true } }),
      fm('.env.example', { lang: 'text', env: ['API_KEY'] }),
      fm('db.sql', { lang: 'sql', entities: [sqlOrders] }),
    ], noText);
    expect(idx.deps).toEqual([
      { name: 'fastapi', version: '', eco: 'pypi', line: 1, file: 'api/requirements.txt' },
      { name: 'express', version: '4', eco: 'npm', line: 3, file: 'package.json' },
    ]);
    expect(idx.scripts).toEqual([
      { file: 'package.json', name: 'dev', command: 'tsx watch' },
      { file: 'package.json', name: 'test', command: 'vitest' },
    ]);
    expect(idx.env).toEqual([
      { name: 'API_KEY', files: ['.env.example', 'src/a.ts'], inExample: true, definedInEnvFile: false },
      { name: 'DB_URL', files: ['.env', 'src/a.ts', 'src/b.ts'], inExample: false, definedInEnvFile: true },
      { name: 'ONLY_HERE', files: ['.env'], inExample: false, definedInEnvFile: true },
    ]);
    expect(idx.counts).toEqual({ routes: 1, pages: 1, screens: 0, tables: 1, deps: 2, env: 3 });
    expect(idx.stack.map(t => t.id)).toEqual(expect.arrayContaining(['express', 'fastapi']));
  });
});

describe('buildDomainIndex: performance (Review Focus 4)', () => {
  it('builds 150 tables x 8 fields, 600 routes and 2,000 files quickly', () => {
    const files: FileModel[] = [];
    const entities: Entity[] = [];
    for (let t = 0; t < 150; t++) {
      entities.push({ name: `Model${t}`, table: `table_${t}`, orm: 'prisma', file: 'schema.prisma', line: t * 10 + 1,
        fields: Array.from({ length: 8 }, (_, f) => ({ name: `f${f}`, type: 'String', line: t * 10 + 2 + f, ...(f === 1 ? { fk: { table: `table_${(t + 1) % 150}`, field: 'f0' } } : {}) })) });
    }
    files.push(fm('schema.prisma', { lang: 'prisma', entities }));
    const text = new Map<string, string>();
    for (let i = 0; i < 2000; i++) {
      const p = `src/f${i}.ts`;
      files.push(fm(p, {
        routes: i < 60 ? Array.from({ length: 10 }, (_, k) => api('GET', `/r${i}/${k}`, k + 1)) : [],
        mounts: i === 0 ? [mount('/api', 'src/f1.ts')] : undefined,
      }));
      text.set(p, `import { x } from './y';\nexport async function handler${i}() {\n  return prisma.model${i % 150}.findMany({ where: { id: 1 } });\n}\n`.repeat(20));
    }
    const t0 = performance.now();
    const idx = buildDomainIndex(files, p => text.get(p) ?? null);
    const ms = performance.now() - t0;
    console.log(`buildDomainIndex: ${ms.toFixed(1)} ms`);
    expect(idx.tables).toHaveLength(150);
    expect(idx.routes).toHaveLength(600);
    expect(idx.dataRefs).toHaveLength(2000);
    expect(ms).toBeLessThan(250);
  });
});

describe('review fixes: Flask url_prefix and JS Expo screens', () => {
  const flask = (method: string, path: string, basePrefix?: string): Route =>
    ({ method, path, line: 1, kind: 'api', framework: 'flask', ...(basePrefix ? { basePrefix } : {}) });
  const fmount = (prefix: string, target: string, replaces?: true): Mount => ({ prefix, spec: '.orders', target, line: 1, framework: 'flask', ...(replaces ? { replaces } : {}) });

  it('register_blueprint(url_prefix=...) replaces the blueprint\'s own prefix, as Flask does', () => {
    const idx = buildDomainIndex([
      fm('app.py', { lang: 'python', mounts: [fmount('/api', 'orders.py', true)] }),
      fm('orders.py', { lang: 'python', routes: [flask('GET', '/orders', '/orders'), flask('POST', '/orders/:id/cancel', '/orders')] }),
    ], noText);
    expect(idx.routes.map(r => r.fullPath)).toEqual(['/api', '/api/:id/cancel']);
  });

  it('without url_prefix the blueprint keeps its own prefix', () => {
    const idx = buildDomainIndex([
      fm('app.py', { lang: 'python', mounts: [fmount('', 'orders.py')] }),
      fm('orders.py', { lang: 'python', routes: [flask('GET', '/orders', '/orders')] }),
    ], noText);
    expect(idx.routes.map(r => r.fullPath)).toEqual(['/orders']);
  });

  it('promotes JavaScript Expo screens: .jsx always, .js with a default export', () => {
    const idx = buildDomainIndex([
      fm('app/_layout.jsx', { lang: 'javascript' }),
      fm('app/settings.jsx', { lang: 'javascript' }),
      fm('app/(tabs)/index.js', { lang: 'javascript' }),
      fm('app/helpers.js', { lang: 'javascript' }),
    ], texts({ 'app/(tabs)/index.js': 'export default function Home() {}\n', 'app/helpers.js': 'export const x = 1;\n' }));
    expect(idx.routes.map(r => [r.fullPath, r.file])).toEqual([['/', 'app/(tabs)/index.js'], ['/settings', 'app/settings.jsx']]);
  });
});

describe('review fixes: SQL migrations that drop and rename columns', () => {
  const sql = (path: string, fields: string[], extra: Partial<Entity> = {}): FileModel =>
    fm(path, { lang: 'sql', entities: [{ name: 'orders', table: 'orders', orm: 'sql', file: path, line: 1, fields: fields.map(n => ({ name: n, type: 'TEXT' })), ...extra }] });

  it('applies later migrations in path order', () => {
    const idx = buildDomainIndex([
      sql('db/003_cleanup.sql', [], { partial: true, dropped: ['legacy_code'], renamed: [['name', 'title']] }),
      sql('db/001_create.sql', ['id', 'legacy_code', 'name']),
      sql('db/002_status.sql', ['status'], { partial: true }),
    ], noText);
    expect(idx.tables[0].fields.map(f => f.name)).toEqual(['id', 'title', 'status']);
  });

  it('a column dropped and added again comes back', () => {
    const idx = buildDomainIndex([
      sql('db/001.sql', ['id', 'note']),
      sql('db/002.sql', [], { partial: true, dropped: ['note'] }),
      sql('db/003.sql', ['note'], { partial: true }),
    ], noText);
    expect(idx.tables[0].fields.map(f => f.name)).toEqual(['id', 'note']);
  });

  it('never drops or renames a field an ORM model declares', () => {
    const idx = buildDomainIndex([
      fm('prisma/schema.prisma', { lang: 'prisma', entities: [{ name: 'Order', table: 'orders', orm: 'prisma', file: 'prisma/schema.prisma', line: 1, fields: [{ name: 'id', type: 'Int' }, { name: 'name', type: 'String' }] }] }),
      sql('db/002.sql', [], { partial: true, dropped: ['name'], renamed: [['id', 'key']] }),
    ], noText);
    expect(idx.tables[0].fields.map(f => f.name)).toEqual(['id', 'name']);
  });
});

