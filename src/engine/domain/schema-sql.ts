import type { Entity, Field, Lang } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { bracketPairs, lineAt, maskCommentsAndStrings, quotingOf, skipString, topLevelParts, type Quoting } from './util.js';

/** Languages whose migration files may carry SQL in string literals. */
const HOSTS = new Set<Lang>(['typescript', 'tsx', 'javascript', 'python', 'go']);
const SQL_QUOTES: Quoting = { single: true, backtick: false, triple: false };

const IDENT = '(?:"[^"\\n]*"|`[^`\\n]*`|\\[[^\\]\\n]*\\]|[A-Za-z_][\\w$]*)';
const QNAME = `${IDENT}(?:\\s*\\.\\s*${IDENT}){0,3}`;
/** Group 1 marks a temporary table, which is skipped. */
const CREATE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(temporary|temp)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?/gi;
const ALTER = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/gi;
const NAME_PAREN = new RegExp(`(${QNAME})\\s*\\(`, 'y');
const NAME = new RegExp(`(${QNAME})`, 'y');
const COLUMN = new RegExp(`^(${IDENT})(?:\\s+([A-Za-z_]\\w*))?`);
const REFS = new RegExp(`\\breferences\\s+(${QNAME})`, 'i');
const CONSTRAINT_NAME = new RegExp(`^constraint\\s+${IDENT}\\s*`, 'i');
const PK = /^primary\s+key\s*\(([^)]*)\)/i;
const FK = new RegExp(`^foreign\\s+key\\s*\\(([^)]*)\\)\\s*references\\s+(${QNAME})\\s*(?:\\(([^)]*)\\))?`, 'i');
const UNIQUE = new RegExp(`^unique(?:\\s+(?:key|index))?(?:\\s+${IDENT})?\\s*\\(([^)]*)\\)`, 'i');
/**
 * Start of a table constraint rather than a column. MySQL `KEY name (cols)` needs whitespace before the paren
 * when named, so a column called `key VARCHAR(10)` stays a column.
 */
const CONSTRAINT_START = new RegExp('^(?:constraint\\s|like\\s|primary\\s+key\\b|foreign\\s+key\\b|check\\s*\\(|exclude\\b|period\\s+for\\b'
  + `|unique\\b\\s*(?:\\(|(?:key|index)\\b|${IDENT}\\s*\\()`
  + `|(?:key|index|fulltext|spatial)\\b(?:\\s+(?:key|index)\\b)?\\s*(?:\\(|[A-Za-z_][\\w$]*\\s+\\(|(?:"[^"\\n]*"|\`[^\`\\n]*\`|\\[[^\\]\\n]*\\])\\s*\\())`, 'i');
const ADD = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?/i;
/** Words that start a column constraint rather than a type, for typeless (SQLite) columns. */
const NOT_TYPES = new Set(['PRIMARY', 'NOT', 'NULL', 'REFERENCES', 'UNIQUE', 'DEFAULT', 'CHECK', 'CONSTRAINT', 'GENERATED', 'COLLATE']);

const unquote = (s: string): string => /^["`[]/.test(s) ? s.slice(1, -1) : s;
/** The bare table name of a possibly schema-qualified, possibly quoted name (`public."orders"` -> `orders`). */
function bare(qname: string): string {
  const parts = qname.match(new RegExp(IDENT, 'g')) ?? [qname];
  return unquote(parts[parts.length - 1]);
}
const names = (list: string): string[] => list.split(',').map(s => unquote(s.trim())).filter(Boolean);

/** Copy with single-quoted string bodies blanked (quotes and newlines kept); double quotes are identifiers in SQL. */
function blankSingle(sql: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = sql.indexOf("'"); i !== -1; i = sql.indexOf("'", i + 1)) {
    const end = skipString(sql, i, sql.length, SQL_QUOTES);
    parts.push(sql.slice(start, i + 1), sql.slice(i + 1, end).replace(/[^\n]/g, ' '));
    start = i = end;
  }
  parts.push(sql.slice(start));
  return parts.join('');
}

type Line = (index: number) => number;
interface Table { entity: Entity; cols: Columns }

