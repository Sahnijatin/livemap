import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { schemaSql } from '../../../src/engine/domain/schema-sql.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/schema/', import.meta.url));
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [schemaSql]).entities;
const names = (rel: string, text: string): string[] => run(rel, text).map(e => e.table);

describe('schema-sql analyzer', () => {
  afterEach(() => vi.restoreAllMocks());

  const golden = JSON.parse(fs.readFileSync(path.join(DIR, 'sql', 'expected.json'), 'utf8')) as Record<string, unknown>;
  for (const [rel, want] of Object.entries(golden)) {
    it(`sql: ${rel} matches the golden`, () => {
      expect(run(rel, fs.readFileSync(path.join(DIR, 'sql', rel), 'utf8'))).toEqual(want);
    });
  }

  it('is registered and gated to SQL files and host-language migrations', () => {
    expect(ANALYZERS).toContain(schemaSql);
    expect(schemaSql.applies('db/schema.sql', 'sql')).toBe(true);
    expect(schemaSql.applies('db/Migrations/001.ts', 'typescript')).toBe(true);
    expect(schemaSql.applies('alembic/versions/migration_1.py', 'python')).toBe(true);
    expect(schemaSql.applies('db/migrations/001.go', 'go')).toBe(true);
    expect(schemaSql.applies('src/migrate.js', 'javascript')).toBe(false);
    expect(schemaSql.applies('src/db.ts', 'typescript')).toBe(false);
    expect(schemaSql.applies('db/migrations/001.rb', 'ruby')).toBe(false);
  });

  it('reads CREATE TABLE only from string literals in host files', () => {
    const src = 'const q = "CREATE TABLE a (id INT)";\n/* CREATE TABLE b (id INT) */\nCREATE TABLE c (id INT);\n';
    expect(names('db/migrations/1.ts', src)).toEqual(['a']);
    const go = 'package m\nvar up = `\nCREATE TABLE IF NOT EXISTS "Gophers" (\n  id SERIAL PRIMARY KEY\n);`\n';
    expect(run('db/migrations/001.go', go)).toEqual([
      { name: 'Gophers', table: 'Gophers', orm: 'sql', file: 'db/migrations/001.go', line: 3, fields: [{ name: 'id', type: 'SERIAL', line: 4, pk: true, required: true }] },
    ]);
  });

  it('skips an unclosed CREATE TABLE without throwing', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(run('a.sql', 'CREATE TABLE broken (\n  id INT,\n  name TEXT\n')).toEqual([]);
    expect(names('a.sql', 'CREATE TABLE broken (\n  id INT,\nCREATE TABLE ok (id INT);\n')).toEqual(['ok']);
    expect(run('a.sql', 'CREATE TABLE')).toEqual([]);
    expect(run('a.sql', 'ALTER TABLE x ADD')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('merges ALTER TABLE columns into a table created in the same file', () => {
    const src = 'CREATE TABLE t (id INT PRIMARY KEY);\nALTER TABLE t ADD c TEXT UNIQUE;\nALTER TABLE u ADD COLUMN IF NOT EXISTS d INT;\n';
    expect(run('a.sql', src)).toEqual([
      { name: 't', table: 't', orm: 'sql', file: 'a.sql', line: 1, fields: [
        { name: 'id', type: 'INT', line: 1, pk: true, required: true },
        { name: 'c', type: 'TEXT', line: 2, unique: true },
      ] },
      { name: 'u', table: 'u', orm: 'sql', file: 'a.sql', line: 3, partial: true, fields: [{ name: 'd', type: 'INT', line: 3 }] },
    ]);
  });

  it('emits one entity per table name in a file, the later CREATE winning', () => {
    const recreated = run('a.sql', 'CREATE TABLE t (a INT);\nDROP TABLE t;\nCREATE TABLE t (a INT, b INT);\n');
    expect(recreated.map(e => e.name)).toEqual(['t']);
    expect(recreated[0]).toMatchObject({ line: 3, fields: [{ name: 'a', line: 3 }, { name: 'b', line: 3 }] });
    expect(names('a.sql', 'CREATE TABLE Orders (a INT);\nCREATE TABLE orders (b INT);\n')).toEqual(['orders']);
    const altered = run('a.sql', 'ALTER TABLE t ADD c INT;\nCREATE TABLE t (a INT);\n');
    expect(altered).toEqual([{ name: 't', table: 't', orm: 'sql', file: 'a.sql', line: 2, fields: [{ name: 'a', type: 'INT', line: 2 }] }]);
  });

  it('reads column flags only outside CHECK and parenthesized expressions', () => {
    expect(run('a.sql', 'CREATE TABLE t (a INT CHECK (a IS NOT NULL), b INT GENERATED ALWAYS AS (c UNIQUE) STORED, c INT CHECK (c > 0) NOT NULL);')[0].fields)
      .toEqual([{ name: 'a', type: 'INT', line: 1 }, { name: 'b', type: 'INT', line: 1 }, { name: 'c', type: 'INT', line: 1, required: true }]);
    expect(run('a.sql', 'CREATE TABLE t (p INT CHECK (p > 0) NOT NULL, q INT CHECK (q>0) REFERENCES u(id), r INT CHECK (r>0) UNIQUE, s INT DEFAULT (1) REFERENCES "v" ("k"));')[0].fields).toEqual([
      { name: 'p', type: 'INT', line: 1, required: true },
      { name: 'q', type: 'INT', line: 1, fk: { table: 'u', field: 'id' } },
      { name: 'r', type: 'INT', line: 1, unique: true },
      { name: 's', type: 'INT', line: 1, fk: { table: 'v', field: 'k' } },
    ]);
    expect(run('a.sql', 'CREATE TABLE t (x INT REFERENCES ref (rid));')[0].fields[0].fk).toEqual({ table: 'ref', field: 'rid' });
    expect(run('a.sql', 'CREATE TABLE t (LIKE u INCLUDING ALL, id INT);')[0].fields).toEqual([{ name: 'id', type: 'INT', line: 1 }]);
  });

  it('skips temporary tables', () => {
    expect(names('a.sql', 'CREATE TEMP TABLE a (id INT);\nCREATE TEMPORARY TABLE b (id INT);\nCREATE GLOBAL TEMPORARY TABLE c (id INT);\nCREATE UNLOGGED TABLE d (id INT);\n')).toEqual(['d']);
  });

  it('stays linear on ~1 MB of hostile input', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cases: [string, string][] = [
      ['a.sql', 'CREATE TABLE a ('.repeat(65000)],
      ['a.sql', 'ALTER TABLE a ADD c INT '.repeat(42000)],
      ['a.sql', 'CREATE TABLE a (b INT REFERENCES '.repeat(30000)],
      ['a.sql', 'CREATE TABLE a (' + 'b INT,'.repeat(170000) + ')'],
      ['a.sql', 'CREATE TABLE a (b INT CHECK ('.repeat(35000)],
      ['a.sql', '('.repeat(1_000_000)],
      ['db/migrations/a.ts', '`CREATE TABLE a ('.repeat(60000)],
      ['db/migrations/a.ts', "'CREATE TABLE a (b INT)',".repeat(40000)],
      ['db/migrations/a.py', '"""CREATE TABLE a (\n'.repeat(50000)],
      ['a.sql', 'CREATE TABLE a (' + Array.from({ length: 90000 }, (_, i) => `c${i} INT`).join(',') + ', PRIMARY KEY (c1));'],
      ['a.sql', Array.from({ length: 40000 }, (_, i) => `ALTER TABLE a ADD c${i} INT;`).join('\n')],
    ];
    for (const [rel, t] of cases) {
      const start = performance.now();
      run(rel, t);
      expect(performance.now() - start, `${rel} ${t.slice(0, 20)}`).toBeLessThan(1000);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('schema-sql: DROP and RENAME COLUMN', () => {
  const fields = (e: { fields: { name: string }[] }) => e.fields.map(f => f.name);

  it('applies them to a table created earlier in the same file', () => {
    const [t] = run('db/schema.sql', `CREATE TABLE orders (id INT PRIMARY KEY, legacy_code TEXT, name TEXT, total INT);
ALTER TABLE orders DROP COLUMN legacy_code;
ALTER TABLE orders RENAME COLUMN name TO title;
ALTER TABLE orders DROP COLUMN IF EXISTS total CASCADE, ADD COLUMN status TEXT;`);
    expect(fields(t)).toEqual(['id', 'title', 'status']);
  });

  it('records them on an ALTER-only migration for the merge', () => {
    const [t] = run('db/migrations/003_cleanup.sql', 'ALTER TABLE orders DROP COLUMN legacy_code, RENAME COLUMN name TO title;\nALTER TABLE orders DROP legacy2;');
    expect(t).toMatchObject({ table: 'orders', partial: true, fields: [], dropped: ['legacy_code', 'legacy2'], renamed: [['name', 'title']] });
  });

  it('does not treat other DROP and RENAME forms as columns', () => {
    const out = run('db/m.sql', `ALTER TABLE orders DROP CONSTRAINT fk_user;
ALTER TABLE orders DROP INDEX idx_a;
ALTER TABLE orders DROP PRIMARY KEY;
ALTER TABLE orders DROP FOREIGN KEY fk_x;
ALTER TABLE orders RENAME TO purchases;`);
    expect(out).toEqual([]);
  });
});

