import type { Entity, Field } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { argsOf, firstAt, isOpenBracket as isOpen, lineAt, onePerName, scanned, topLevelParts, type Scanned as Src } from './util.js';

/** Longest annotation or member text read; real ones are short, and the cap keeps hostile input linear. */
const MAX_ARGS = 500;
/** Longest Room `@Entity(...)` argument list read; longer ones are read as empty. */
const MAX_ENTITY_ARGS = 20_000;

const lineOf = (src: Src, i: number): number => lineAt(src.text, i);
const strs = (text: string): string[] => [...text.matchAll(/["']([^"'\n]*)["']/g)].map(m => m[1]);

interface Annot { name: string; args: string }
const ANNOT = /\s*@(?:\w+:)?([\w.]+)\s*/y;
/** Annotations from `i` (at most 32), with their argument text; returns the index after them, or -1 on an unclosed argument list. */
function annotations(src: Src, i: number, list: Annot[]): number {
  for (let guard = 0; guard < 32; guard++) {
    ANNOT.lastIndex = i;
    const m = ANNOT.exec(src.scan);
    if (!m) break;
    i = ANNOT.lastIndex;
    let args = '';
    if (src.scan[i] === '(') {
      const close = src.pairs[i];
      if (close < i) return -1;
      args = src.code.slice(i + 1, Math.min(close, i + 1 + MAX_ARGS));
      i = close + 1;
    }
    list.push({ name: m[1].slice(m[1].lastIndexOf('.') + 1), args });
  }
  return i;
}

/** Top-level statements of a brace body: split at newlines and `;`, and after each nested `{...}` group. */
function statements(scan: string, pairs: Int32Array, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let s = from;
  const push = (e: number): void => { if (firstAt(scan, s, e) < e) out.push([s, e]); s = e; };
  for (let i = from; i < to; i++) {
    const c = scan.charCodeAt(i);
    if (isOpen(c)) {
      const j = pairs[i];
      if (j > i && j < to) { i = j; if (c === 123) push(j + 1); }
      continue;
    }
    if (c === 10 || c === 59) { push(i); s = i + 1; }
  }
  push(to);
  return out;
}

/** Calls a member parser on each top-level statement, carrying annotations written on their own lines to the next member. */
function members(src: Src, from: number, to: number, each: (annots: Annot[], at: number, end: number) => void): void {
  let pending: Annot[] = [];
  for (const [s, e] of statements(src.scan, src.pairs, from, to)) {
    const annots: Annot[] = [];
    const at = annotations(src, s, annots);
    if (at < 0) { pending = []; continue; }
    const start = firstAt(src.scan, at, e);
    if (start >= e) { pending.push(...annots); continue; }
    each(pending.concat(annots), start, e);
    pending = [];
  }
}

