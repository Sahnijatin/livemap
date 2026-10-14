import { describe, it, expect } from 'vitest';
import { buildUsedBy, usedByStats } from '../../src/engine/usedby.js';
import type { CodeSymbol, FileModel } from '../../src/shared/types.js';

function sym(name: string, exported: boolean): CodeSymbol {
  return { name, qname: name, kind: 'function', signature: name, line: 1, endLine: 1, exported, hash: name, children: [] };
}
function file(path: string, symbols: CodeSymbol[], local: string[] = []): FileModel {
  return { path, lang: 'typescript', size: 0, lines: 1, symbols, imports: { local, external: [] }, routes: [], entities: [], env: [], flags: {} };
}

describe('buildUsedBy', () => {
  it('lists importers that mention exported symbols as whole words', () => {
    const files = [
      file('src/b.ts', [sym('hello', true), sym('unused', true), sym('internal', false)]),
      file('src/z.ts', [], ['src/b.ts']),
      file('src/a.ts', [], ['src/b.ts']),
      file('src/n.ts', []),
    ];
    const text: Record<string, string> = {
      'src/a.ts': "import { hello } from './b';\nhello();\ninternal;",
      'src/z.ts': "import { hello } from './b';\nconsole.log(hello);",
      'src/n.ts': 'hello(); unused;',
      'src/b.ts': 'export function hello() {}',
    };
    const out = buildUsedBy(files, p => text[p] ?? null);
    expect(out).toEqual([{ file: 'src/b.ts', symbol: 'hello', usedIn: ['src/a.ts', 'src/z.ts'] }]);
  });

  it('requires whole-word matches and handles $ names and missing content', () => {
    const files = [
      file('lib.ts', [sym('get', true), sym('$store', true)]),
      file('use.ts', [], ['lib.ts']),
      file('gone.ts', [], ['lib.ts']),
    ];
    const text: Record<string, string> = { 'use.ts': 'getter(); $store.x;' };
    expect(buildUsedBy(files, p => text[p] ?? null)).toEqual([{ file: 'lib.ts', symbol: '$store', usedIn: ['use.ts'] }]);
  });

  it('rebuilding rescans only importer texts that changed', () => {
    const files = [file('lib.ts', [sym('alpha', true), sym('beta', true)]), file('u1.ts', [], ['lib.ts']), file('u2.ts', [], ['lib.ts'])];
    const tag = Math.random();
    const text: Record<string, string> = { 'u1.ts': `alpha(); // ${tag}`, 'u2.ts': `beta(); // ${tag}` };
    const before = usedByStats.scans;
    buildUsedBy(files, p => text[p] ?? null);
    expect(usedByStats.scans - before).toBe(2);
    text['u2.ts'] = `alpha(); beta(); // ${tag}`;
    expect(buildUsedBy(files, p => text[p] ?? null)).toEqual([
      { file: 'lib.ts', symbol: 'alpha', usedIn: ['u1.ts', 'u2.ts'] },
      { file: 'lib.ts', symbol: 'beta', usedIn: ['u2.ts'] },
    ]);
    expect(usedByStats.scans - before).toBe(3);
  });

  it('still matches names that are not plain identifiers', () => {
    const files = [file('ops.h', [sym('operator+', true)]), file('use.cc', [], ['ops.h'])];
    expect(buildUsedBy(files, () => 'a operator+ b')).toEqual([{ file: 'ops.h', symbol: 'operator+', usedIn: ['use.cc'] }]);
  });
});
