import { describe, it, expect } from 'vitest';
import type { Lang } from '../../src/shared/types.js';
import { extractImports, readTsconfigAliases, indexStats, type ImportCtx } from '../../src/engine/imports.js';

const FILES = ['src/a.ts','src/lib/b.ts','src/lib/index.ts','src/ui/c.tsx','pkg/__init__.py','pkg/mod.py','pkg/sub/x.py','app/main.py','internal/db/db.go','internal/db/conn.go','src/lib.rs','src/api.rs','src/api/routes.rs','src/main/java/com/shop/Order.java','lib/util.rb','include/geo.h'];
const set = new Set(FILES);
const imp = (path: string, lang: Lang, src: string, ctx: Partial<ImportCtx> = {}) =>
  extractImports(path, lang, src, { has: p => set.has(p), files: FILES, aliases: [], goModule: null, ...ctx });

describe('extractImports', () => {
  it('typescript', () => {
    expect(imp('src/a.ts','typescript',`import x from './lib/b'; import y from './lib'; import z from '@/ui/c'; import r from 'react'; import t from '@scope/pkg/deep'; const f = require('node:fs')`))
      .toEqual({ local: ['src/lib/b.ts','src/lib/index.ts','src/ui/c.tsx'], external: ['react','@scope/pkg','node:fs'] });
    expect(imp('src/a.ts','typescript',`import b from '~lib/b'`, { aliases: [['~lib',['src/lib']]] }).local).toEqual(['src/lib/b.ts']);
    expect(imp('src/a.ts','typescript',`import b from './lib/b.js'`).local).toEqual(['src/lib/b.ts']);
  });
  it('vue script is treated like js; never includes itself', () => {
    expect(imp('src/a.ts','vue',`import b from './lib/b'; import a from './a'`).local).toEqual(['src/lib/b.ts']);
  });
  it('python', () => {
    expect(imp('app/main.py','python','from pkg import mod\nfrom pkg.sub import x\nimport requests\nfrom . import nothing').local).toEqual(['pkg/__init__.py','pkg/mod.py','pkg/sub/x.py']);
    expect(imp('app/main.py','python','import requests.auth').external).toEqual(['requests']);
    expect(imp('pkg/mod.py','python','from .sub import x').local).toEqual(['pkg/sub/x.py']);
  });
  it('go', () => {
    expect(imp('cmd/main.go','go','import (\n "fmt"\n "shop/internal/db"\n)', { goModule: 'shop' }).local).toEqual(['internal/db/conn.go','internal/db/db.go']);
  });
  it('rust', () => {
    expect(imp('src/lib.rs','rust','mod api;\nuse crate::api::routes;\nuse serde::Serialize;')).toEqual({ local: ['src/api.rs','src/api/routes.rs'], external: ['serde'] });
  });
  it('java', () => {
    expect(imp('src/main/java/com/shop/App.java','java','import com.shop.Order;\nimport java.util.List;')).toEqual({ local: ['src/main/java/com/shop/Order.java'], external: ['java.util'] });
    expect(imp('src/main/java/com/App.java','java','import com.shop.*;\nimport java.util.*;')).toEqual({ local: ['src/main/java/com/shop/Order.java'], external: ['java.util'] });
    expect(imp('src/main/java/com/App.java','java','import static com.shop.Order.*;').local).toEqual(['src/main/java/com/shop/Order.java']);
  });
  it('ruby', () => {
    expect(imp('app.rb','ruby',"require_relative 'lib/util'\nrequire 'json'")).toEqual({ local: ['lib/util.rb'], external: ['json'] });
  });
  it('c', () => {
    expect(imp('src/geo.c','c','#include "../include/geo.h"\n#include <stdio.h>')).toEqual({ local: ['include/geo.h'], external: ['stdio.h'] });
  });
  it('c# and php are external only', () => {
    expect(imp('a.cs','csharp','using System.Linq;\nusing static Foo.Bar;').external).toEqual(['System.Linq','Foo.Bar']);
    expect(imp('a.php','php','use App\\Models\\User;').external).toEqual(['App\\Models\\User']);
  });
});

describe('readTsconfigAliases', () => {
  it('tolerates comments and trailing commas', () => {
    expect(readTsconfigAliases('{ // c\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], }, } }')).toEqual([['@app',['src/app']]]);
  });
  it('applies baseUrl and returns [] on junk', () => {
    expect(readTsconfigAliases('{"compilerOptions":{"baseUrl":"./src","paths":{"~/*":["./x/*"]}}}')).toEqual([['~',['src/x']]]);
    expect(readTsconfigAliases('nope')).toEqual([]);
  });
});

describe('indexing and fixes', () => {
  it('resolves 200 java imports over 25,000 files quickly with one index build', () => {
    const files = Array.from({ length: 25000 }, (_, i) => `src/main/java/com/shop/p${i % 500}/C${i}.java`);
    files.push('src/main/java/com/shop/Order.java');
    const set = new Set(files);
    const ctx: ImportCtx = { has: p => set.has(p), files, aliases: [], goModule: null };
    const src = Array.from({ length: 200 }, (_, i) => `import java.util.L${i};`).join('\n') + '\nimport com.shop.Order;';
    const before = indexStats.builds;
    const t = performance.now();
    const r = extractImports('A.java', 'java', src, ctx);
    const ms = performance.now() - t;
    extractImports('B.java', 'java', src, ctx);
    expect(r.local).toEqual(['src/main/java/com/shop/Order.java']);
    expect(indexStats.builds - before).toBe(1);
    expect(ms).toBeLessThan(200);
  });
  it('rust use of a local mod is local', () => {
    expect(imp('src/lib.rs','rust','mod api;\nuse api::routes;')).toEqual({ local: ['src/api.rs','src/api/routes.rs'], external: [] });
  });
  it('ignores imports in comments', () => {
    expect(imp('src/a.ts','typescript',`// import x from './lib/b'\n/* require('lodash') */\nimport u from 'http://x'; import y from './lib'`))
      .toEqual({ local: ['src/lib/index.ts'], external: [] });
  });
  it('prefers the longest alias prefix', () => {
    expect(imp('src/a.ts','typescript',`import b from '@a/lib/b'`, { aliases: [['@a',['nowhere']],['@a/lib',['src/lib']]] }).local).toEqual(['src/lib/b.ts']);
  });
});
