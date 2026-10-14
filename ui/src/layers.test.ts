import { describe, it, expect } from 'vitest';
import { layerOf } from './layers';
import { changedLines, symbolTags } from './changes';
import { file, sym, change } from './fixtures';

const L = (p: string, lang: Parameters<typeof file>[2] = {}) => layerOf(p, file(p, [], lang));

describe('layerOf', () => {
  it('classifies the brief examples', () => {
    expect(L('src/web/components/OrderTable.tsx')).toBe('ui');
    expect(L('src/server/routes/orders.ts')).toBe('api');
    expect(L('prisma/schema.prisma', { lang: 'prisma' })).toBe('data');
    expect(L('src/server/services/orderService.ts')).toBe('logic');
    expect(L('src/lib/validation.ts')).toBe('val');
    expect(L('tests/a.test.ts')).toBe('test');
    expect(L('README.md', { lang: 'markdown' })).toBe('docs');
  });

  it('handles config, data by extension, test files outside test folders, and the core fallback', () => {
    expect(L('package.json', { lang: 'json' })).toBe('config');
    expect(L('vite.config.ts')).toBe('config');
    expect(L('db/001_init.sql', { lang: 'sql' })).toBe('data');
    expect(L('src/models/user.ts')).toBe('data');
    expect(L('src/web/Button.spec.tsx')).toBe('test');
    expect(L('src/lib/logic/price.ts')).toBe('logic');
    expect(L('src/server/index.ts')).toBe('core');
    expect(L('app/api/users/route.ts')).toBe('api');
  });
});

describe('changedLines', () => {
  it('maps + lines to new-file line numbers across hunks', () => {
    const c = change('a.ts', 'modified', {
      hunks: [
        { oldStart: 1, newStart: 1, lines: [' a', '-b', '+B', '+B2', ' c'] },
        { oldStart: 20, newStart: 21, lines: [' x', '+y', '\\ No newline at end of file'] },
      ],
    });
    expect([...changedLines(c)].sort((a, b) => a - b)).toEqual([2, 3, 22]);
  });
});

describe('symbolTags', () => {
  it('tags a modified method CHANGED and leaves its containing class untagged', () => {
    const method = sym('save', 'method', 3, [], 'Repo.save');
    const repo = sym('Repo', 'class', 1, [method]);
    const helper = sym('helper', 'function', 10);
    const util = sym('Util', 'class', 20, [sym('run', 'method', 21, [], 'Util.run')]);
    const f = file('a.ts', [repo, helper, util]);
    const ref = (s: ReturnType<typeof sym>) => ({ name: s.name, qname: s.qname, kind: s.kind, signature: s.signature, line: s.line });
    const c = change('a.ts', 'modified', {
      symbols: {
        added: [ref(helper)], removed: [],
        modified: [{ ...ref(repo), signatureChanged: false }, { ...ref(method), signatureChanged: false }, { ...ref(util), signatureChanged: false }],
      },
    });
    const tags = symbolTags(f, c);
    expect(tags.get('Repo.save')).toBe('changed');
    expect(tags.get('Repo')).toBeUndefined();
    expect(tags.get('helper')).toBe('new');
    expect(tags.get('Util')).toBe('changed');
    expect(symbolTags(f, undefined).size).toBe(0);
  });
});