const CLASS_HEAD = /\s*(?:(?:public|private|protected|internal|open|abstract|final|static|data|sealed)\s+)*class\s+([A-Za-z_]\w*)/y;
const KT_CTOR = /\s*(?:<[^>\n]{0,200}>\s*)?(?:(?:private|public|protected|internal)\s+)?(?:constructor\s*)?\(/y;
const BODY = /\s*(?:(?::|extends\b|implements\b)[^{};@\n]{0,300})?\{/y;

interface Head { name: string; line: number; argsAt: [number, number] | null; params: [number, number] | null; body: [number, number] | null }

/** Classes annotated `@<marker>`: the marker's argument span, Kotlin primary constructor and body; unclosed ones are skipped. */
function heads(src: Src, marker: RegExp, kotlin: boolean): Head[] {
  const { scan, pairs } = src;
  const out: Head[] = [];
  /** End of the last annotation run read; a marker inside it was already read, which keeps runs of markers linear. */
  let read = -1;
  for (const m of scan.matchAll(marker)) {
    if (m.index < read) continue;
    const annots: Annot[] = [];
    const paren = firstAt(scan, m.index + m[0].length, scan.length);
    const argsAt: [number, number] | null = scan[paren] === '(' && pairs[paren] > paren ? [paren, pairs[paren]] : null;
    const after = annotations(src, m.index, annots);
    if (after < 0) continue;
    read = after;
    CLASS_HEAD.lastIndex = after;
    const c = CLASS_HEAD.exec(scan);
    if (!c) continue;
    let i = CLASS_HEAD.lastIndex;
    let params: [number, number] | null = null;
    if (kotlin) {
      KT_CTOR.lastIndex = i;
      if (KT_CTOR.exec(scan)) {
        const open = KT_CTOR.lastIndex - 1;
        if (pairs[open] < open) continue;
        params = [open + 1, pairs[open]];
        i = pairs[open] + 1;
      }
    }
    BODY.lastIndex = i;
    let body: [number, number] | null = null;
    if (BODY.exec(scan)) {
      const open = BODY.lastIndex - 1;
      if (pairs[open] < open) continue;
      body = [open + 1, pairs[open]];
    } else if (!kotlin) continue;
    out.push({ name: c[1], line: lineOf(src, firstAt(scan, after, scan.length)), argsAt, params, body });
  }
  return out;
}

const KT_PROP = /((?:(?:private|public|protected|internal|override|open|lateinit|final|const|abstract)\s+)*)(val|var)\s+([A-Za-z_]\w*)\s*:\s*([\w.]+(?:<[^>\n]{0,200}>)?)(\?)?/y;
const JAVA_FIELD = /((?:(?:public|private|protected|final|static|transient|volatile)\s+)*)([\w.$]+(?:<[^>\n]{0,200}>)?(?:\[\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=|$)/y;
/** A getter on the line after a Kotlin property makes it computed (no backing column). */
const KT_GETTER = /\s*get\s*\(/y;
const JAVA_PRIMITIVES = new Set(['int', 'long', 'short', 'byte', 'boolean', 'float', 'double', 'char']);

/** Room `@Entity` classes: Kotlin constructor and body properties, Java fields; `primaryKeys`, `foreignKeys` and unique `indices` apply by column name. */
function room(src: Src, kotlin: boolean): Entity[] {
  const { code, scan, pairs } = src;
  const found = heads(src, /@Entity\b/g, kotlin);
  const tables = new Map<string, string>();
  const meta = found.map(h => {
    const span = h.argsAt && h.argsAt[1] - h.argsAt[0] <= MAX_ENTITY_ARGS ? h.argsAt : null;
    const args = span ? code.slice(span[0], span[1]) : '';
    const table = /\btableName\s*=\s*"([^"\n]*)"/.exec(args)?.[1] ?? h.name;
    tables.set(h.name, table);
    return { span, args, table };
  });
  return found.map((h, k) => {
    const { span, args, table } = meta[k];
    const pks = new Set<string>();
    const pkList = /\bprimaryKeys\s*=\s*(?:(?:\[|\{|arrayOf\s*\()([^\]})]*)|("[^"\n]*"))/.exec(args);
    if (pkList) for (const p of strs(pkList[1] ?? pkList[2])) pks.add(p);
    const fks = new Map<string, { table: string; field: string }>();
    const uniques = new Set<string>();
    if (span) {
      for (const m of scan.slice(span[0], span[1]).matchAll(/\b(ForeignKey|Index)\s*\(/g)) {
        const open = span[0] + m.index + m[0].length - 1;
        const close = pairs[open];
        if (close < open) continue;
        const a = argsOf(src, open, close);
        if (m[1] === 'Index') {
          const cols = a.kw.has('value') ? strs(a.kw.get('value')!) : a.pos.flatMap(strs);
          if (a.kw.get('unique') === 'true' && cols.length === 1) uniques.add(cols[0]);
          continue;
        }
        const target = /([A-Za-z_]\w*)\s*(?:::|\.)\s*class\b/.exec(a.kw.get('entity') ?? '')?.[1];
        const parents = strs(a.kw.get('parentColumns') ?? '');
        const children = strs(a.kw.get('childColumns') ?? '');
        if (target) children.forEach((c, i) => { if (parents[i]) fks.set(c, { table: tables.get(target) ?? target, field: parents[i] }); });
      }
    }
    const fields: Field[] = [];
    const add = (annots: Annot[], at: number, end: number): void => {
      if (annots.some(a => a.name === 'Ignore')) return;
      const slice = scan.slice(at, Math.min(end, at + MAX_ARGS));
      let name: string;
      let type: string;
      let required: boolean;
      if (kotlin) {
        KT_PROP.lastIndex = 0;
        const p = KT_PROP.exec(slice);
        const rest = slice.slice(KT_PROP.lastIndex);
        if (!p || /^\s*(?:get\b|\{|by\b)/.test(rest)) return;
        // A getter on the next line makes a property computed unless it has an initializer (then it keeps a backing field).
        KT_GETTER.lastIndex = end;
        if (!/^\s*=/.test(rest) && KT_GETTER.test(scan)) return;
        name = p[3]; type = p[4]; required = !p[5];
      } else {
        JAVA_FIELD.lastIndex = 0;
        const p = JAVA_FIELD.exec(slice);
        if (!p || /\b(?:static|transient)\b/.test(p[1])) return;
        name = p[3]; type = p[2];
        required = JAVA_PRIMITIVES.has(type) || annots.some(a => a.name === 'NonNull' || a.name === 'NotNull');
      }
      const col = annots.find(a => a.name === 'ColumnInfo');
      name = (col && /\bname\s*=\s*"([^"\n]*)"/.exec(col.args)?.[1]) || name;
      const f: Field = { name, type, line: lineOf(src, at) };
      if (annots.some(a => a.name === 'PrimaryKey') || pks.has(name)) f.pk = true;
      if (f.pk || required) f.required = true;
      if (uniques.has(name)) f.unique = true;
      const fk = fks.get(name);
      if (fk) f.fk = fk;
      fields.push(f);
    };
    if (h.params) for (const [s, e] of topLevelParts(scan, pairs, h.params[0], h.params[1])) members(src, s, e, add);
    if (h.body) members(src, h.body[0], h.body[1], add);
    return { name: h.name, table, orm: 'room', file: src.rel, line: h.line, fields };
  });
}

const SWIFT_PROP = /((?:(?:(?:private|public|internal|fileprivate)\(set\)|public|private|internal|fileprivate|open|final|static|class|lazy|weak|unowned|nonisolated)\s+)*)(var|let)\s+([A-Za-z_]\w*)\s*(?::\s*(\[[^\]\n]{0,200}\]|[\w.]+(?:<[^>\n]{0,200}>)?)\s*([?!])?)?/y;
const SWIFT_VALUES = new Set(('String Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64 Double Float Decimal Bool Date UUID Data URL '
  + 'Character CGFloat TimeInterval').split(' '));

/** Type of a Swift stored property without an annotation, from its literal default. */
function swiftInferred(code: string): string {
  const v = /^=\s*(.{0,100})/.exec(code)?.[1].trim() ?? '';
  if (/^-?\d+$/.test(v)) return 'Int';
  if (/^-?\d*\.\d+$/.test(v)) return 'Double';
  if (v.startsWith('"')) return 'String';
  if (/^(?:true|false)\b/.test(v)) return 'Bool';
  return /^([A-Z]\w*)\s*\(/.exec(v)?.[1] ?? '';
}

/** SwiftData `@Model` classes: stored `var` and `let` properties; computed, static and `@Transient` ones are skipped. */
function swiftData(src: Src): Entity[] {
  const found = heads(src, /@Model\b/g, false);
  const models = new Set(found.map(h => h.name));
  return found.map(h => {
    const fields: Field[] = [];
    members(src, h.body![0], h.body![1], (annots, at, end) => {
      if (annots.some(a => a.name === 'Transient')) return;
      const slice = src.scan.slice(at, Math.min(end, at + MAX_ARGS));
      SWIFT_PROP.lastIndex = 0;
      const p = SWIFT_PROP.exec(slice);
      if (!p || /\b(?:static|class)\b/.test(p[1])) return;
      const rest = slice.slice(SWIFT_PROP.lastIndex).trimStart();
      if (rest.startsWith('{') && !/^\{\s*(?:willSet|didSet)\b/.test(rest)) return;
      const type = p[4] ?? swiftInferred(src.code.slice(at + SWIFT_PROP.lastIndex, end).trimStart());
      const generic = /^(Array|Set|Optional)\s*<\s*([\w.]+)\s*>$/.exec(type);
      const arr = /^\[\s*([\w.]+)\s*\]$/.exec(type) ?? (generic && generic[1] !== 'Optional' ? [generic[0], generic[2]] : null);
      const optional = !!p[5] || generic?.[1] === 'Optional';
      const elem = arr ? arr[1] : generic ? generic[2] : type.replace(/<.*$/, '');
      const f: Field = { name: p[3], type, line: lineOf(src, at) };
      // A property of a non-value type (a class, or an enum the pattern cannot tell apart) is a relation, wherever the type is defined.
      const relation = annots.some(a => a.name === 'Relationship') || models.has(elem) || (/^[A-Z][\w.]*$/.test(elem) && !SWIFT_VALUES.has(elem));
      if (annots.some(a => a.name === 'Attribute' && /\.unique\b/.test(a.args))) f.unique = true;
      if (relation) f.relation = { model: elem, many: !!arr };
      else if (!optional) f.required = true;
      fields.push(f);
    });
    return { name: h.name, table: h.name, orm: 'swiftdata', file: src.rel, line: h.line, fields };
  });
}

/** Entities from Room `@Entity` classes (Kotlin, Java) and SwiftData `@Model` classes (Swift). */
export const schemaMobile: Analyzer = {
  name: 'schema-mobile',
  applies: (_rel, lang) => lang === 'kotlin' || lang === 'java' || lang === 'swift',
  run(rel, lang, text) {
    if (lang === 'swift') {
      if (!text.includes('@Model') || !text.includes('SwiftData')) return {};
      return { entities: onePerName(swiftData(scanned(rel, lang, text))) };
    }
    if (!text.includes('@Entity') || !/\bandroid(?:x\.room|\.arch\.persistence\.room)\b/.test(text)) return {};
    return { entities: onePerName(room(scanned(rel, lang, text), lang === 'kotlin')) };
  },
};
