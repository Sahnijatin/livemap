import type { Entity, Field, Lang } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { blankStrings, bracketPairs, lineAt, maskCommentsAndStrings, quotingOf, topLevelParts } from './util.js';

const JS = new Set<Lang>(['typescript', 'tsx', 'javascript']);
const ID = '[A-Za-z_$][\\w$]*';
/** Longest decorator or option text read for flags; real ones are short, and the cap keeps nested hostile input linear. */
const MAX_ARGS = 500;

/** A JS/TS file ready for matching: `code` has comments blanked, `scan` also string bodies (same offsets), `pairs` its brackets. */
interface Src { rel: string; code: string; scan: string; pairs: Int32Array }

/** Value of a lone string literal, or null. */
function str(text: string): string | null {
  const m = /^\s*(['"`])([^'"`\n]*)\1\s*$/.exec(text);
  return m ? m[2] : null;
}

/** Offset of the first non-space character of `[s, e)` in `text`. */
function firstAt(text: string, s: number, e: number): number {
  while (s < e && /\s/.test(text[s])) s++;
  return s;
}

/** An object key at `at` (identifier or quoted) and the offset of its value; null when the part is not `key: value`. */
const KEY = new RegExp(`\\s*(?:(${ID})|(['"])([^'"\\n]*)\\2)\\s*:\\s*`, 'y');
function keyAt(code: string, at: number): { name: string; value: number } | null {
  KEY.lastIndex = at;
  const m = KEY.exec(code);
  return m ? { name: m[1] ?? m[3], value: KEY.lastIndex } : null;
}

// ---------------------------------------------------------------- Prisma

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported']);
const PRISMA_FIELD = /^[ \t]*(\w+)[ \t]+(\w+)(\([^)\n]*\))?(\[\])?(\?)?/;
const bracketList = (text: string): string[] => text.split(',').map(s => /^\s*(\w+)/.exec(s)?.[1]).filter((s): s is string => !!s);

/** `model` blocks of a Prisma schema; `@@map` gives the table, and relation targets resolve to tables in the same file. */
function prisma(rel: string, text: string): Entity[] {
  const code = maskCommentsAndStrings(text, 'prisma');
  const scan = blankStrings(code, quotingOf('prisma'));
  const pairs = bracketPairs(scan);
  const models: { name: string; index: number; open: number; close: number }[] = [];
  const tables = new Map<string, string>();
  for (const m of scan.matchAll(/^[ \t]*(model|view|type|enum)[ \t]+(\w+)[ \t]*\{/gm)) {
    const open = m.index + m[0].length - 1;
    const close = pairs[open];
    if (close < open || m[1] !== 'model') continue;
    const map = /^[ \t]*@@map\s*\(\s*(?:name\s*:\s*)?"([^"\n]*)"/m.exec(code.slice(open + 1, close));
    tables.set(m[2], map ? map[1] : m[2]);
    models.push({ name: m[2], index: m.index, open, close });
  }
  return models.map(model => {
    const fields: Field[] = [];
    const byName = new Map<string, Field>();
    const fks: { cols: string[]; refs: string[]; model: string }[] = [];
    const ids: string[] = [];
    const uniques: string[] = [];
    for (let pos = model.open + 1; pos < model.close;) {
      let eol = code.indexOf('\n', pos);
      if (eol === -1 || eol > model.close) eol = model.close;
      const ln = code.slice(pos, eol);
      const sl = scan.slice(pos, eol);
      const at = pos;
      pos = eol + 1;
      const block = /^\s*@@(id|unique)\s*\(\s*(?:fields\s*:\s*)?\[([^\]\n]*)\]/.exec(sl);
      if (block) {
        const cols = bracketList(block[2]);
        if (block[1] === 'id') ids.push(...cols);
        else if (cols.length === 1) uniques.push(cols[0]);
        continue;
      }
      const m = PRISMA_FIELD.exec(sl);
      if (!m) continue;
      const [, name, base, , list, opt] = m;
      const relation = /@relation\s*\(([^)\n]*)\)/.exec(ln);
      const isRelation = tables.has(base) || !!relation;
      const f: Field = { name, type: base + (list ? '[]' : ''), line: lineAt(text, at + m[0].length - m[0].trimStart().length) };
      if (/(?<!@)@id\b/.test(sl)) { f.pk = true; f.required = true; }
      if (/@unique\b/.test(sl)) f.unique = true;
      if (!opt && !list && !isRelation) f.required = true;
      if (isRelation) f.relation = { model: base, many: !!list };
      if (relation) {
        const cols = /\bfields\s*:\s*\[([^\]]*)\]/.exec(relation[1]);
        const refs = /\breferences\s*:\s*\[([^\]]*)\]/.exec(relation[1]);
        if (cols && refs) fks.push({ cols: bracketList(cols[1]), refs: bracketList(refs[1]), model: base });
      }
      if (!byName.has(name)) { byName.set(name, f); fields.push(f); }
    }
    for (const id of ids) { const f = byName.get(id); if (f) { f.pk = true; f.required = true; } }
    for (const u of uniques) { const f = byName.get(u); if (f) f.unique = true; }
    for (const fk of fks) {
      fk.cols.forEach((c, i) => {
        const f = byName.get(c);
        if (f && fk.refs[i]) f.fk = { table: tables.get(fk.model) ?? fk.model, field: fk.refs[i] };
      });
    }
    const table = tables.get(model.name) ?? model.name;
    return { name: model.name, table, orm: 'prisma', file: rel, line: lineAt(text, firstAt(code, model.index, model.open)), fields };
  });
}