/** Fields of one table in column order, indexed by name so wide tables and long ALTER runs stay linear. */
class Columns {
  readonly list: Field[] = [];
  private readonly byName = new Map<string, Field>();
  get(name: string): Field | undefined { return this.byName.get(name); }
  /** Adds `f`, or merges its flags into the field of the same name (keeping a known type). */
  upsert(f: Field): void {
    const old = this.byName.get(f.name);
    if (!old) { this.list.push(f); this.byName.set(f.name, f); return; }
    const { type, line: _line, ...flags } = f;
    Object.assign(old, flags);
    if (!old.type) old.type = type;
  }
}

/**
 * Column text after its name with the contents of every parenthesized group blanked (parens and offsets kept),
 * so `CHECK (a IS NOT NULL)`, `AS (x UNIQUE)` or `DEFAULT (..)` set no flags while constraints after them still count.
 */
function blankGroups(text: string): string {
  const out: string[] = [];
  let depth = 0;
  for (const c of text) {
    if (c === '(') { out.push(depth === 0 ? c : ' '); depth++; }
    else if (c === ')' && depth > 0) { depth--; out.push(depth === 0 ? c : ' '); }
    else out.push(depth > 0 && c !== '\n' ? ' ' : c);
  }
  return out.join('');
}
const REF_COLUMN = new RegExp(`\\s*\\(\\s*(${IDENT})`, 'y');

/** A column definition; null when the text is not one. */
function column(text: string, line: number): Field | null {
  const m = COLUMN.exec(text);
  if (!m) return null;
  const word = m[2]?.toUpperCase() ?? '';
  const f: Field = { name: unquote(m[1]), type: NOT_TYPES.has(word) ? '' : word, line };
  const raw = text.slice(m[1].length);
  const rest = blankGroups(raw);
  if (/\bprimary\s+key\b/i.test(rest)) { f.pk = true; f.required = true; }
  if (/\bnot\s+null\b/i.test(rest)) f.required = true;
  if (/\bunique\b/i.test(rest)) f.unique = true;
  const r = REFS.exec(rest);
  if (r) {
    REF_COLUMN.lastIndex = r.index + r[0].length;
    const col = REF_COLUMN.exec(raw);
    f.fk = { table: bare(r[1]), field: col ? unquote(col[1]) : 'id' };
  }
  return f;
}

/**
 * A table constraint (`PRIMARY KEY (..)`, `FOREIGN KEY (..) REFERENCES t(..)`, single-column `UNIQUE (..)`),
 * applied to `cols`. `create` adds fields the constraint names but `cols` lacks (ALTER TABLE ADD CONSTRAINT).
 */
function constraint(text: string, cols: Columns, line: number, create: boolean): void {
  const t = text.replace(CONSTRAINT_NAME, '');
  const mark = (name: string, flags: Partial<Field>): void => {
    const f = cols.get(name);
    if (f) Object.assign(f, flags);
    else if (create) cols.upsert({ name, type: '', line, ...flags });
  };
  const pk = PK.exec(t);
  if (pk) for (const n of names(pk[1])) mark(n, { pk: true, required: true });
  const fk = FK.exec(t);
  if (fk) {
    const refs = fk[3] ? names(fk[3]) : [];
    names(fk[1]).forEach((c, i) => mark(c, { fk: { table: bare(fk[2]), field: refs[i] ?? 'id' } }));
  }
  const u = UNIQUE.exec(t);
  const one = u ? names(u[1]) : [];
  if (one.length === 1) mark(one[0], { unique: true });
}

/** Text of a part with its leading whitespace offset, so the field line points at the column name. */
function part(scan: string, [s, e]: [number, number]): { text: string; at: number } {
  const raw = scan.slice(s, e);
  const lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), at: s + lead };
}

/**
 * CREATE TABLE and ALTER TABLE ... ADD statements of comment-masked SQL. `line` maps an offset in `sql` to a
 * file line. ALTER columns fold into a table created earlier in the same text, else into one partial entity per table.
 */
