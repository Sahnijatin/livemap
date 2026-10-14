import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractSymbols, flattenSymbols } from '../../src/engine/symbols/index.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url)), 'utf8');

describe('JS/TS symbols', () => {
  it('extracts TypeScript structure', async () => {
    const s = flattenSymbols((await extractSymbols('typescript', read('js/service.ts'))).symbols);
    const by = (n: string) => s.find(x => x.name === n)!;
    expect(by('createOrder')).toMatchObject({ kind: 'function', exported: true, signature: 'export async function createOrder(input: OrderInput): Promise<Order>' });
    expect(by('listOrders')).toMatchObject({ kind: 'function', exported: true, signature: 'async listOrders(userId: string, status?: Status)' });
    expect(by('helper').exported).toBe(false);
    expect(by('OrderService').kind).toBe('class');
    expect(by('find')).toMatchObject({ kind: 'method', qname: 'OrderService.find' });
    expect(by('handle')).toMatchObject({ kind: 'method', qname: 'OrderService.handle' });
    expect(s.find(x => x.name === 'cache')).toBeUndefined();
    expect([by('OrderInput').kind, by('Status').kind, by('Color').kind]).toEqual(['interface', 'type', 'enum']);
    expect(by('router').kind).toBe('variable');
    expect(by('createOrder').line).toBe(1);
    expect(by('createOrder').hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('extracts TSX components and hooks', async () => {
    const t = flattenSymbols((await extractSymbols('tsx', read('js/Page.tsx'))).symbols);
    expect(t.map(x => [x.name, x.kind])).toEqual([['OrdersPage', 'component'], ['StatusBadge', 'component'], ['useOrders', 'hook'], ['Memo', 'component']]);
  });

  for (const lang of ['javascript', 'typescript'] as const) {
    it(`${lang}: function-valued class fields are methods`, async () => {
      const src = 'class A {\n  run = () => 1;\n  go = async function (x) { return x; };\n  n = 3;\n  m() {}\n}\n';
      const [a] = (await extractSymbols(lang, src)).symbols;
      expect(a.children.map(c => [c.qname, c.kind])).toEqual([['A.run', 'method'], ['A.go', 'method'], ['A.m', 'method']]);
      expect(a.children[0].signature).toBe('run()');
    });

    it(`${lang}: export clauses and default identifiers mark targets exported`, async () => {
      const src = 'function a() {}\nconst b = 1;\nfunction hidden() {}\nclass D {}\nfunction c() {}\nexport { a, b as bee };\nexport default D;\n';
      const syms = (await extractSymbols(lang, src)).symbols;
      expect(syms.map(x => [x.name, x.exported])).toEqual([['a', true], ['b', true], ['hidden', false], ['D', true], ['c', false]]);
    });
  }

  it('returns ok:false without a grammar', async () => {
    expect((await extractSymbols('markdown', '# x')).ok).toBe(false);
  });

  it('returns ok:false on parse errors but keeps recovered symbols', async () => {
    const r = await extractSymbols('typescript', 'export function hello( {');
    expect(r.ok).toBe(false);
  });
});
