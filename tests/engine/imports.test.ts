import { describe, it, expect } from 'vitest';
import type { Lang } from '../../src/shared/types.js';
import { extractImports, readTsconfigAliases, indexStats, resolveSpecifier, type ImportCtx } from '../../src/engine/imports.js';

const FILES = ['src/main/java/com/shop.java','src/a.ts','src/lib/b.ts','src/lib/index.ts','src/ui/c.tsx','pkg/__init__.py','pkg/mod.py','pkg/sub/x.py','app/main.py','internal/db/db.go','internal/db/conn.go','src/lib.rs','src/api.rs','src/api/routes.rs','src/main/java/com/shop/Order.java','lib/util.rb','include/geo.h'];
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
  it('python resolves absolute modules from each ancestor of a nested project, nearest first', () => {
    const files = ['backend/app/__init__.py','backend/app/main.py','backend/app/models.py','backend/app/api/__init__.py','backend/app/api/users.py','app/models.py'];
    const has = new Set(files);
    const py = (path: string, src: string) => extractImports(path, 'python', src, { has: p => has.has(p), files, aliases: [], goModule: null });
    expect(py('backend/app/main.py', 'from app.models import User\nimport app.api.users\nfrom app.api import users\nimport fastapi'))
      .toEqual({ local: ['backend/app/api/__init__.py', 'backend/app/api/users.py', 'backend/app/models.py'], external: ['fastapi'] });
    expect(py('backend/app/api/users.py', 'from app import models').local).toEqual(['backend/app/__init__.py', 'backend/app/models.py']);
    // A root-level project still resolves from the root.
    expect(py('main.py', 'from app.models import User').local).toEqual(['app/models.py']);
  });
  it('python does not let a local file shadow the standard library, nor resolve from inside a package', () => {
    const files = ['app/views.py', 'app/logging.py', 'app/util.py', 'svc/app/__init__.py', 'svc/app/views.py', 'svc/app/helpers.py', 'svc/helpers.py'];
    const has = new Set(files);
    const ctx: ImportCtx = { has: p => has.has(p), files, aliases: [], goModule: null };
    expect(extractImports('app/views.py', 'python', 'import logging\nfrom logging import handlers\nimport util', ctx))
      .toEqual({ local: ['app/util.py'], external: ['logging'] });
    expect(resolveSpecifier('app/views.py', 'python', 'logging', ctx)).toBeNull();
    // svc/app is a package, so its own directory is not on the import path; its parent svc/ is.
    expect(extractImports('svc/app/views.py', 'python', 'import helpers', ctx).local).toEqual(['svc/helpers.py']);
    expect(resolveSpecifier('svc/app/views.py', 'python', 'helpers', ctx)).toBe('svc/helpers.py');
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
    // A wildcard resolves only to the class it names (its nested classes), never to a shorter prefix.
    expect(imp('src/main/java/com/App.java','java','import com.shop.Order.*;').local).toEqual(['src/main/java/com/shop/Order.java']);
    expect(imp('src/main/java/com/App.java','java','import static com.shop.Order.Inner.*;').local).toEqual(['src/main/java/com/shop/Order.java']);
    // Only class-like (capitalized) segments count, so a lowercase package never matches a stray file.
    expect(imp('src/main/java/com/App.java','java','import shop.Order.lib.*;').local).toEqual(['src/main/java/com/shop/Order.java']);
    expect(imp('src/main/java/com/App.java','java','import com.shop.util.*;')).toEqual({ local: [], external: ['com.shop.util'] });
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
    expect(readTsconfigAliases('{ // c\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], }, } }')).toEqual([['@app',['src/app']],['*',['']]]);
  });
  it('applies baseUrl and returns [] on junk', () => {
    expect(readTsconfigAliases('{"compilerOptions":{"baseUrl":"./src","paths":{"~/*":["./x/*"]}}}')).toEqual([['~',['src/x']],['*',['src']]]);
    expect(readTsconfigAliases('{"compilerOptions":{"paths":{"~/*":["./x/*"]}}}')).toEqual([['~',['x']]]);
    expect(readTsconfigAliases('{"compilerOptions":{}}')).toEqual([]);
    expect(readTsconfigAliases('nope')).toEqual([]);
  });
  it('turns baseUrl alone and a "*" path into one wildcard entry, paths first', () => {
    expect(readTsconfigAliases('{"compilerOptions":{"baseUrl":"src"}}')).toEqual([['*',['src']]]);
    expect(readTsconfigAliases('{"compilerOptions":{"paths":{"*":["src/*","types/*"]}}}')).toEqual([['*',['src','types']]]);
    expect(readTsconfigAliases('{"compilerOptions":{"baseUrl":".","paths":{"*":["src/*"]}}}')).toEqual([['*',['src','']]]);
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
  it('re-resolving unchanged JS text reuses its cached specifiers but sees the new file set', () => {
    const specCache: NonNullable<ImportCtx['specCache']> = new Map();
    const src = "import b from './lib/b'; import n from './lib/new';";
    const before = indexStats.jsParses;
    expect(imp('src/a.ts', 'typescript', src, { specCache }).local).toEqual(['src/lib/b.ts']);
    const files = [...FILES, 'src/lib/new.ts'];
    const more = new Set(files);
    expect(extractImports('src/a.ts', 'typescript', src, { has: p => more.has(p), files, aliases: [], goModule: null, specCache }).local)
      .toEqual(['src/lib/b.ts', 'src/lib/new.ts']);
    expect(indexStats.jsParses - before).toBe(1);
  });
  it('keeps only the latest text per file in the specifier cache, and caches nothing without one', () => {
    const specCache: NonNullable<ImportCtx['specCache']> = new Map();
    const v1 = "import b from './lib/b'; // v1";
    const v2 = "import b from './lib/b'; // v2";
    let before = indexStats.jsParses;
    for (const v of [v1, v2, v1, v1]) imp('src/cache.ts', 'typescript', v, { specCache });
    expect(indexStats.jsParses - before).toBe(3);
    expect(specCache.size).toBe(1);
    before = indexStats.jsParses;
    imp('src/cache.ts', 'typescript', v1);
    imp('src/cache.ts', 'typescript', v1);
    expect(indexStats.jsParses - before).toBe(2);
  });
  it('resolves bare specifiers against baseUrl and a "*" path only when the file exists', () => {
    for (const json of ['{"compilerOptions":{"baseUrl":"src"}}', '{"compilerOptions":{"paths":{"*":["src/*"]}}}']) {
      const aliases = readTsconfigAliases(json);
      expect(imp('src/ui/c.tsx', 'typescript', "import u from 'a'; import b from 'lib/b'; import l from 'lib'; import r from 'react'; import d from '@scope/x/deep'", { aliases }))
        .toEqual({ local: ['src/a.ts', 'src/lib/b.ts', 'src/lib/index.ts'], external: ['react', '@scope/x'] });
    }
    // Explicit paths still win over the wildcard.
    const aliases = readTsconfigAliases('{"compilerOptions":{"baseUrl":".","paths":{"lib/*":["src/lib/*"]}}}');
    expect(imp('src/a.ts', 'typescript', "import b from 'lib/b'; import p from 'pkg/mod'", { aliases })).toEqual({ local: ['src/lib/b.ts'], external: ['pkg'] });
  });
  it('ignores import-like text inside strings and templates but keeps real specifiers', () => {
    const src = "const s = \"import x from 'lodash'\";\nconst t = `export * from 'chalk'; require('fs-extra')`;\nconst q = 'import(\"zod\")';\n"
      + "import y from './lib'; export { b } from \"./lib/b\";\nconst r = require('react'); const m = await import('./ui/c');\nconst esc = 'it\\'s import a from \"vue\"';\n";
    expect(imp('src/a.ts', 'typescript', src)).toEqual({ local: ['src/lib/b.ts', 'src/lib/index.ts', 'src/ui/c.tsx'], external: ['react'] });
    expect(imp('src/a.ts', 'typescript', "import a from 'react' // import b from 'vue'\n/* 'x' */ import c from \"preact\"")).toEqual({ local: [], external: ['react', 'preact'] });
  });
  it('keeps imports after a stray quote that opens no real string', () => {
    const after = "\nimport y from './lib';\nimport {\n  b,\n} from './lib/b';\nexport * from 'vue';\n";
    const want = { local: ['src/lib/b.ts', 'src/lib/index.ts'], external: ['vue'] };
    expect(imp('src/a.ts', 'typescript', "const re = /`/; const q = /[/'\"]/g; const half = a / 2 / b;" + after)).toEqual(want);
    expect(imp('src/a.tsx', 'tsx', 'const P = () => <p>Don`t</p>;' + after)).toEqual(want);
    expect(imp('src/a.tsx', 'tsx', "const P = () => <p>Don't</p>;" + after)).toEqual(want);
    // A regex body is not code, and a template still hides import-like text that does not start a line.
    expect(imp('src/a.ts', 'typescript', "const r = /import x from 'lodash'/;\nconst t = `a\n  b; import z from 'chalk'`;" + after)).toEqual(want);
  });
  it('prefers the longest alias prefix', () => {
    expect(imp('src/a.ts','typescript',`import b from '@a/lib/b'`, { aliases: [['@a',['nowhere']],['@a/lib',['src/lib']]] }).local).toEqual(['src/lib/b.ts']);
  });
});