function parseSql(sql: string, line: Line, rel: string, out: Entity[], tables: Map<string, Table>): void {
  const scan = blankSingle(sql);
  if (!/\btable\b/i.test(scan)) return;
  const pairs = bracketPairs(scan);
  const events: { kind: 'create' | 'alter'; index: number; at: number; temp?: true }[] = [];
  for (const m of scan.matchAll(CREATE)) events.push({ kind: 'create', index: m.index, at: m.index + m[0].length, ...(m[1] ? { temp: true as const } : {}) });
  for (const m of scan.matchAll(ALTER)) events.push({ kind: 'alter', index: m.index, at: m.index + m[0].length });
  events.sort((a, b) => a.index - b.index);
  let skipUntil = -1;
  let semi = -1;
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    if (ev.index < skipUntil) continue;
    if (ev.kind === 'create') {
      NAME_PAREN.lastIndex = ev.at;
      const m = NAME_PAREN.exec(scan);
      if (!m) continue;
      const open = NAME_PAREN.lastIndex - 1;
      const close = pairs[open];
      if (close < open) continue;
      skipUntil = close;
      if (ev.temp) continue;
      const table = bare(m[1]);
      const cols = new Columns();
      const constraints: { text: string; at: number }[] = [];
      for (const r of topLevelParts(scan, pairs, open + 1, close)) {
        const p = part(scan, r);
        if (CONSTRAINT_START.test(p.text)) { constraints.push(p); continue; }
        const f = column(p.text, line(p.at));
        if (f) cols.upsert(f);
      }
      for (const c of constraints) constraint(c.text, cols, line(c.at), false);
      const entity: Entity = { name: table, table, orm: 'sql', file: rel, line: line(ev.index), fields: cols.list };
      const key = table.toLowerCase();
      const known = tables.get(key);
      if (known) {
        // A table created again (after a DROP, or in another case) replaces the earlier entity in place: one name per file.
        delete known.entity.partial;
        Object.assign(known.entity, entity);
        known.cols = cols;
      } else {
        out.push(entity);
        tables.set(key, { entity, cols });
      }
      continue;
    }
    NAME.lastIndex = ev.at;
    const m = NAME.exec(scan);
    if (!m) continue;
    const from = NAME.lastIndex;
    if (semi < from) { semi = scan.indexOf(';', from); if (semi === -1) semi = scan.length; }
    const end = Math.min(semi, k + 1 < events.length ? events[k + 1].index : scan.length);
    const table = bare(m[1]);
    const added = new Columns();
    for (const r of topLevelParts(scan, pairs, from, end)) {
      const p = part(scan, r);
      const add = ADD.exec(p.text);
      if (!add) continue;
      const rest = p.text.slice(add[0].length);
      if (CONSTRAINT_START.test(rest)) { constraint(rest, added, line(p.at), true); continue; }
      const f = column(rest, line(p.at));
      if (f) added.upsert(f);
    }
    if (!added.list.length) continue;
    const key = table.toLowerCase();
    let target = tables.get(key);
    if (!target) {
      const cols = new Columns();
      target = { entity: { name: table, table, orm: 'sql', file: rel, line: line(ev.index), fields: cols.list, partial: true }, cols };
      out.push(target.entity);
      tables.set(key, target);
    }
    for (const f of added.list) target.cols.upsert(f);
  }
}

/** Escapes inside a host-language string (`\n`, `\"`) become spaces, offsets kept, so the SQL reads as written. */
const unescape = (body: string): string => body.replace(/\\[nrt"'`\\]/g, '  ');

/** SQL string literals of a host-language migration file, each parsed with lines mapped back to the file. */
function hostSql(rel: string, lang: Lang, text: string, out: Entity[], tables: Map<string, Table>): void {
  const code = maskCommentsAndStrings(text, lang);
  const q = quotingOf(lang);
  const line: (base: number) => Line = base => i => lineAt(text, base + i);
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== '"' && !(c === "'" && q.single) && !(c === '`' && q.backtick)) continue;
    const end = skipString(code, i, code.length, q);
    const triple = q.triple && code[i + 1] === c && code[i + 2] === c;
    const from = triple ? i + 3 : i + 1;
    const to = triple ? Math.max(from, end - 2) : end;
    const body = code.slice(from, to);
    if (/\btable\b/i.test(body)) parseSql(maskCommentsAndStrings(unescape(body), 'sql'), line(from), rel, out, tables);
    i = end;
  }
}

/** Tables from SQL: `.sql` files, and SQL strings in JS/TS/Python/Go files under a migrations path. */
export const schemaSql: Analyzer = {
  name: 'schema-sql',
  applies: (rel, lang) => lang === 'sql' || (HOSTS.has(lang) && /migration/i.test(rel)),
  run(rel, lang, text) {
    const out: Entity[] = [];
    const tables = new Map<string, Table>();
    if (lang === 'sql') parseSql(maskCommentsAndStrings(text, 'sql'), i => lineAt(text, i), rel, out, tables);
    else hostSql(rel, lang, text, out, tables);
    return { entities: out };
  },
};
