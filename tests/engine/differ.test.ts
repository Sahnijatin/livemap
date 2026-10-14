import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectModel, type UpdateResult } from '../../src/engine/project.js';
import { buildChange } from '../../src/engine/differ.js';
import type { FileModel } from '../../src/shared/types.js';

let root: string;
let m: ProjectModel;
const put = (rel: string, data: string) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
};
async function change(rel: string, text: string | null, prior?: string): Promise<UpdateResult> {
  if (prior !== undefined) { put(rel, prior); await m.scan(); }
  if (text === null) { fs.rmSync(path.join(root, rel)); return (await m.update(rel, 'unlink'))!; }
  const existed = fs.existsSync(path.join(root, rel));
  put(rel, text);
  return (await m.update(rel, existed ? 'change' : 'add'))!;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-differ-'));
  m = new ProjectModel(root);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const V1 = "export function listOrders(userId: string) {\n  return [];\n}\nfunction old() {}\n";
const V2 = "import { x } from './util';\nimport z from 'zod';\nexport function listOrders(userId: string, status?: string) {\n  return [];\n}\nexport function createOrder() {}\n";

describe('buildChange', () => {
  it('summarizes symbol, signature and import changes', async () => {
    put('src/util.ts', 'export const x = 1;\n');
    const u = await change('src/o.ts', V2, V1);
    const c = buildChange(u, 7, 1234);
    expect(c.id).toBe(7); expect(c.at).toBe(1234); expect(c.kind).toBe('modified'); expect(c.lang).toBe('typescript');
    expect(c.symbols.added.map(s => s.name)).toEqual(['createOrder']);
    expect(c.symbols.removed.map(s => s.name)).toEqual(['old']);
    expect(c.symbols.modified).toMatchObject([{ name: 'listOrders', signatureChanged: true, before: 'export function listOrders(userId: string)' }]);
    expect(c.imports.added).toEqual(['src/util.ts']);
    expect(c.imports.externalAdded).toEqual(['zod']);
    expect(c.lines.added).toBeGreaterThan(0);
    expect(c.hunks.length).toBeGreaterThan(0);
    expect(c.truncated).toBe(false);
  });

  describe('repeated qnames (overloads, property setters)', () => {
    const J1 = 'class Cart {\n  void add(int n) { total += n; }\n}\n';
    const J2 = 'class Cart {\n  void add(int n) { total += n; }\n  void add(String s) { total += s.length(); }\n}\n';
    const J3 = 'class Cart {\n  void add(int n) { total += n; }\n  void add(String s) { total += 2 * s.length(); }\n}\n';
    // The enclosing class (or Python class) hash covers its body, so it is reported modified too; only members are checked here.
    const members = <T extends { kind: string }>(list: T[]) => list.filter(s => s.kind !== 'class');

    it('reports a Java overload added next to an existing one', async () => {
      const c = buildChange(await change('Cart.java', J2, J1), 1);
      expect(c.symbols.added.map(s => s.signature)).toEqual([expect.stringContaining('add(String s)')]);
      expect(members(c.symbols.modified)).toEqual([]);
      expect(c.symbols.removed).toEqual([]);
    });

    it('reports an edit to the second Java overload', async () => {
      const c = buildChange(await change('Cart.java', J3, J2), 1);
      expect(members(c.symbols.modified).map(s => s.signature)).toEqual([expect.stringContaining('add(String s)')]);
      expect(c.symbols.added).toEqual([]);
      expect(c.symbols.removed).toEqual([]);
    });

    it('reports a Java overload removed', async () => {
      const c = buildChange(await change('Cart.java', J1, J2), 1);
      expect(c.symbols.removed.map(s => s.signature)).toEqual([expect.stringContaining('add(String s)')]);
      expect(c.symbols.added).toEqual([]);
      expect(members(c.symbols.modified)).toEqual([]);
    });

    it('reports a removed Python property setter', async () => {
      const P1 = 'class T:\n    @property\n    def x(self):\n        return self._x\n\n    @x.setter\n    def x(self, v):\n        self._x = v\n';
      const P2 = 'class T:\n    @property\n    def x(self):\n        return self._x\n';
      const c = buildChange(await change('t.py', P2, P1), 1);
      expect(c.symbols.removed.map(s => s.qname)).toEqual(['T.x']);
      expect(c.symbols.added).toEqual([]);
      expect(members(c.symbols.modified)).toEqual([]);
    });
  });

  it('body-only change is not a signature change', async () => {
    const u = await change('a.ts', 'export function f() {\n  return 2;\n}\n', 'export function f() {\n  return 1;\n}\n');
    const c = buildChange(u, 1);
    expect(c.symbols.modified[0].signatureChanged).toBe(false);
    expect(c.symbols.added).toEqual([]);
  });

  it('created and deleted files', async () => {
    const src = 'export function a() {}\nexport function b() {}\n';
    const c = buildChange(await change('n.ts', src), 1);
    expect(c.kind).toBe('created');
    expect(c.symbols.added.map(s => s.name)).toEqual(['a', 'b']);
    expect(c.lines).toEqual({ added: 2, removed: 0 });
    const d = buildChange(await change('n.ts', null), 2);
    expect(d.kind).toBe('deleted');
    expect(d.symbols.removed.map(s => s.name)).toEqual(['a', 'b']);
    expect(d.lines).toEqual({ added: 0, removed: 2 });
  });

  it('truncates hunks at 800 lines but counts all', async () => {
    const big = Array.from({ length: 2000 }, (_, i) => `// line ${i}`).join('\n') + '\n';
    const c = buildChange(await change('big.ts', big, 'const a = 1;\n'), 1);
    expect(c.lines.added).toBe(2000);
    expect(c.hunks.flatMap(h => h.lines).length).toBe(800);
    expect(c.truncated).toBe(true);
  });

  it('no spurious no-newline markers', async () => {
    const c = buildChange(await change('x.ts', 'const a = 2;', 'const a = 1;'), 1);
    expect(c.hunks.flatMap(h => h.lines).some(l => l.startsWith('\\'))).toBe(false);
  });

  it('secret env files report only key names', async () => {
    const u = await change('.env', 'A=1\nNEW_KEY=1\n', 'A=1\n');
    const c = buildChange(u, 1);
    expect(c.env.added).toEqual(['NEW_KEY']);
    expect(c.hunks).toEqual([]);
    expect(c.lines).toEqual({ added: 1, removed: 0 });
    expect(JSON.stringify(c)).not.toContain('=1');
  });

  it('a field that only moved to another line is not changed', () => {
    const base: FileModel = { path: 's.prisma', lang: 'prisma', size: 0, lines: 0, symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {} };
    const ent = (offset: number) => ({ name: 'User', table: 'users', orm: 'prisma', file: 's.prisma', line: 1, fields: [{ name: 'id', type: 'Int', line: 2 + offset }, { name: 'email', type: 'String', line: 3 + offset }] });
    const c = buildChange({ path: 's.prisma', kind: 'modified', before: { ...base, entities: [ent(0)] }, after: { ...base, entities: [ent(1)] }, beforeText: '', afterText: '', touched: [] }, 1);
    expect(c.entities.changed).toEqual([]);
  });

  it('diffs routes, entities, deps', () => {
    const base: FileModel = { path: 'r.ts', lang: 'typescript', size: 0, lines: 0, symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {} };
    const ent = (fields: string[]) => ({ name: 'User', table: 'users', orm: 'prisma', file: 'r.ts', line: 1, fields: fields.map(n => ({ name: n, type: 'String' })) });
    const before: FileModel = { ...base, entities: [ent(['id', 'old'])], deps: { deps: [{ name: 'a', version: '1', eco: 'npm' }, { name: 'gone', version: '1', eco: 'npm' }] } };
    const after: FileModel = { ...base, routes: [{ method: 'GET', path: '/x', line: 3, kind: 'api', framework: 'express' }], entities: [{ ...ent(['id', 'email']), fields: [{ name: 'id', type: 'Int' }, { name: 'email', type: 'String' }] }, { ...ent([]), name: 'Post' }], deps: { deps: [{ name: 'a', version: '2', eco: 'npm' }, { name: 'b', version: '1', eco: 'npm' }] } };
    const c = buildChange({ path: 'r.ts', kind: 'modified', before, after, beforeText: '', afterText: '', touched: [] }, 1);
    expect(c.routes.added).toEqual([{ method: 'GET', path: '/x', line: 3, kind: 'api', framework: 'express' }]);
    expect(c.entities.added).toEqual([{ name: 'Post', fields: 0, orm: 'prisma' }]);
    expect(c.entities.changed).toEqual([{ name: 'User', addedFields: ['email'], removedFields: ['old'], changedFields: ['id'] }]);
    expect(c.deps!.added.map(d => d.name)).toEqual(['b']);
    expect(c.deps!.removed.map(d => d.name)).toEqual(['gone']);
    expect(c.deps!.changed).toMatchObject([{ name: 'a', version: '2', from: '1' }]);
  });

  it('reports an ALTER fragment as a table change, not a new table (R5)', () => {
    const base: FileModel = { path: 'db/002.sql', lang: 'sql', size: 0, lines: 0, symbols: [], imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {} };
    const alter = { name: 'orders', table: 'orders', orm: 'sql', file: 'db/002.sql', line: 1, partial: true as const, fields: [{ name: 'status', type: 'TEXT' }, { name: 'paid_at', type: 'TIMESTAMP' }] };
    const added = buildChange({ path: 'db/002.sql', kind: 'created', before: null, after: { ...base, entities: [alter] }, beforeText: null, afterText: '', touched: [] }, 1);
    expect(added.entities).toEqual({ added: [], removed: [], changed: [{ name: 'orders', addedFields: ['status', 'paid_at'], removedFields: [], changedFields: [] }] });
    const removed = buildChange({ path: 'db/002.sql', kind: 'deleted', before: { ...base, entities: [alter] }, after: null, beforeText: '', afterText: null, touched: [] }, 2);
    expect(removed.entities).toEqual({ added: [], removed: [], changed: [{ name: 'orders', addedFields: [], removedFields: ['status', 'paid_at'], changedFields: [] }] });
  });
});
