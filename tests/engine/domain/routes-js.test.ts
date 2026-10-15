import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { routesJs } from '../../../src/engine/domain/routes-js.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/routes/', import.meta.url));
const run = (rel: string, text: string) => {
  const f = analyzeFile(rel, langOf(rel), text, [routesJs]);
  return { routes: f.routes, mounts: f.mounts };
};

describe('routes-js analyzer', () => {
  for (const fw of ['express', 'fastify', 'hono', 'koa', 'nest', 'next-app', 'next-pages', 'sveltekit']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, fw, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${fw}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, fw, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to JS, TS and Svelte files', () => {
    expect(ANALYZERS).toContain(routesJs);
    expect(routesJs.applies('src/a.ts', 'typescript')).toBe(true);
    expect(routesJs.applies('src/a.tsx', 'tsx')).toBe(true);
    expect(routesJs.applies('src/a.js', 'javascript')).toBe(true);
    expect(routesJs.applies('src/routes/+page.svelte', 'svelte')).toBe(true);
    expect(routesJs.applies('app.py', 'python')).toBe(false);
  });

  it('ignores calls on receivers that are not routers', () => {
    const src = "import axios from 'axios';\nconst map = new Map();\naxios.get('/users');\nmap.get('/k');\nparams.get('/id');\ncache.delete('/key');\nfetch('/x');\n";
    expect(run('src/client.ts', src).routes).toEqual([]);
    expect(run('src/a.ts', "const api = axios.create();\napi.get('/users');\n").routes).toEqual([]);
    expect(run('src/b.tsx', "import api from './lib/api';\napi.get('/users');\n").routes).toEqual([]);
  });

  it('treats conventional receiver names as routers only when the file imports a server framework', () => {
    expect(run('src/hooks/useUsers.ts', "export function useUsers(api) { return api.get('/users'); }\nexport const save = (router, app, server, fastify) => { router.post('/a'); app.put('/b'); server.delete('/c'); fastify.get('/d'); };\n").routes).toEqual([]);
    expect(run('src/hooks/client.ts', "import { useQuery } from '@tanstack/react-query';\nexport const f = (api) => api.get('/users');\n").routes).toEqual([]);
    // Without a server import, names assigned from a router factory still count.
    const src = "const r = express.Router();\nconst app = express();\nconst h = new Hono();\nconst k = new Router();\nr.get('/r', a);\napp.post('/app', b);\nh.put('/h', c);\nk.delete('/k', d);\nfunction f(api) { api.get('/no'); }\n";
    expect(run('src/legacy.js', src).routes.map(r => `${r.method} ${r.path} ${r.framework}`)).toEqual(['GET /r express', 'POST /app express', 'PUT /h hono', 'DELETE /k express']);
    // With a server import, the conventional names stay routers (a router passed into a function).
    expect(run('src/routes.ts', "import type { Router } from 'express';\nexport function mount(router: Router) { router.get('/x', h); }\n").routes.map(r => r.path)).toEqual(['/x']);
  });

  it('keeps conventional receivers without a server import when the call passes a handler', () => {
    const src = "module.exports = (app) => {\n  app.get('/a', (req, res) => res.send('ok'));\n  app.post('/b', auth, create);\n  app.put('/c', async function (req, res) {});\n};\n";
    expect(run('routes/index.js', src).routes.map(r => `${r.method} ${r.path}`)).toEqual(['GET /a', 'POST /b', 'PUT /c']);
    const client = "export const f = (api, body) => { api.post('/u', body); api.get('/v', { params: { q: 1 } }); api.put('/w', body, { headers: {} }); };\n";
    expect(run('src/client.ts', client).routes).toEqual([]);
  });

  it('keeps a guessed receiver passing named handlers, chained or not, and drops client-shaped calls', () => {
    const src = "module.exports = (app) => {\n  app.get('/users', listUsers);\n  app.get('/users/:id', usersCtl.show);\n  app.post('/b', auth, create);\n  app.route('/x').get(list).post(req.body);\n};\n";
    expect(run('routes/users.js', src).routes.map(r => `${r.method} ${r.path} ${r.handler}`))
      .toEqual(['GET /users listUsers', 'GET /users/:id usersCtl.show', 'POST /b create', 'GET /x list']);
    const client = "export const f = (api, body, cfg) => { api.put('/w', body, cfg); };\n"
      + "export async function g(api, id, payload) {\n  if (id) return api.get('/u', id);\n  await api.post('/u', payload);\n  api.get('/u').then(done);\n  api.get('/u', id).catch(fail);\n  const r = api.get('/u', id);\n  use(api.get('/u', id));\n}\n"
      + "export const h = (api, id) => api.get('/u', id);\nexport const k = (app) => { app.route('/y').get(load).then(done); };\n";
    expect(run('src/client.ts', client).routes).toEqual([]);
  });

  it('keeps guessed routes with middleware factory calls, and drops client calls in any value position', () => {
    const src = "module.exports = (app) => {\n  app.get('/users', requireAuth(), list);\n  app.post('/u', validate(schema), create);\n  app.get('/x', ctrl.list.bind(ctrl))\n  if (admin) app.delete('/z', remove);\n};\n";
    expect(run('routes/users.js', src).routes.map(r => `${r.method} ${r.path}`)).toEqual(['GET /users', 'POST /u', 'GET /x', 'DELETE /z']);
    const client = "export async function g(api, id, event, ok) {\n  const [a, b] = await Promise.all([api.get('/a', id), api.get('/b', id)]);\n  void api.post('/track', event);\n  const c = ok ? api.get('/x', id) : null;\n  const d =\n          api.get('/u', id);\n  return ok && api.get('/v', id);\n}\n";
    expect(run('src/client.ts', client).routes).toEqual([]);
  });

  it('ignores member receivers except this.app/router/server and this.X assigned from a router factory', () => {
    expect(run('src/users.service.ts', "export class UsersService {\n  list() { return this.api.get('/users'); }\n}\nctx.router.get('/x', h);\n").routes).toEqual([]);
    const src = "import express from 'express';\nclass S {\n  web = express();\n  start() {\n    this.app.get('/a', a);\n    this.web.get('/w', w);\n  }\n}\n";
    expect(run('src/s.ts', src).routes.map(r => `${r.method} ${r.path} ${r.handler} ${r.line}`)).toEqual(['GET /a a 5', 'GET /w w 6']);
  });

  it('names only the last argument as the handler, unwrapping one call level', () => {
    const src = "import express from 'express';\nconst app = express();\napp.get('/a', requireAuth, asyncHandler(getX));\napp.get('/b', getY, limiter({ max: 1 }));\napp.get('/c', wrap(async (req, res) => {}));\n";
    expect(run('src/a.ts', src).routes.map(r => `${r.path} ${r.handler}`)).toEqual(['/a getX', '/b undefined', '/c inline']);
  });

  it('reads chained verb calls', () => {
    const src = "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/a', h1)\n  .post('/b', h2);\n";
    expect(run('src/a.ts', src).routes.map(r => `${r.method} ${r.path} ${r.handler} ${r.line}`)).toEqual(['GET /a h1 3', 'POST /b h2 4']);
  });

  it('reads verb calls with TypeScript type arguments, chained ones included', () => {
    const src = "import Fastify from 'fastify';\nconst fastify = Fastify();\nfastify.post<{ Body: User; Reply: Map<string, () => void> }>('/users', createUser);\n"
      + "import { Router } from 'express';\nconst router = Router();\nrouter.get<P>('/x/:id', getX)\n  .put <Params, Res>('/x/:id', putX);\nrouter.get<P>;\n";
    expect(run('src/a.ts', src).routes.map(r => `${r.method} ${r.path} ${r.handler} ${r.line}`))
      .toEqual(['POST /users createUser 3', 'GET /x/:id getX 6', 'PUT /x/:id putX 7']);
  });

  it('ignores routes written inside string literals', () => {
    const src = "const doc = \"app.get('/s', h)\";\nconst t = `router.post('/t', h)`;\nconst n = '@Controller() @Get()';\nconst e = 'export function GET() {}';\n";
    expect(run('src/doc.ts', src).routes).toEqual([]);
    expect(run('app/x/route.ts', src).routes).toEqual([]);
  });

  it('ignores express.Router prefix options and keeps the receiver', () => {
    expect(run('src/r.ts', "import express from 'express';\nconst r = express.Router({ mergeParams: true });\nr.get('/x', h);\n").routes)
      .toEqual([{ method: 'GET', path: '/x', handler: 'h', line: 3, kind: 'api', framework: 'express' }]);
  });

  it('survives a file cut mid-call', () => {
    expect(() => run('src/server.ts', "app.get('/x', (req")).not.toThrow();
    const routes = run('src/server.ts', "app.get('/x', (req").routes;
    expect(routes.length).toBeLessThanOrEqual(1);
    if (routes.length) expect(routes[0]).toMatchObject({ method: 'GET', path: '/x' });
    expect(() => run('src/server.ts', 'server.route({ method: [')).not.toThrow();
    expect(() => run('src/c.controller.ts', '@Controller(\n@Get(')).not.toThrow();
  });

  it('maps file-based routes for the root page, slots, catch-alls and monorepos', () => {
    expect(run('app/page.tsx', 'export default async function Home() {}\n').routes)
      .toEqual([{ method: 'PAGE', path: '/', handler: 'Home', line: 1, kind: 'page', framework: 'next' }]);
    expect(run('apps/web/src/app/@modal/docs/[[...slug]]/page.tsx', 'const Docs = () => null;\n\nexport default Docs;\n').routes)
      .toEqual([{ method: 'PAGE', path: '/docs/:slug*', handler: 'Docs', line: 3, kind: 'page', framework: 'next' }]);
    expect(run('src/routes/files/[...rest]/+server.js', 'export function GET() {}\n').routes)
      .toEqual([{ method: 'GET', path: '/files/:rest*', handler: 'GET', line: 1, kind: 'api', framework: 'sveltekit' }]);
    expect(run('app/api/route.ts', 'async function h() {}\nexport { h as POST };\n').routes)
      .toEqual([{ method: 'POST', path: '/api', handler: 'POST', line: 2, kind: 'api', framework: 'next' }]);
  });

  it('skips Next.js special pages and non-route files', () => {
    expect(run('pages/_app.tsx', 'export default function App() {}\n').routes).toEqual([]);
    expect(run('pages/_document.tsx', 'export default function D() {}\n').routes).toEqual([]);
    expect(run('pages/_error.tsx', 'export default function E() {}\n').routes).toEqual([]);
    expect(run('app/orders/helpers.ts', 'export function GET() {}\n').routes).toEqual([]);
  });

  it('stays linear on ~1 MB of repeated unterminated calls and imports', () => {
    for (const t of ['app.get('.repeat(120000), "app.get('/x', (".repeat(70000), 'import '.repeat(140000), 'const {'.repeat(140000), 'export {'.repeat(120000), 'r.route('.repeat(110000), '@Controller(@Get('.repeat(60000), 'app.get<'.repeat(120000), 'app.get<{ a: () => void }>'.repeat(40000)]) {
      const start = performance.now();
      run('src/big.ts', t);
      expect(performance.now() - start).toBeLessThan(1000);
    }
    const start = performance.now();
    run('app/x/route.ts', 'export {'.repeat(120000));
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('does not mount identifiers that are not imported', () => {
    expect(run('src/index.ts', "const app = express();\nconst r = express.Router();\napp.use('/r', r);\n").mounts).toEqual([]);
  });
});
