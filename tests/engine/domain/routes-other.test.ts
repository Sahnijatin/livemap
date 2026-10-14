import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { routesOther } from '../../../src/engine/domain/routes-other.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/routes/', import.meta.url));
const run = (rel: string, text: string) => {
  const f = analyzeFile(rel, langOf(rel), text, [routesOther]);
  return { routes: f.routes, mounts: f.mounts };
};
const brief = (rel: string, text: string): string[] => run(rel, text).routes.map(r => `${r.method} ${r.path} ${r.handler} ${r.framework}`);

describe('routes-other analyzer', () => {
  for (const fw of ['fastapi', 'flask', 'django', 'go-http', 'gin', 'chi', 'spring', 'rails', 'laravel']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, fw, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${fw}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, fw, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to server languages and route files', () => {
    expect(ANALYZERS).toContain(routesOther);
    expect(routesOther.applies('app/main.py', 'python')).toBe(true);
    expect(routesOther.applies('cmd/main.go', 'go')).toBe(true);
    expect(routesOther.applies('src/A.java', 'java')).toBe(true);
    expect(routesOther.applies('src/A.kt', 'kotlin')).toBe(true);
    expect(routesOther.applies('config/routes.rb', 'ruby')).toBe(true);
    expect(routesOther.applies('app/models/order.rb', 'ruby')).toBe(false);
    expect(routesOther.applies('routes/web.php', 'php')).toBe(true);
    expect(routesOther.applies('app/Http/Kernel.php', 'php')).toBe(false);
    expect(routesOther.applies('src/a.ts', 'typescript')).toBe(false);
  });

  // Review Focus 2: each fixture is attributed to its own framework only.
  it('attributes the Flask fixture to flask alone across all analyzers', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, 'flask', 'expected.json'), 'utf8')) as Record<string, unknown>;
    const frameworks = new Set<string>();
    for (const rel of Object.keys(golden)) {
      const f = analyzeFile(rel, langOf(rel), fs.readFileSync(path.join(DIR, 'flask', rel), 'utf8'));
      for (const r of f.routes) frameworks.add(r.framework);
      for (const m of f.mounts) frameworks.add(m.framework);
    }
    expect([...frameworks]).toEqual(['flask']);
  });

  it('ignores HTTP client calls', () => {
    expect(run('client.py', "import requests\nrequests.get('/x')\nrequests.post('/y', json={})\n")).toEqual({ routes: [], mounts: [] });
    expect(run('client.go', 'package main\n\nimport "net/http"\n\nfunc f() {\n\thttp.Get("/x")\n\thttp.Post("/y", "a", nil)\n}\n')).toEqual({ routes: [], mounts: [] });
  });

  it('requires the framework import or a known receiver', () => {
    expect(brief('a.py', "@app.get('/x')\ndef x():\n    pass\n@app.route('/y')\ndef y():\n    pass\n")).toEqual([]);
    expect(brief('a.py', "import flask\napp = flask.Flask(__name__)\n@app.route('/y')\ndef y():\n    pass\n")).toEqual(['GET /y y flask']);
    expect(brief('a.py', "bp = Blueprint('b', __name__)\n@bp.route('/y')\ndef y():\n    pass\n")).toEqual(['GET /y y flask']);
    expect(brief('a.go', 'package x\n\nfunc f() {\n\tr.GET("/x", h)\n\tr.Get("/y", h)\n}\n')).toEqual([]);
    expect(brief('a.go', 'package x\n\nfunc f(e *gin.Engine) {\n\te.GET("/x", h)\n}\n')).toEqual(['GET /x h gin']);
    expect(brief('a.go', 'package x\n\nfunc f() {\n\tr := gin.New()\n\tr.POST("/x", h)\n}\n')).toEqual(['POST /x h gin']);
    expect(brief('a.go', 'package x\n\nimport "github.com/labstack/echo/v4"\n\nfunc f(e *echo.Echo) {\n\te.GET("/x", h)\n}\n')).toEqual([]);
    expect(brief('Client.java', '@FeignClient("orders")\ninterface Orders {\n  @GetMapping("/orders")\n  List<Order> list();\n}\n')).toEqual([]);
  });

  it('prefixes routes on a FastAPI router and an aliased Flask blueprint', () => {
    expect(brief('r.py', "from fastapi import APIRouter\nr = APIRouter(prefix=\"/v1/items\")\n@r.put('/{id}')\nasync def put_item(id: str):\n    pass\n"))
      .toEqual(['PUT /v1/items/:id put_item fastapi']);
    expect(run('r.py', "import fastapi\napi = fastapi.APIRouter(prefix='/v1')\nfrom .sub import items\napi.include_router(items.router, prefix='/items')\n").mounts)
      .toEqual([{ prefix: '/v1/items', spec: '.sub.items', line: 4, framework: 'fastapi' }]);
  });

  it('keeps prefixes across blocks longer than 10 KB', () => {
    const many = (f: (i: number) => string): string => Array.from({ length: 300 }, (_, i) => f(i)).join('');
    const php = "<?php\nRoute::prefix('admin')->group(function () {\n" + many(i => `    Route::get('/r${i}', [AdminOrderController::class, 'r${i}']);\n`) + "});\nRoute::get('/after', A::class);\n";
    expect(php.length).toBeGreaterThan(10_000);
    const lv = run('routes/web.php', php).routes;
    expect(lv).toHaveLength(301);
    expect(lv.slice(0, 300).every((r, i) => r.path === `/admin/r${i}`)).toBe(true);
    expect(lv[300].path).toBe('/after');
    const go = 'package main\n\nimport "github.com/go-chi/chi/v5"\n\nfunc f() {\n\tr := chi.NewRouter()\n\tr.Route("/api", func(r chi.Router) {\n'
      + many(i => `\t\tr.Get("/r${i}", handlers.ListOrdersR${i})\n`) + '\t})\n\tr.Get("/after", a)\n}\n';
    expect(go.length).toBeGreaterThan(10_000);
    const chi = run('main.go', go).routes;
    expect(chi).toHaveLength(301);
    expect(chi.slice(0, 300).every((r, i) => r.path === `/api/r${i}`)).toBe(true);
    expect(chi[300].path).toBe('/after');
  });

  it('reads chi verbs only on chi routers and their With/Group chains', () => {
    const src = 'package main\n\nimport "github.com/go-chi/chi/v5"\n\nfunc f(srv *httptest.Server, m *chi.Mux) {\n\tsrv.Client().Get("/health")\n\tcache.Get("/k")\n\tr := chi.NewRouter()\n\tr.With(mw).Group(g).Get("/ok", h)\n\tadmin := r.With(auth)\n\tadmin.Post("/a", p)\n\tm.Put("/m", u)\n}\n';
    expect(brief('main.go', src)).toEqual(['GET /ok h chi', 'POST /a p chi', 'PUT /m u chi']);
  });

  it('reads Go routes on struct-field receivers declared or assigned as routers', () => {
    const http = 'package api\n\nimport "net/http"\n\ntype Server struct {\n\tmux *http.ServeMux\n\tclient *http.Client\n}\n\nfunc (s *Server) routes() {\n\ts.mux.HandleFunc("GET /orders", s.listOrders)\n\ts.client.Get("/remote")\n\thttp.Get("/x")\n}\n';
    expect(brief('server.go', http)).toEqual(['GET /orders s.listOrders go-http']);
    const httpAssign = 'package api\n\nimport "net/http"\n\nfunc New() *Server {\n\ts := &Server{mux: http.NewServeMux()}\n\ts.mux.Handle("/health", health)\n\treturn s\n}\n\nfunc (a *App) init() {\n\ta.m = http.NewServeMux()\n\ta.m.HandleFunc("POST /items", a.create)\n}\n';
    expect(brief('server.go', httpAssign)).toEqual(['ANY /health health go-http', 'POST /items a.create go-http']);
    const chi = 'package api\n\nimport "github.com/go-chi/chi/v5"\n\ntype Server struct {\n\trouter chi.Router\n\tm *chi.Mux\n}\n\nfunc (s *Server) routes(srv *httptest.Server) {\n\ts.router = chi.NewRouter()\n\ts.router.Get("/orders", s.list)\n\ts.m.Post("/orders", s.create)\n\ts.cache.Get("/k")\n\tsrv.Client().Get("/health")\n}\n';
    expect(brief('server.go', chi)).toEqual(['GET /orders s.list chi', 'POST /orders s.create chi']);
    const gin = 'package api\n\nimport "github.com/gin-gonic/gin"\n\ntype App struct {\n\tRouter *gin.Engine\n\tg *gin.RouterGroup\n}\n\nfunc NewApp() *App {\n\treturn &App{r: gin.Default()}\n}\n\nfunc (a *App) routes() {\n\ta.Router.GET("/orders", listOrders)\n\ta.g.POST("/orders", createOrder)\n\ta.r.DELETE("/orders/:id", deleteOrder)\n\ta.cache.GET("/k")\n}\n';
    expect(brief('app.go', gin)).toEqual(['GET /orders listOrders gin', 'POST /orders createOrder gin', 'DELETE /orders/:id deleteOrder gin']);
  });

  it('takes the Spring prefix from the top-level class past nested classes and companions', () => {
    const java = '@RestController\n@RequestMapping("/orders")\npublic class OrderController {\n    static class Dto { int x; }\n    @GetMapping("/{id}")\n    public Order get() { return null; }\n}\n';
    expect(brief('OrderController.java', java)).toEqual(['GET /orders/:id get spring']);
    const kt = '@RestController\n@RequestMapping("/users")\nclass UserController {\n    companion object Factory { fun make() = 1 }\n    @GetMapping\n    fun list(): List<User> = listOf()\n}\n';
    expect(brief('UserController.kt', kt)).toEqual(['GET /users list spring']);
  });

  it('survives malformed Python, Go and Ruby', () => {
    for (const [rel, t] of [
      ['a.py', "from fastapi import FastAPI\n@app.get('/x'"], ['a.py', "from flask import Flask\n@app.route('/x', methods=["], ['urls.py', "path('x/', include("],
      ['a.go', 'import "github.com/gin-gonic/gin"\nr.GET("/x", func(c'], ['a.go', 'import "github.com/go-chi/chi/v5"\nr.Route("/a", func(r chi.Router) {'],
      ['config/routes.rb', 'namespace :api do\n  resources :orders, only: ['], ['config/routes.rb', 'end\nend\nresources'],
      ['A.java', '@RequestMapping(\n@GetMapping('], ['routes/web.php', "Route::prefix('a')->group(function () {"],
    ] as const) {
      expect(() => run(rel, t)).not.toThrow();
    }
    const cut = run('a.go', 'import "github.com/gin-gonic/gin"\nr.GET("/x", func(c').routes;
    expect(cut.length).toBeLessThanOrEqual(1);
  });

  it('stays linear on ~1 MB of repeated unterminated constructs', () => {
    const cases: [string, string][] = [
      ['a.py', "from fastapi import FastAPI\n" + "@app.get('/x', (\n".repeat(60000)],
      ['a.py', 'from x import (' + 'a, '.repeat(300000)],
      ['urls.py', "path('x', include(".repeat(55000)],
      ['a.go', 'import "github.com/go-chi/chi/v5"\n' + 'r.Route("/a", func(r chi.Router) {\n'.repeat(30000)],
      ['a.go', 'import "github.com/gin-gonic/gin"\n' + 'g := r.Group("/a")\n'.repeat(55000)],
      ['A.java', '@RequestMapping("/a")\n'.repeat(45000)],
      ['config/routes.rb', 'namespace :a do\n'.repeat(60000)],
      ['config/routes.rb', 'resources :a, only: ['.repeat(45000)],
      ['routes/web.php', "Route::prefix('a')->group(function () {\n".repeat(25000)],
      ['a.go', 'import "github.com/go-chi/chi/v5"\n' + 'r.With(a).Get("/x", h)\n'.repeat(45000)],
      ['a.go', 'import "github.com/go-chi/chi/v5"\n' + ').Get('.repeat(170000)],
    ];
    for (const [rel, t] of cases) {
      const start = performance.now();
      run(rel, t);
      expect(performance.now() - start, rel).toBeLessThan(1000);
    }
  });
});
