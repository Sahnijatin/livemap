import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { schemaMobile } from '../../../src/engine/domain/schema-mobile.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/schema/', import.meta.url));
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [schemaMobile]).entities;
const names = (rel: string, text: string): string[] => run(rel, text).map(e => e.name);
const ROOM = 'import androidx.room.Entity\n';
const SWIFT = 'import SwiftData\n';

describe('schema-mobile analyzer', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const orm of ['room', 'swiftdata']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, orm, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${orm}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, orm, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to Kotlin, Java and Swift', () => {
    expect(ANALYZERS).toContain(schemaMobile);
    for (const [rel, lang] of [['a/B.kt', 'kotlin'], ['a/B.java', 'java'], ['M.swift', 'swift']] as const) expect(schemaMobile.applies(rel, lang)).toBe(true);
    expect(schemaMobile.applies('app/models.py', 'python')).toBe(false);
    expect(schemaMobile.applies('src/a.ts', 'typescript')).toBe(false);
  });
  it('skips unterminated Kotlin, Java and Swift entities', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(run('A.kt', ROOM + '@Entity\ndata class A(\n    @PrimaryKey val id: Long,\n')).toEqual([]);
    expect(run('B.kt', ROOM + '@Entity\nclass B {\n    @PrimaryKey var id: Long = 0\n')).toEqual([]);
    expect(run('C.kt', ROOM + '@Entity(tableName = "c"\ndata class C(val id: Long)\n')).toEqual([]);
    expect(run('D.java', ROOM + '@Entity\npublic class D {\n    public long id;\n')).toEqual([]);
    expect(run('E.swift', SWIFT + '@Model\nfinal class E {\n    var id: UUID\n')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps one entity per lowercased name in a file, the later one winning', () => {
    const kt = ROOM + '@Entity(tableName = "x1") data class X(val id: Long)\n@Entity(tableName = "x2") data class X(val id: Long)\n';
    expect(run('X.kt', kt).map(e => e.table)).toEqual(['x2']);
  });

  it('reads Room entities only with a Room import, and SwiftData models only with a SwiftData import', () => {
    expect(names('A.kt', '@Entity\ndata class A(@PrimaryKey val id: Long)\n')).toEqual([]);
    expect(names('A.java', 'import javax.persistence.Entity;\n@Entity\npublic class A { public long id; }\n')).toEqual([]);
    expect(names('A.swift', '@Model\nfinal class A {\n    var id: UUID\n}\n')).toEqual([]);
    expect(names('A.swift', SWIFT + '@Model\nfinal class A {\n    var id: UUID\n}\n')).toEqual(['A']);
  });

  it('ignores schema code inside strings and comments', () => {
    expect(run('A.kt', ROOM + '// @Entity data class A(val id: Long)\nval s = "@Entity data class B(val id: Long)"\n')).toEqual([]);
    expect(run('A.swift', SWIFT + '/* @Model class A { var x: Int } */\nlet s = "@Model class B { var y: Int }"\n')).toEqual([]);
  });

  it('reads a SwiftData property of a non-value type as a relation, even from another file', () => {
    const src = SWIFT + '@Model\nfinal class A {\n    var owner: Owner?\n    var status: Status\n    var counts: [String: Int]\n    var tags: [String]\n}\n';
    expect(run('A.swift', src)[0].fields).toEqual([
      { name: 'owner', type: 'Owner', line: 4, relation: { model: 'Owner', many: false } },
      { name: 'status', type: 'Status', line: 5, relation: { model: 'Status', many: false } },
      { name: 'counts', type: '[String: Int]', line: 6, required: true },
      { name: 'tags', type: '[String]', line: 7, required: true },
    ]);
  });

  it('skips a Kotlin property whose getter is on the next line', () => {
    const src = ROOM + '@Entity\ndata class A(@PrimaryKey val id: Long) {\n    val label: String\n        get() = "x"\n    var n: Int = 0\n}\n';
    expect(run('A.kt', src)[0].fields.map(f => f.name)).toEqual(['id', 'n']);
  });

  it('reads Swift Array<T>, Set<T> and Optional<T> like [T] and T?', () => {
    const src = SWIFT + '@Model\nfinal class A {\n    var items: Array<Item>\n    var tags: Set<Tag>\n    var owner: Optional<Owner>\n    var names: Array<String>\n    var nick: Optional<String>\n}\n';
    expect(run('A.swift', src)[0].fields).toEqual([
      { name: 'items', type: 'Array<Item>', line: 4, relation: { model: 'Item', many: true } },
      { name: 'tags', type: 'Set<Tag>', line: 5, relation: { model: 'Tag', many: true } },
      { name: 'owner', type: 'Optional<Owner>', line: 6, relation: { model: 'Owner', many: false } },
      { name: 'names', type: 'Array<String>', line: 7, required: true },
      { name: 'nick', type: 'Optional<String>', line: 8 },
    ]);
  });

  it('keeps a Kotlin property with an initializer and a getter on the next line', () => {
    const src = ROOM + '@Entity\ndata class A(@PrimaryKey val id: Long) {\n    var total: Double = 0.0\n        get() = field\n}\n';
    expect(run('A.kt', src)[0].fields.map(f => f.name)).toEqual(['id', 'total']);
  });

  it('stays linear on ~1 MB of hostile input', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cases: [string, string][] = [
      ['A.kt', ROOM + '@Entity('.repeat(120000)],
      ['A.kt', ROOM + '@Entity data class A('.repeat(40000)],
      ['A.kt', ROOM + '@Entity class A {' + '@PrimaryKey '.repeat(80000) + '}'],
      ['A.kt', ROOM + '@Entity(' + '('.repeat(450000) + ')'.repeat(450001) + ' data class A(val a: Long)'],
      ['A.kt', ROOM + '@Entity('.repeat(60000) + ')'.repeat(60000) + ' class A'],
      ['A.kt', ROOM + '@Entity(foreignKeys = [' + 'ForeignKey(entity = A::class, parentColumns = ["id"], childColumns = ["a"]),'.repeat(12000) + ']) data class A(val a: Long)'],
      ['A.java', ROOM + '@Entity public class A {' + 'public long x;\n'.repeat(60000) + '}'],
      ['A.swift', SWIFT + '@Model class A {' + 'var x: [A] = []\n'.repeat(60000) + '}'],
      ['A.swift', SWIFT + '@Model '.repeat(140000)],
      ['A.swift', SWIFT + '@Model class A {' + ' '.repeat(1_000_000) + '}'],
    ];
    for (const [rel, t] of cases) {
      const start = performance.now();
      run(rel, t);
      expect(performance.now() - start, `${rel} ${t.slice(0, 24)}`).toBeLessThan(1000);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
