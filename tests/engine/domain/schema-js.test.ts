import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYZERS, analyzeFile } from '../../../src/engine/domain/index.js';
import { schemaJs } from '../../../src/engine/domain/schema-js.js';
import { langOf } from '../../../src/engine/languages.js';

const DIR = fileURLToPath(new URL('../../fixtures/domain/schema/', import.meta.url));
const run = (rel: string, text: string) => analyzeFile(rel, langOf(rel), text, [schemaJs]).entities;
const names = (rel: string, text: string): string[] => run(rel, text).map(e => e.name);

describe('schema-js analyzer', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const orm of ['prisma', 'drizzle', 'typeorm', 'mongoose']) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, orm, 'expected.json'), 'utf8')) as Record<string, unknown>;
    for (const [rel, want] of Object.entries(golden)) {
      it(`${orm}: ${rel} matches the golden`, () => {
        expect(run(rel, fs.readFileSync(path.join(DIR, orm, rel), 'utf8'))).toEqual(want);
      });
    }
  }

  it('is registered and gated to Prisma and JS/TS files', () => {
    expect(ANALYZERS).toContain(schemaJs);
    expect(schemaJs.applies('prisma/schema.prisma', 'prisma')).toBe(true);
    expect(schemaJs.applies('src/db/schema.ts', 'typescript')).toBe(true);
    expect(schemaJs.applies('src/models/order.js', 'javascript')).toBe(true);
    expect(schemaJs.applies('src/a.tsx', 'tsx')).toBe(true);
    expect(schemaJs.applies('app/models.py', 'python')).toBe(false);
    expect(schemaJs.applies('a.sql', 'sql')).toBe(false);
  });

  it('skips an unclosed Prisma model without throwing', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(names('schema.prisma', 'model A {\n  id Int @id\n}\n\nmodel X {\n  id Int @id\n')).toEqual(['A']);
    expect(names('schema.prisma', 'model X {\n  id Int @id\nmodel B {\n  id Int @id\n}\n')).toEqual(['B']);
    expect(run('schema.prisma', 'model')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips unclosed Drizzle, TypeORM and Mongoose blocks', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(run('db/schema.ts', "export const a = pgTable('a', {\n  id: serial('id'),\n")).toEqual([]);
    expect(run('e.ts', "@Entity('a')\nexport class A {\n  @Column()\n  x: string;\n")).toEqual([]);
    expect(run('m.js', "const s = new Schema({ a: String,\nmodel('A', s);\n")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores schema code inside strings and comments', () => {
    const src = "const doc = \"export const a = pgTable('a', { id: serial('id') })\";\n// model('B', new Schema({ x: String }))\nconst t = `@Entity() class C {}`;\n";
    expect(run('src/doc.ts', src)).toEqual([]);
  });

  it('pluralizes Mongoose model names the way mongoose does', () => {
    const src = ['Box', 'Category', 'Person', 'Status', 'Knife', 'Bus', 'Child'].map(n => `model('${n}', new Schema({}));`).join('\n');
    expect(run('m.js', src).map(e => e.table)).toEqual(['boxes', 'categories', 'people', 'status', 'knives', 'buses', 'children']);
  });

  it('emits one Mongoose entity per model name in a file', () => {
    const src = "import mongoose from 'mongoose';\nconst S = new mongoose.Schema({ a: String });\nmongoose.model('Order', S);\nconn.model('Order', S);\n";
    expect(names('m.ts', src)).toEqual(['Order']);
  });

  it('reads Mongoose models only with a mongoose import or a local schema', () => {
    expect(run('c.ts', "import { Schema } from 'zod';\nclient.model('Claude', opts);\n")).toEqual([]);
    expect(names('c.js', "const mongoose = require('mongoose');\nmongoose.model('Tag', tagSchema);\n")).toEqual(['Tag']);
    expect(names('c.ts', "import { model, Schema } from 'mongoose';\nmodel('Tag', tagSchema);\n")).toEqual(['Tag']);
    expect(names('c.ts', "const s = new Schema({ a: String });\nmodel('A', s);\n")).toEqual(['A']);
  });

  it('stays linear on ~1 MB of hostile input', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cases: [string, string][] = [
      ['schema.prisma', 'model A {\n'.repeat(100000)],
      ['schema.prisma', 'model A {\n' + '  a B @relation(fields: [\n'.repeat(40000) + '}'],
      ['schema.prisma', '{'.repeat(1_000_000)],
      ['s.ts', "const a = pgTable('a', {".repeat(42000)],
      ['s.ts', "const a = pgTable('a', { b: c(".repeat(32000) + ')})'.repeat(32000)],
      ['s.ts', "const a = pgTable('a', { b: c()" + '.d()'.repeat(240000) + '})'],
      ['e.ts', '@Entity(@Entity('.repeat(60000)],
      ['e.ts', '@Entity() class A {' + '@Column() '.repeat(90000) + '}'],
      ['e.ts', '@Entity() class A {' + '@Column()'.repeat(100000)],
      ['m.js', 'const s = new Schema({'.repeat(45000)],
      ['m.js', 'const s = new Schema({ a: { b: { c: '.repeat(28000)],
      ['m.js', "model('A', ".repeat(90000)],
      ['m.js', 'const s = new Schema({ a: ' + '{ type: ['.repeat(50000) + ']}'.repeat(50000) + "});\nmodel('A', s);"],
      ['schema.prisma', 'model A {\n' + Array.from({ length: 60000 }, (_, i) => `  f${i} Int @id`).join('\n') + '\n  @@id([f1])\n}'],
      ['m.js', 'const s = new Schema({' + 'a: [{ type: X, ref: "Y" }],'.repeat(36000) + "});\nmodel('A', s);"],
    ];
    for (const [rel, t] of cases) {
      const start = performance.now();
      run(rel, t);
      expect(performance.now() - start, `${rel} ${t.slice(0, 24)}`).toBeLessThan(1000);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