// ---------------------------------------------------------------- Drizzle

const DRIZZLE = new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:pgTable|mysqlTable|sqliteTable)\\s*\\(`, 'g');
const TABLE_ARGS = /\s*(['"`])([^'"`\n]*)\1\s*,\s*/y;
const COLUMNS_FN = new RegExp(`(?:\\(\\s*(?:${ID})?\\s*\\)|${ID})\\s*=>\\s*\\(?\\s*`, 'y');
const BUILDER = new RegExp(`(?:${ID}\\s*\\.\\s*)?(${ID})\\s*\\(`, 'y');
const CHAIN = new RegExp(`\\s*\\.\\s*(${ID})\\s*\\(`, 'y');
const REFERENCE = new RegExp(`^\\s*\\(\\s*\\)\\s*(?::[^=]{0,100})?=>\\s*(${ID})\\s*\\.\\s*(${ID})`);
/** Longest builder chain read per column; real chains have a handful of calls. */
const MAX_CHAIN = 32;

/** `const x = pgTable('t', { col: builder(...).primaryKey()... })` (also `mysqlTable`, `sqliteTable`, and the `(t) => ({ ... })` form). */
function drizzle(src: Src): Entity[] {
  const { code, scan, pairs } = src;
  const found: { name: string; table: string; index: number; open: number; close: number }[] = [];
  for (const m of scan.matchAll(DRIZZLE)) {
    TABLE_ARGS.lastIndex = m.index + m[0].length;
    const t = TABLE_ARGS.exec(code);
    if (!t) continue;
    COLUMNS_FN.lastIndex = TABLE_ARGS.lastIndex;
    const open = COLUMNS_FN.exec(scan) ? COLUMNS_FN.lastIndex : TABLE_ARGS.lastIndex;
    const close = scan[open] === '{' ? pairs[open] : -1;
    if (close < open) continue;
    found.push({ name: m[1], table: t[2], index: m.index, open, close });
  }
  const tables = new Map(found.map(t => [t.name, t.table]));
  return found.map(t => {
    const fields: Field[] = [];
    for (const [s, e] of topLevelParts(scan, pairs, t.open + 1, t.close)) {
      const key = keyAt(code, s);
      if (!key) continue;
      BUILDER.lastIndex = key.value;
      const b = BUILDER.exec(scan);
      if (!b || BUILDER.lastIndex > e) continue;
      const f: Field = { name: key.name, type: b[1], line: lineAt(code, firstAt(code, s, e)) };
      let close = pairs[BUILDER.lastIndex - 1];
      for (let n = 0; close > 0 && close < e && n < MAX_CHAIN; n++) {
        CHAIN.lastIndex = close + 1;
        const c = CHAIN.exec(scan);
        if (!c) break;
        const open = CHAIN.lastIndex - 1;
        close = pairs[open];
        if (c[1] === 'primaryKey') { f.pk = true; f.required = true; }
        else if (c[1] === 'notNull') f.required = true;
        else if (c[1] === 'unique') f.unique = true;
        else if (c[1] === 'references') {
          const r = REFERENCE.exec(code.slice(open + 1, Math.min(close > open ? close : e, open + 1 + MAX_ARGS)));
          if (r) f.fk = { table: tables.get(r[1]) ?? r[1], field: r[2] };
        }
      }
      fields.push(f);
    }
    return { name: t.name, table: t.table, orm: 'drizzle', file: src.rel, line: lineAt(code, t.index), fields };
  });
}

// ---------------------------------------------------------------- TypeORM

const DECORATOR = /\s*@[\w$.]+\s*/y;
const CLASS = new RegExp(`\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${ID})[^{;]{0,1000}\\{`, 'y');
const MEMBER = /@(Column|PrimaryGeneratedColumn|PrimaryColumn|ObjectIdColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|ManyToOne|OneToOne|OneToMany|ManyToMany)\s*\(/g;
const PROPERTY = new RegExp(`\\s*(?:(?:public|private|protected|readonly|declare|override)\\s+)*(${ID})\\s*([!?])?\\s*:\\s*([^;=\\n]{0,300})`, 'y');
const TARGET = new RegExp(`^\\s*(?:(?:\\(\\s*(?:${ID})?\\s*\\)|${ID})\\s*=>\\s*(${ID})|(['"\`])(${ID})\\2)`);

/** Index just past the decorators (and their argument lists) starting at `i`. */
function skipDecorators(scan: string, pairs: Int32Array, i: number): number {
  for (let guard = 0; guard < 16; guard++) {
    DECORATOR.lastIndex = i;
    if (!DECORATOR.exec(scan)) break;
    i = DECORATOR.lastIndex;
    if (scan[i] === '(') { const close = pairs[i]; if (close < i) return -1; i = close + 1; }
  }
  return i;
}

/** `@Entity()` classes and their column and relation decorated properties. */
function typeorm(src: Src): Entity[] {
  const { code, scan, pairs } = src;
  const classes: { entity: Entity; open: number; close: number }[] = [];
  for (const m of scan.matchAll(/@Entity\s*\(/g)) {
    const paren = m.index + m[0].length - 1;
    const end = pairs[paren];
    if (end < paren) continue;
    const arg = code.slice(paren + 1, Math.min(end, paren + 1 + MAX_ARGS));
    const named = /^\s*\{[^}]*?\bname\s*:\s*(['"`])([^'"`\n]*)\1/.exec(arg);
    const after = skipDecorators(scan, pairs, end + 1);
    if (after < 0) continue;
    CLASS.lastIndex = after;
    const c = CLASS.exec(scan);
    if (!c) continue;
    const open = CLASS.lastIndex - 1;
    const close = pairs[open];
    if (close < open) continue;
    const name = c[1];
    const table = str(arg) ?? named?.[2] ?? name;
    const line = lineAt(code, firstAt(scan, after, open));
    classes.push({ entity: { name, table, orm: 'typeorm', file: src.rel, line, fields: [] }, open, close });
  }
  if (!classes.length) return [];
  let ci = 0;
  for (const m of scan.matchAll(MEMBER)) {
    while (ci < classes.length && classes[ci].close < m.index) ci++;
    if (ci >= classes.length) break;
    const cls = classes[ci];
    if (m.index < cls.open) continue;
    const paren = m.index + m[0].length - 1;
    const end = pairs[paren];
    if (end < paren || end > cls.close) continue;
    const args = code.slice(paren + 1, Math.min(end, paren + 1 + MAX_ARGS));
    const after = skipDecorators(scan, pairs, end + 1);
    if (after < 0) continue;
    PROPERTY.lastIndex = after;
    const p = PROPERTY.exec(scan);
    if (!p) continue;
    const type = code.slice(PROPERTY.lastIndex - p[3].length, PROPERTY.lastIndex).trim();
    const f: Field = { name: p[1], type, line: lineAt(code, firstAt(scan, after, PROPERTY.lastIndex)) };
    const kind = m[1];
    if (kind === 'ManyToOne' || kind === 'OneToOne' || kind === 'OneToMany' || kind === 'ManyToMany') {
      const t = TARGET.exec(args);
      if (t) f.relation = { model: t[1] ?? t[3], many: kind === 'OneToMany' || kind === 'ManyToMany' };
    } else if (kind.startsWith('Primary') || kind === 'ObjectIdColumn' || /\bprimary\s*:\s*true\b/.test(args)) {
      f.pk = true;
      f.required = true;
    } else {
      if (/\bunique\s*:\s*true\b/.test(args)) f.unique = true;
      const nullable = /\bnullable\s*:\s*true\b/.test(args) || p[2] === '?' || /(?:\|\s*null\b|\bnull\s*\|)/.test(type);
      if (!nullable) f.required = true;
    }
    cls.entity.fields.push(f);
  }
  return classes.map(c => c.entity);
}

// ---------------------------------------------------------------- Mongoose

const SCHEMA = new RegExp(`(?:\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=\\n]{0,200})?=\\s*)?(new\\s+(?:mongoose\\s*\\.\\s*)?Schema\\s*(?:<[^>\\n]{0,200}>)?\\s*\\()`, 'g');
const MODEL = /(?<![\w$])model\s*(?:<[^>\n]{0,200}>)?\s*\(/g;
const MODEL_ARGS = new RegExp(`\\s*(['"\`])(${ID})\\1\\s*,\\s*(?:(new)\\b|(${ID})\\s*(?=[,)]))`, 'y');
const COLLECTION = /\s*,\s*(['"`])([^'"`\n]+)\1/y;
const TYPE_NAME = /^[\w$.]+/;

const UNCOUNTABLE = new Set(('advice energy excretion digestion cooperation health justice labour machinery equipment information '
  + 'pollution sewage paper money species series rain rice fish sheep moose deer news expertise status media').split(' '));
/** Mongoose's pluralization rules, first match wins. */
const PLURAL_RULES: [RegExp, string][] = [
  [/(m)an$/, '$1en'], [/(pe)rson$/, '$1ople'], [/(child)$/, '$1ren'], [/^(ox)$/, '$1en'], [/(ax|test)is$/, '$1es'],
  [/(octop|vir)us$/, '$1i'], [/(alias|status)$/, '$1es'], [/(bu)s$/, '$1ses'], [/(buffal|tomat|potat)o$/, '$1oes'],
  [/([ti])um$/, '$1a'], [/sis$/, 'ses'], [/(?:([^f])fe|([lr])f)$/, '$1$2ves'], [/(hive)$/, '$1s'], [/([^aeiouy]|qu)y$/, '$1ies'],
  [/(x|ch|ss|sh)$/, '$1es'], [/(matr|vert|ind)ix|ex$/, '$1ices'], [/([ml])ouse$/, '$1ice'], [/(kn|w|l)ife$/, '$1ives'],
  [/(quiz)$/, '$1zes'], [/s$/, 's'], [/([^a-z])$/, '$1'], [/$/, 's'],
];
/** The collection name mongoose derives from a model name: lowercased and pluralized. */
function pluralize(name: string): string {
  const w = name.toLowerCase();
  if (UNCOUNTABLE.has(w)) return w;
  const rule = PLURAL_RULES.find(([re]) => re.test(w));
  return rule ? w.replace(rule[0], rule[1]) : w;
}

/** How deep `type` and array values are followed; real schemas nest one or two levels. */
const MAX_DEPTH = 4;

/** Type and flags of a schema path value: `String`, `{ type, required, unique, ref }`, `[X]` or `[{ type, ref }]`. */
function pathOf(src: Src, s: number, e: number, f: Field, depth = 0): void {
  const { code, scan, pairs } = src;
  const at = firstAt(scan, s, e);
  const c = scan[at];
  if (c === '[') {
    const close = pairs[at];
    const first = close > at ? topLevelParts(scan, pairs, at + 1, close)[0] : undefined;
    if (!first || depth >= MAX_DEPTH) { f.type = 'Array'; return; }
    pathOf(src, first[0], first[1], f, depth + 1);
    f.type += '[]';
    if (f.relation) f.relation.many = true;
    return;
  }
  if (c !== '{') { f.type = TYPE_NAME.exec(scan.slice(at, Math.min(e, at + MAX_ARGS)))?.[0].split('.').pop() ?? ''; return; }
  const close = pairs[at];
  if (close < at) { f.type = 'Object'; return; }
  const props = new Map<string, [number, number]>();
  for (const [ps, pe] of topLevelParts(scan, pairs, at + 1, close)) {
    const key = keyAt(code, ps);
    if (key && !props.has(key.name)) props.set(key.name, [key.value, pe]);
  }
  const text = (k: string): string => { const r = props.get(k); return r ? code.slice(r[0], Math.min(r[1], r[0] + MAX_ARGS)).trim() : ''; };
  const type = props.get('type');
  if (!type || depth >= MAX_DEPTH) { f.type = 'Object'; return; }
  pathOf(src, type[0], type[1], f, depth + 1);
  if (/^(?:true\b|\[\s*true\b)/.test(text('required'))) f.required = true;
  if (/^true\b/.test(text('unique'))) f.unique = true;
  const ref = str(text('ref'));
  if (ref) f.relation = { model: ref, many: f.type.endsWith('[]') };
}

/** `model('Order', orderSchema)` with a `new Schema({ ... })` in the same file; a schema defined elsewhere gives an entity without fields. */
function mongoose(src: Src): Entity[] {
  const { code, scan, pairs } = src;
  const schemas = new Map<string | number, { index: number; paren: number; fields: Field[] }>();
  /** Schemas declared here whose definition is unclosed: their models are skipped, not treated as defined elsewhere. */
  const broken = new Set<string>();
  for (const m of scan.matchAll(SCHEMA)) {
    const paren = m.index + m[0].length - 1;
    const at = firstAt(scan, paren + 1, scan.length);
    const close = scan[at] === '{' ? pairs[at] : -1;
    if (close < at) { if (m[1]) broken.add(m[1]); continue; }
    const fields: Field[] = [];
    for (const [s, e] of topLevelParts(scan, pairs, at + 1, close)) {
      const key = keyAt(code, s);
      if (!key) continue;
      const f: Field = { name: key.name, type: '', line: lineAt(code, firstAt(code, s, e)) };
      pathOf(src, key.value, e, f);
      fields.push(f);
    }
    const schema = { index: m.index, paren, fields };
    schemas.set(m.index + m[0].length - m[2].length, schema);
    if (m[1]) schemas.set(m[1], schema);
  }
  const imported = /\bfrom\s*['"]mongoose['"]|\brequire\s*\(\s*['"]mongoose['"]\s*\)/.test(code);
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const m of scan.matchAll(MODEL)) {
    MODEL_ARGS.lastIndex = m.index + m[0].length;
    const a = MODEL_ARGS.exec(code);
    if (!a) continue;
    const schema = a[3] ? schemas.get(MODEL_ARGS.lastIndex - 3) : schemas.get(a[4]);
    // Without a mongoose import only a schema defined here marks the call as Mongoose (not zod, not an SDK client).
    if (!schema && (a[3] || !imported || broken.has(a[4]))) continue;
    if (seen.has(a[2])) continue;
    seen.add(a[2]);
    const callEnd = schema && a[3] ? pairs[schema.paren] : MODEL_ARGS.lastIndex - 1;
    let table = pluralize(a[2]);
    if (callEnd > 0) {
      COLLECTION.lastIndex = callEnd + 1;
      const c = COLLECTION.exec(code);
      if (c) table = c[2];
    }
    const line = lineAt(code, schema ? schema.index : m.index);
    out.push({ name: a[2], table, orm: 'mongoose', file: src.rel, line, fields: schema ? schema.fields.map(f => ({ ...f })) : [] });
  }
  return out;
}

/** Entities from Prisma schemas and from Drizzle, TypeORM and Mongoose definitions in JS/TS. */
export const schemaJs: Analyzer = {
  name: 'schema-js',
  applies: (_rel, lang) => lang === 'prisma' || JS.has(lang),
  run(rel, lang, text) {
    if (lang === 'prisma') return { entities: prisma(rel, text) };
    const hasDrizzle = /(?:pg|mysql|sqlite)Table\b/.test(text);
    const hasTypeorm = text.includes('@Entity');
    const hasMongoose = text.includes('Schema') && text.includes('model');
    if (!hasDrizzle && !hasTypeorm && !hasMongoose) return {};
    const code = maskCommentsAndStrings(text, lang);
    const scan = blankStrings(code);
    const src: Src = { rel, code, scan, pairs: bracketPairs(scan) };
    return { entities: [...(hasDrizzle ? drizzle(src) : []), ...(hasTypeorm ? typeorm(src) : []), ...(hasMongoose ? mongoose(src) : [])] };
  },
};
