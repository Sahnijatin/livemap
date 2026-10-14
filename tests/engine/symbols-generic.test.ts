import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Lang } from '../../src/shared/types.js';
import { extractSymbols, flattenSymbols } from '../../src/engine/symbols/index.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url)), 'utf8');
const triples = async (lang: Lang, file: string) => {
  const r = await extractSymbols(lang, read(file));
  return { ok: r.ok, flat: flattenSymbols(r.symbols), tree: r.symbols };
};
const t = (s: { name: string; kind: string; qname: string }[]) => s.map(x => [x.name, x.kind, x.qname]);

describe('generic symbols', () => {
  it('python', async () => {
    const { ok, flat } = await triples('python', 'python/app.py');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['list_orders', 'function', 'list_orders'],
      ['OrderService', 'class', 'OrderService'],
      ['__init__', 'method', 'OrderService.__init__'],
      ['find', 'method', 'OrderService.find'],
    ]);
    expect(flat[0].signature).toBe('async def list_orders(user_id: str, status: str | None = None)');
    expect(flat[0].exported).toBe(true);
    expect(flat[0].hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('go', async () => {
    const { ok, flat } = await triples('go', 'go/main.go');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['Start', 'function', 'Start'],
      ['Handle', 'method', 'Server.Handle'],
      ['Server', 'struct', 'Server'],
      ['Store', 'interface', 'Store'],
    ]);
    expect(flat[0].signature).toBe('func Start(port int) error');
  });

  it('rust', async () => {
    const { ok, flat } = await triples('rust', 'rust/lib.rs');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['start', 'function', 'start'],
      ['Order', 'struct', 'Order'],
      ['Status', 'enum', 'Status'],
      ['Repo', 'trait', 'Repo'],
      ['Repo for Db', 'impl', 'Repo for Db'],
      ['find', 'method', 'Repo for Db.find'],
      ['api', 'module', 'api'],
    ]);
    expect(flat[0].exported).toBe(true);
    expect(flat[1].exported).toBe(false);
  });

  it('java', async () => {
    const { ok, flat } = await triples('java', 'java/OrderController.java');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['OrderController', 'class', 'OrderController'],
      ['list', 'method', 'OrderController.list'],
      ['OrderController', 'method', 'OrderController.OrderController'],
      ['Repo', 'interface', 'Repo'],
      ['Status', 'enum', 'Status'],
    ]);
  });

  it('kotlin', async () => {
    const { ok, flat } = await triples('kotlin', 'kotlin/a.kt');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['A', 'class', 'A'],
      ['b', 'method', 'A.b'],
      ['top', 'function', 'top'],
      ['O', 'class', 'O'],
    ]);
    expect(flat[1].signature).toBe('fun b(x: Int): Int');
  });

  it('csharp', async () => {
    const { ok, flat } = await triples('csharp', 'csharp/Cart.cs');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['Shop', 'namespace', 'Shop'],
      ['Cart', 'class', 'Shop.Cart'],
      ['Add', 'method', 'Shop.Cart.Add'],
      ['IRepo', 'interface', 'Shop.IRepo'],
    ]);
  });

  it('php', async () => {
    const { ok, flat } = await triples('php', 'php/cart.php');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['Cart', 'class', 'Cart'],
      ['add', 'method', 'Cart.add'],
      ['top', 'function', 'top'],
    ]);
  });

  it('ruby', async () => {
    const { ok, flat } = await triples('ruby', 'ruby/cart.rb');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['Cart', 'class', 'Cart'],
      ['add', 'method', 'Cart.add'],
      ['Billing', 'module', 'Billing'],
    ]);
  });

  it('swift', async () => {
    const { ok, flat } = await triples('swift', 'swift/a.swift');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['A', 'class', 'A'],
      ['b', 'method', 'A.b'],
      ['S', 'struct', 'S'],
      ['P', 'interface', 'P'],
      ['q', 'method', 'P.q'],
      ['top', 'function', 'top'],
    ]);
  });

  it('c', async () => {
    const { ok, flat } = await triples('c', 'c/a.c');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['add', 'function', 'add'],
      ['Point', 'struct', 'Point'],
    ]);
    expect(flat[0].signature).toBe('int add(int a, int b)');
  });

  it('cpp', async () => {
    const { ok, flat } = await triples('cpp', 'cpp/a.cpp');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['add', 'function', 'add'],
      ['Point', 'struct', 'Point'],
      ['geo', 'namespace', 'geo'],
      ['Shape', 'class', 'geo.Shape'],
    ]);
  });

  it('dart', async () => {
    const { ok, flat } = await triples('dart', 'dart/a.dart');
    expect(ok).toBe(true);
    expect(t(flat)).toEqual([
      ['Cart', 'class', 'Cart'],
      ['add', 'method', 'Cart.add'],
      ['main', 'function', 'main'],
    ]);
  });

  it('java enum methods', async () => {
    const r = await extractSymbols('java', 'enum E { X; void m() {} }\n');
    expect(t(flattenSymbols(r.symbols))).toEqual([['E', 'enum', 'E'], ['m', 'method', 'E.m']]);
  });

  it('php braced namespace members', async () => {
    const r = await extractSymbols('php', '<?php\nnamespace App { class Cart { public function add() {} } function top() {} }\n');
    expect(t(flattenSymbols(r.symbols))).toEqual([
      ['App', 'namespace', 'App'], ['Cart', 'class', 'App.Cart'], ['add', 'method', 'App.Cart.add'], ['top', 'function', 'App.top'],
    ]);
  });

  it('nests children under their container', async () => {
    const { tree } = await triples('python', 'python/app.py');
    expect(tree.map(s => s.name)).toEqual(['list_orders', 'OrderService']);
    expect(tree[1].children.map(s => s.name)).toEqual(['__init__', 'find']);
  });
});
