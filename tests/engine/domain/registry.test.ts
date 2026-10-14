import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANALYZERS, analyzeFile, type Analyzer } from '../../../src/engine/domain/index.js';
import { bracketPairs, lineAt, maskCommentsAndStrings, normPath, resetScanBudget, splitArgs } from '../../../src/engine/domain/util.js';
import { ProjectModel } from '../../../src/engine/project.js';
import { buildChange } from '../../../src/engine/differ.js';
import { resolveSpecifier, type ImportCtx } from '../../../src/engine/imports.js';
import { buildDomainIndex } from '../../../src/engine/domain/build-index.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('analyzeFile', () => {
  it('merges applying analyzers, isolates a throwing one and logs it once', () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { errors.push(String(s)); return true; }) as typeof process.stderr.write);
    const skipped = vi.fn(() => ({ env: ['NOPE'] }));
    const list: Analyzer[] = [
      {
        name: 'fake-routes', applies: () => true,
        run: () => ({
          routes: [
            { method: 'POST', path: '/b', line: 4, kind: 'api', framework: 'test' },
            { method: 'GET', path: '/b', line: 4, kind: 'api', framework: 'test' },
            { method: 'GET', path: '/a', line: 2, kind: 'api', framework: 'test' },
          ],
          env: ['Z', 'A', 'Z'],
        }),
      },
      { name: 'fake-throws', applies: () => true, run: () => { throw new Error('boom'); } },
      { name: 'fake-skip', applies: () => false, run: skipped },
    ];
    const facts = analyzeFile('src/x.ts', 'typescript', 'text', list);
    analyzeFile('src/y.ts', 'typescript', 'text', list);
    expect(facts).toEqual({
      routes: [
        { method: 'GET', path: '/a', line: 2, kind: 'api', framework: 'test' },
        { method: 'GET', path: '/b', line: 4, kind: 'api', framework: 'test' },
        { method: 'POST', path: '/b', line: 4, kind: 'api', framework: 'test' },
      ],
      entities: [], env: ['A', 'Z'], mounts: [],
    });
    expect(skipped).not.toHaveBeenCalled();
    expect(errors).toEqual(['livemap: analyzer fake-throws failed on src/x.ts: boom\n']);
  });

  it('returns empty facts when nothing applies', () => {
    expect(analyzeFile('a.md', 'markdown', '# x', [])).toEqual({ routes: [], entities: [], env: [], mounts: [] });
  });

  // Review Focus 1: the real analyzers stay linear on hostile input.
  const timed = (rel: string, text: string): number => {
    const t0 = performance.now();
    analyzeFile(rel, rel.endsWith('.json') ? 'json' : rel.endsWith('.py') ? 'python' : 'javascript', text);
    return performance.now() - t0;
  };
  it('handles a 1 MB minified line in under 1,000 ms', () => {
    const big = 'a=1;'.repeat(250000);
    expect(timed('dist/app.min.js', big)).toBeLessThan(1000);
    expect(timed('app.py', big)).toBeLessThan(1000);
    expect(timed('package.json', big)).toBeLessThan(1000);
  });
  it('handles unterminated input in under 1,000 ms without throwing', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const files = ['a.js', 'a.py', 'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'build.gradle', 'pubspec.yaml', 'Podfile', '.env.example'];
    for (const bad of ['`${', '{{{', '"abc', "'abc", '/* x', 'process.env[', 'os.environ.get(']) {
      for (const f of files) expect(timed(f, bad.repeat(1000))).toBeLessThan(1000);
    }
    expect(spy).not.toHaveBeenCalled();
  });
  it('handles ~1 MB unterminated input in under 1,000 ms', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const big = ['`${'.repeat(330000), '{{{'.repeat(330000), '"abc'.repeat(250000), '/* x'.repeat(250000), 'process.env['.repeat(80000), 'os.environ.get('.repeat(65000)];
    for (const t of big) for (const f of ['a.js', 'a.py', 'package.json', 'pyproject.toml']) expect(timed(f, t)).toBeLessThan(1000);
    const sp = ' '.repeat(1_000_000);
    const manifests: [string, string][] = [['Gemfile', 'gem ' + sp], ['Podfile', 'pod (' + sp], ['build.gradle', 'implementation' + sp + 'x'],
      ['Cargo.toml', '[' + sp], ['requirements.txt', 'a' + sp + 'x'], ['pyproject.toml', '[project]\ndependencies = [' + '"a[b]",'.repeat(150000)]];
    for (const [f, t] of manifests) expect(timed(f, t)).toBeLessThan(1000);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('util', () => {
  it('lineAt maps offsets to 1-based lines', () => {
    const t = 'a\nbb\n\nccc';
    expect([0, 1, 2, 4, 5, 6, 9].map(i => lineAt(t, i))).toEqual([1, 1, 2, 2, 3, 4, 4]);
    expect(lineAt('x', 0)).toBe(1);
  });

  it('maskCommentsAndStrings blanks comments, keeping offsets and strings', () => {
    const js = 'a // c\nb /* d\ne */ f\n"// s" `/* t */`\n';
    const m = maskCommentsAndStrings(js, 'typescript');
    expect(m.length).toBe(js.length);
    expect(m).toBe('a     \nb     \n     f\n"// s" `/* t */`\n');
    expect(maskCommentsAndStrings("x = 1 # c\ny = '#s'\n", 'python')).toBe("x = 1    \ny = '#s'\n");
    expect(maskCommentsAndStrings('a -- c\nb', 'sql')).toBe('a     \nb');
    expect(maskCommentsAndStrings('$a; # c\n// d\n', 'php')).toBe('$a;    \n    \n');
  });

  it('maskCommentsAndStrings handles Ruby, Go, JVM and Dart comment and string forms', () => {
    expect(maskCommentsAndStrings("a # c\n=begin\nget 'x'\n=end\nb = '#s'\nx =begin\n", 'ruby')).toBe("a    \n      \n       \n    \nb = '#s'\nx =begin\n");
    expect(maskCommentsAndStrings('a // c\nb := `// raw\n/* s */`\nc /* d */\n', 'go')).toBe('a     \nb := `// raw\n/* s */`\nc        \n');
    expect(maskCommentsAndStrings('a // c\n/** d */ b\n', 'java')).toBe('a     \n         b\n');
    for (const lang of ['kotlin', 'java', 'swift'] as const) {
      expect(maskCommentsAndStrings('val s = """\n// kept\n""" // c\n', lang)).toBe('val s = """\n// kept\n"""     \n');
    }
    expect(maskCommentsAndStrings("var s = '''\n// kept\n'''; // c\n", 'dart')).toBe("var s = '''\n// kept\n''';     \n");
  });

  it('bracketPairs matches brackets both ways and leaves unclosed ones unmatched', () => {
    const p = bracketPairs('a(b[c]{d})( x] }');
    expect([p[1], p[9], p[3], p[5], p[6], p[8]]).toEqual([9, 1, 5, 3, 8, 6]);
    expect([p[10], p[13], p[15]]).toEqual([-1, -1, -1]);
    expect(bracketPairs('(]')[0]).toBe(-1);
  });

  it('splitArgs steps over paired groups, so a block past 10 KB keeps its true end', () => {
    const code = 'f("/a", function () {' + 'x();\n'.repeat(4000) + '}) + g';
    resetScanBudget(1_000_000);
    const capped = splitArgs(code, 1);
    expect(capped.end).toBeLessThan(code.length - 5);
    resetScanBudget(1_000_000);
    const paired = splitArgs(code, 1, undefined, { pairs: bracketPairs(code) });
    expect(paired.end).toBe(code.indexOf(') + g') + 1);
    expect(paired.args[0]).toBe('"/a"');
    resetScanBudget(1_000_000);
    expect(splitArgs('a, b\n  c', 0, undefined, { line: true }).args).toEqual(['a', 'b']);
  });

  it('normPath applies the route path rules', () => {
    expect(normPath('')).toBe('/');
    expect(normPath('/')).toBe('/');
    expect(normPath('orders/')).toBe('/orders');
    expect(normPath('//api//orders//')).toBe('/api/orders');
    expect(normPath('/orders/[id]')).toBe('/orders/:id');
    expect(normPath('/orders/{id}')).toBe('/orders/:id');
    expect(normPath('/orders/{id:int}')).toBe('/orders/:id');
    expect(normPath('/orders/<int:id>')).toBe('/orders/:id');
    expect(normPath('/orders/<id>')).toBe('/orders/:id');
    expect(normPath('/docs/[...slug]')).toBe('/docs/:slug*');
    expect(normPath('/docs/[[...slug]]')).toBe('/docs/:slug*');
    expect(normPath('/orders/:id')).toBe('/orders/:id');
  });
});

describe('resolveSpecifier', () => {
  const files = ['src/routes/orders.ts', 'src/lib/index.ts', 'src/util.ts', 'app/main.py', 'app/routers/orders.py', 'app/x.py', 'app/pkg/__init__.py', 'orders/urls.py', 'main.go'].sort();
  const set = new Set(files);
  const ctx: ImportCtx = { has: p => set.has(p), files, aliases: [['@lib', ['src/lib']]], goModule: null };
  it('resolves JS/TS relative, alias, extension swap and index files', () => {
    expect(resolveSpecifier('src/index.ts', 'typescript', './routes/orders', ctx)).toBe('src/routes/orders.ts');
    expect(resolveSpecifier('src/index.ts', 'typescript', './routes/orders.js', ctx)).toBe('src/routes/orders.ts');
    expect(resolveSpecifier('src/routes/orders.ts', 'typescript', '../util', ctx)).toBe('src/util.ts');
    expect(resolveSpecifier('src/index.ts', 'typescript', './lib', ctx)).toBe('src/lib/index.ts');
    expect(resolveSpecifier('src/index.ts', 'typescript', '@lib', ctx)).toBe('src/lib/index.ts');
    expect(resolveSpecifier('src/index.ts', 'typescript', '@/util', ctx)).toBe('src/util.ts');
    expect(resolveSpecifier('src/index.ts', 'typescript', 'express', ctx)).toBeNull();
    expect(resolveSpecifier('src/index.ts', 'typescript', './missing', ctx)).toBeNull();
  });
  it('resolves Python relative and absolute dotted modules', () => {
    expect(resolveSpecifier('app/main.py', 'python', '.routers.orders', ctx)).toBe('app/routers/orders.py');
    expect(resolveSpecifier('app/routers/orders.py', 'python', '..x', ctx)).toBe('app/x.py');
    expect(resolveSpecifier('app/main.py', 'python', '.pkg', ctx)).toBe('app/pkg/__init__.py');
    expect(resolveSpecifier('app/main.py', 'python', 'app.routers.orders', ctx)).toBe('app/routers/orders.py');
    expect(resolveSpecifier('project/urls.py', 'python', 'orders.urls', ctx)).toBe('orders/urls.py');
    expect(resolveSpecifier('app/main.py', 'python', 'fastapi', ctx)).toBeNull();
  });
  it('resolves absolute dotted Python modules from the importing file\'s ancestor directories, nearest first', () => {
    const nested = ['backend/config/urls.py', 'backend/shop/urls.py', 'services/ml/main.py', 'services/ml/routers/predict.py', 'routers/predict.py', 'web/app.py', 'web/api/__init__.py'].sort();
    const s = new Set(nested);
    const c: ImportCtx = { has: p => s.has(p), files: nested, aliases: [], goModule: null };
    expect(resolveSpecifier('backend/config/urls.py', 'python', 'shop.urls', c)).toBe('backend/shop/urls.py');
    expect(resolveSpecifier('services/ml/main.py', 'python', 'routers.predict', c)).toBe('services/ml/routers/predict.py');
    expect(resolveSpecifier('web/app.py', 'python', 'api', c)).toBe('web/api/__init__.py');
    expect(resolveSpecifier('main.py', 'python', 'routers.predict', c)).toBe('routers/predict.py');
    expect(resolveSpecifier('backend/config/urls.py', 'python', 'missing.urls', c)).toBeNull();
  });
  it('returns null for other languages', () => {
    expect(resolveSpecifier('main.go', 'go', './x', ctx)).toBeNull();
  });
});

describe('ProjectModel domain wiring', () => {
  let root: string;
  const put = (rel: string, data: string): void => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  };
  const mounter: Analyzer = {
    name: 'test-mounts',
    applies: rel => rel === 'src/index.ts',
    run: () => ({ mounts: [{ prefix: '/api', spec: './routes/orders', line: 1, framework: 'test' }] }),
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-domain-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('fills deps and scripts, and diffs a version change', async () => {
    put('package.json', '{"dependencies":{"zod":"^3.23.0"},"scripts":{"dev":"vite"}}');
    put('src/a.ts', 'export const a = process.env.API_URL;\n');
    put('.env', 'SECRET_KEY=value\n');
    const m = new ProjectModel(root);
    await m.scan();
    const pkg = m.get('package.json')!;
    expect(pkg.deps!.deps[0]).toEqual({ name: 'zod', version: '^3.23.0', eco: 'npm', line: 1 });
    expect(pkg.deps!.scripts).toEqual({ dev: 'vite' });
    expect(m.get('src/a.ts')!.env).toEqual(['API_URL']);
    expect(m.get('src/a.ts')!.deps).toBeUndefined();
    expect(m.get('src/a.ts')!.mounts).toBeUndefined();
    expect(m.get('.env')!.env).toEqual(['SECRET_KEY']);

    put('package.json', '{"dependencies":{"zod":"^3.24.0"},"scripts":{"dev":"vite"}}');
    const r = await m.update('package.json', 'change');
    const c = buildChange(r!, 1);
    expect(c.deps!.changed[0]).toMatchObject({ name: 'zod', version: '^3.24.0', from: '^3.23.0' });
  });

  it('resolves mount targets in build and re-resolves them on relink', async () => {
    put('src/index.ts', "import orders from './routes/orders';\n");
    const m = new ProjectModel(root, { analyzers: [...ANALYZERS, mounter] });
    await m.scan();
    expect(m.get('src/index.ts')!.mounts).toEqual([{ prefix: '/api', spec: './routes/orders', line: 1, framework: 'test', target: null }]);

    put('src/routes/orders.ts', 'export default {};\n');
    const r = await m.update('src/routes/orders.ts', 'add');
    expect(r!.touched.map(f => f.path)).toEqual(['src/index.ts']);
    expect(m.get('src/index.ts')!.mounts![0].target).toBe('src/routes/orders.ts');

    fs.rmSync(path.join(root, 'src/routes/orders.ts'));
    const d = await m.update('src/routes/orders.ts', 'unlink');
    expect(d!.touched.map(f => f.path)).toEqual(['src/index.ts']);
    expect(m.get('src/index.ts')!.mounts![0].target).toBeNull();
  });

  it('keeps Django and FastAPI mount prefixes for projects nested below the repo root', async () => {
    put('backend/config/urls.py', "from django.urls import include, path\n\nurlpatterns = [\n    path('api/shop/', include('shop.urls')),\n]\n");
    put('backend/shop/urls.py', "from django.urls import path\nfrom . import views\n\nurlpatterns = [\n    path('items/<int:pk>/', views.item),\n]\n");
    put('services/ml/main.py', "from fastapi import FastAPI\nfrom routers import predict\n\napp = FastAPI()\napp.include_router(predict.router, prefix='/v1')\n");
    put('services/ml/routers/__init__.py', '');
    put('services/ml/routers/predict.py', "from fastapi import APIRouter\n\nrouter = APIRouter()\n\n@router.post('/predict')\ndef predict():\n    pass\n");
    const m = new ProjectModel(root);
    await m.scan();
    const idx = buildDomainIndex(m.all(), () => null);
    expect(idx.routes.map(r => `${r.method} ${r.fullPath}`)).toEqual(['ANY /api/shop/items/:pk', 'POST /v1/predict']);
  });

  it('counts a mount target change as touched even when local imports stay the same', async () => {
    put('src/index.ts', 'export {};\n');
    const m = new ProjectModel(root, { analyzers: [mounter] });
    await m.scan();
    put('src/routes/orders.ts', 'export default {};\n');
    const r = await m.update('src/routes/orders.ts', 'add');
    expect(m.get('src/index.ts')!.imports.local).toEqual([]);
    expect(r!.touched.map(f => f.path)).toEqual(['src/routes/orders.ts', 'src/index.ts'].slice(1));
    expect(r!.touched[0].mounts![0].target).toBe('src/routes/orders.ts');
  });
});
