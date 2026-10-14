import type { Entity, Field } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { argsOf, callAt, isOpenBracket as isOpen, lineAt, onePerName, scanned, type Args, type Scanned as Src } from './util.js';

/** Longest statement value or annotation text read; real ones are short, and the cap keeps hostile input linear. */
const MAX_ARGS = 500;
/** How far base classes are followed; real hierarchies are a few levels deep. */
const MAX_DEPTH = 32;
/** Fields copied from mixins and abstract parents per file; a hostile file cannot make inheritance quadratic. */
const MAX_COPIES = 50_000;

const lineOf = (src: Src, i: number): number => lineAt(src.text, i);
const lastName = (s: string): string => s.match(/[A-Za-z_]\w*/g)?.pop() ?? s;

/** `parents`: the in-file classes its bases name, each the nearest definition before it (set by `python`). */
interface PyClass { name: string; at: number; indent: number; bases: string[]; kw: Map<string, string>; bodyIndent: number; stmts: number[]; inner: PyClass[]; parents: PyClass[] }
/** A class-level statement: `name`, `name: ann`, `name = value` or `name: ann = value`; offsets index the file. */
interface PyStmt { name: string; at: number; ann?: string; value?: number; end: number }

const PY_CLASS = /[ \t]*class[ \t]+([A-Za-z_]\w*)[ \t]*/y;
const PY_COLON = /[ \t]*:/y;
const PY_NAME = /([A-Za-z_]\w*)[ \t]*/y;
const PY_KEYWORDS = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'return', 'async', 'match', 'case', 'lambda']);

/**
 * Classes of a Python file in one linear pass over its lines. A body ends at the first non-blank line indented no
 * deeper than its class line; lines inside a bracket group (continuations) never end a body. Each class keeps the
 * starts of its direct statements and its directly nested classes. Classes nested in functions are listed as top-level.
 */
function pyClasses(src: Src): PyClass[] {
  const { scan, pairs } = src;
  const n = scan.length;
  const out: PyClass[] = [];
  const stack: PyClass[] = [];
  const closes: number[] = [];
  for (let ls = 0; ls < n;) {
    let eol = scan.indexOf('\n', ls);
    if (eol === -1) eol = n;
    let k = ls;
    while (k < eol && (scan[k] === ' ' || scan[k] === '\t')) k++;
    if (!closes.length && k < eol && scan[k] !== '\r') {
      const indent = k - ls;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const top = stack[stack.length - 1];
      if (top) {
        if (top.bodyIndent < 0) top.bodyIndent = indent;
        if (indent === top.bodyIndent) top.stmts.push(k);
      }
      const cls = pyHeader(src, ls, k, indent);
      if (cls) {
        if (!top) out.push(cls);
        else if (indent === top.bodyIndent) top.inner.push(cls);
        stack.push(cls);
      }
    }
    for (let j = ls; j < eol; j++) {
      const c = scan.charCodeAt(j);
      if (isOpen(c) && pairs[j] > j) closes.push(pairs[j]);
      else if (closes.length && closes[closes.length - 1] === j) closes.pop();
    }
    ls = eol + 1;
  }
  return out;
}

/** `class Name(bases, kw=v):` starting at line `ls`; null when it is not a well-formed header. */
function pyHeader(src: Src, ls: number, at: number, indent: number): PyClass | null {
  PY_CLASS.lastIndex = ls;
  const m = PY_CLASS.exec(src.scan);
  if (!m) return null;
  let after = PY_CLASS.lastIndex;
  let args: Args = { pos: [], kw: new Map() };
  if (src.scan[after] === '(') {
    const close = src.pairs[after];
    if (close < after) return null;
    args = argsOf(src, after, close);
    after = close + 1;
  }
  PY_COLON.lastIndex = after;
  if (!PY_COLON.test(src.scan)) return null;
  const bases = args.pos.map(b => b.replace(/\s+/g, ''));
  return { name: m[1], at, indent, bases, kw: args.kw, bodyIndent: -1, stmts: [], inner: [], parents: [] };
}

function pyStmt(src: Src, at: number): PyStmt | null {
  const { scan, pairs } = src;
  let end = at;
  for (; end < scan.length && scan[end] !== '\n'; end++) if (isOpen(scan.charCodeAt(end)) && pairs[end] > end) end = pairs[end];
  PY_NAME.lastIndex = at;
  const m = PY_NAME.exec(scan);
  if (!m || PY_KEYWORDS.has(m[1])) return null;
  let i = PY_NAME.lastIndex;
  let ann: string | undefined;
  if (scan[i] === ':') {
    let j = i + 1;
    for (; j < end && scan[j] !== '='; j++) if (isOpen(scan.charCodeAt(j)) && pairs[j] > j && pairs[j] < end) j = pairs[j];
    ann = src.code.slice(i + 1, Math.min(j, i + 1 + MAX_ARGS)).trim();
    i = j;
  }
  if (scan[i] === '=' && scan[i + 1] !== '=') return { name: m[1], at, ann, value: i + 1, end };
  return ann === undefined ? null : { name: m[1], at, ann, end };
}

/** Value of a Python string literal (with `r`/`b`/`u` prefixes), or null. */
function pyStr(v: string | undefined): string | null {
  const m = v === undefined ? null : /^[rRbBuU]{0,2}(['"])([^'"\n]*)\1$/.exec(v.trim());
  return m ? m[2] : null;
}

/** An annotation with `Mapped[...]`, quotes and `Optional`/`| None` removed; `many` for list-like types, `model` their element. */
interface PyType { type: string; optional: boolean; many: boolean; model: string }
function pyType(ann: string): PyType {
  let t = ann.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
  const mapped = /^(?:\w+\.)?Mapped ?\[(.*)\]$/.exec(t);
  if (mapped) t = mapped[1].trim();
  let optional = false;
  const opt = /^(?:typing\.)?Optional ?\[(.*)\]$/.exec(t);
  if (opt) { t = opt[1].trim(); optional = true; }
  else if (/\| ?None$/.test(t) || /^None ?\|/.test(t)) { t = t.replace(/ ?\| ?None$/, '').replace(/^None ?\| ?/, ''); optional = true; }
  const list = /^(?:typing\.)?(?:list|List|set|Set|Sequence|frozenset|FrozenSet|tuple|Tuple) ?\[(.*)\]$/.exec(t);
  return { type: t, optional, many: !!list, model: lastName(list ? list[1].split(',')[0] : t) };
}

const isTrue = (v: string | undefined): boolean => v === 'True';
const snake = (name: string): string => name.replace(/([a-z\d])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();

/** `ForeignKey('users.id')`, `ForeignKey(User.id)`, `ForeignKey(users.c.id)` as a table and field. */
function sqlaFk(arg: string, tables: Map<string, string>): { table: string; field: string } | null {
  const s = pyStr(arg);
  const parts = (s ?? arg).split('.').map(p => p.trim());
  if (parts.length < 2) return null;
  const field = parts.pop()!;
  if (s === null && parts[parts.length - 1] === 'c') parts.pop();
  const name = parts[parts.length - 1];
  return { table: s !== null ? name : tables.get(name) ?? name.toLowerCase(), field };
}
const FOREIGN_KEY = /^(?:\w+\.){0,3}ForeignKey\s*\(\s*([^,)]*)/;
const ANY_FOREIGN_KEY = /\bForeignKey\s*\(\s*([^,)]*)/g;

type Kind = 'sqlalchemy' | 'sqlmodel' | 'django';

interface PyCtx {
  src: Src;
  /** Class name to table, for entities of this file. */
  tables: Map<string, string>;
  /** Primary key field name of the in-file Django model `name`. */
  pk(name: string): string | undefined;
  /** Whether the in-file class `name` (or a mixin of it) has a foreign key to `table`. */
  pointsAt(name: string, table: string): boolean;
}

function sqlaField(ctx: PyCtx, st: PyStmt, f: Field, table: string): Field | null {
  if (st.name.startsWith('__')) return null;
  const call = st.value !== undefined ? callAt(ctx.src, st.value, st.end) : null;
  const mapped = st.ann !== undefined && /^(?:\w+\.)?Mapped\s*\[/.test(st.ann);
  const t = st.ann !== undefined ? pyType(st.ann) : null;
  if (call?.name === 'relationship') {
    const target = call.pos[0] ? lastName(pyStr(call.pos[0]) ?? call.pos[0]) : t?.model;
    if (!target) return null;
    const uselist = call.kw.get('uselist');
    // Without `uselist`, a list annotation or `secondary`, SQLAlchemy reads the direction from the foreign key: one-to-many when the
    // target points here, unless `remote_side` marks a self-reference as many-to-one.
    const many = uselist !== undefined ? isTrue(uselist) : t ? t.many
      : call.kw.has('secondary') || (!call.kw.has('remote_side') && ctx.pointsAt(target, table));
    f.type = t ? t.type : target + (many ? '[]' : '');
    f.relation = { model: target, many };
    return f;
  }
  const column = call?.name === 'Column' || call?.name === 'mapped_column';
  if (!column && !(mapped && st.value === undefined)) return null;
  const kw = call?.kw ?? new Map<string, string>();
  let pos = call?.pos ?? [];
  const rename = pyStr(pos[0]);
  if (rename !== null) { f.name = rename; pos = pos.slice(1); }
  for (const p of pos) {
    const fk = FOREIGN_KEY.exec(p);
    if (fk) { const r = sqlaFk(fk[1], ctx.tables); if (r) f.fk = r; continue; }
    if (!f.type) f.type = /^(?:\w+\.){0,3}([A-Za-z_]\w*)/.exec(p)?.[1] ?? '';
  }
  if (mapped && t) f.type = t.type;
  const nullable = kw.get('nullable');
  if (isTrue(kw.get('primary_key'))) f.pk = true;
  if (isTrue(kw.get('unique'))) f.unique = true;
  if (f.pk || nullable === 'False' || (nullable === undefined && mapped && !t?.optional)) f.required = true;
  return f;
}

function sqlmodelField(ctx: PyCtx, st: PyStmt, f: Field): Field | null {
  if (st.ann === undefined || st.name.startsWith('__') || st.name === 'model_config' || /^(?:typing\.)?ClassVar\b/.test(st.ann)) return null;
  const t = pyType(st.ann);
  f.type = t.type;
  const call = st.value !== undefined ? callAt(ctx.src, st.value, st.end) : null;
  if (call?.name === 'Relationship') { f.relation = { model: t.model, many: t.many }; return f; }
  const kw = call?.name === 'Field' ? call.kw : new Map<string, string>();
  const nullable = kw.get('nullable');
  if (isTrue(kw.get('primary_key'))) f.pk = true;
  if (isTrue(kw.get('unique'))) f.unique = true;
  const fk = pyStr(kw.get('foreign_key'));
  if (fk && fk.includes('.')) f.fk = { table: fk.slice(0, fk.lastIndexOf('.')), field: fk.slice(fk.lastIndexOf('.') + 1) };
  if (f.pk || nullable === 'False' || (nullable === undefined && !t.optional)) f.required = true;
  return f;
}

const DJANGO_RELATIONS = new Set(['ForeignKey', 'OneToOneField', 'ManyToManyField']);

function djangoField(ctx: PyCtx, cls: PyClass, st: PyStmt, f: Field): Field | null {
  const call = st.value !== undefined ? callAt(ctx.src, st.value, st.end) : null;
  if (!call || !(call.name.endsWith('Field') || call.name === 'ForeignKey')) return null;
  f.type = call.name;
  const nullable = isTrue(call.kw.get('null'));
  if (isTrue(call.kw.get('primary_key'))) f.pk = true;
  if (isTrue(call.kw.get('unique'))) f.unique = true;
  if (!DJANGO_RELATIONS.has(call.name)) {
    if (f.pk || !nullable) f.required = true;
    return f;
  }
  const to = call.pos[0] ?? call.kw.get('to');
  if (!to) return null;
  const s = pyStr(to);
  let model: string;
  let table: string;
  if (s === null && /AUTH_USER_MODEL$/.test(to)) { model = 'User'; table = 'auth_user'; }
  else {
    const ref = s ?? to;
    model = s === 'self' ? cls.name : lastName(ref);
    const app = s !== null && s.includes('.') ? s.slice(0, s.indexOf('.')).toLowerCase() : '';
    table = ctx.tables.get(model) ?? (app ? `${app}_${model.toLowerCase()}` : model.toLowerCase());
  }
  const many = call.name === 'ManyToManyField';
  f.relation = { model, many };
  if (many) return f;
  if (call.name === 'OneToOneField') f.unique = true;
  f.fk = { table, field: pyStr(call.kw.get('to_field')) ?? ctx.pk(model) ?? 'id' };
  if (!nullable) f.required = true;
  return f;
}

/** The app label of a Django models file: the directory holding `models.py`, or the parent of a `models/` directory. */
function djangoApp(rel: string): string {
  const dirs = rel.split('/');
  const file = dirs.pop();
  if (file === 'models.py') return (dirs.pop() ?? '').toLowerCase();
  const i = dirs.lastIndexOf('models');
  return i > 0 ? dirs[i - 1].toLowerCase() : '';
}
const isDjangoPath = (rel: string): boolean => /(?:^|\/)models\.py$/.test(rel) || rel.split('/').slice(0, -1).includes('models');

const SQLA_BASES = new Set(['Base', 'DeclarativeBase', 'DeclarativeBaseNoMeta']);
const DJANGO_IMPORT = /^[ \t]*from[ \t]+django\.db\.models[ \t]+import[ \t]*/gm;
const DECL_VAR = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]{0,200})?=[ \t]*(?:[\w.]*declarative_base\b|registry\(\)\.generate_base\b|\w+\.Model\b)/gm;

/** SQLAlchemy (classic and `Mapped`), SQLModel (`table=True`) and Django model classes of a Python file. */
function python(src: Src): Entity[] {
  const classes = pyClasses(src);
  // A base name means the nearest class of that name defined before (Python binds names in order); every memo below is per class object.
  const defined = new Map<string, PyClass>();
  for (const c of classes) {
    c.parents = c.bases.map(b => defined.get(b)).filter((p): p is PyClass => !!p);
    defined.set(c.name, c);
  }
  const decl = new Set(SQLA_BASES);
  for (const m of src.scan.matchAll(DECL_VAR)) decl.add(m[1]);
  const djangoPath = isDjangoPath(src.rel);
  // A parenthesized import list ends at its bracket pair, so unclosed lists cost one line each.
  const djangoModel = [...src.scan.matchAll(DJANGO_IMPORT)].some(m => {
    const at = m.index + m[0].length;
    const close = src.scan[at] === '(' ? src.pairs[at] : -1;
    let end = close > at ? close : src.scan.indexOf('\n', at);
    if (end === -1) end = src.scan.length;
    return /\bModel\b/.test(src.code.slice(at, Math.min(end, at + MAX_ARGS * 4)));
  });

  const stmtMemo = new Map<PyClass, PyStmt[]>();
  const stmts = (c: PyClass): PyStmt[] => {
    let list = stmtMemo.get(c);
    if (!list) { list = c.stmts.map(at => pyStmt(src, at)).filter((s): s is PyStmt => !!s); stmtMemo.set(c, list); }
    return list;
  };
  const value = (st: PyStmt | undefined): string | undefined => st?.value === undefined ? undefined : src.code.slice(st.value, Math.min(st.end, st.value + MAX_ARGS)).trim();
  const stmt = (c: PyClass, name: string): PyStmt | undefined => { let r: PyStmt | undefined; for (const s of stmts(c)) if (s.name === name) r = s; return r; };

  /** Whether a base of `c` passes `test`, following in-file parents; memoized per test, so each class is resolved once. */
  const derives = (c: PyClass, memo: Map<PyClass, boolean>, test: (b: string) => boolean, depth = 0): boolean => {
    const hit = memo.get(c);
    if (hit !== undefined) return hit;
    memo.set(c, false);
    const r = c.bases.some(test) || (depth < MAX_DEPTH && c.parents.some(p => derives(p, memo, test, depth + 1)));
    memo.set(c, r);
    return r;
  };
  const sqlModelMemo = new Map<PyClass, boolean>();
  const djangoMemo = new Map<PyClass, boolean>();
  const declMemo = new Map<PyClass, boolean>();
  const isSqlModel = (b: string): boolean => b === 'SQLModel' || b.endsWith('.SQLModel');
  const isDjango = (b: string): boolean => b === 'models.Model' || (b === 'Model' && djangoModel) || /(?:^|\.)Abstract(?:Base)?User$/.test(b);
  const isDecl = (b: string): boolean => decl.has(b) || (b.endsWith('.Model') && b !== 'models.Model');
  const meta = (c: PyClass): PyClass | undefined => { let r: PyClass | undefined; for (const i of c.inner) if (i.name === 'Meta') r = i; return r; };

  /** Single-table inheritance: a mapped subclass without `__tablename__` adds its columns to its nearest entity ancestor. */
  const stiRoot = new Map<PyClass, PyClass>();
  const kindMemo = new Map<PyClass, Kind | null>();
  const kindOf = (c: PyClass): Kind | null => {
    const hit = kindMemo.get(c);
    if (hit !== undefined) return hit;
    kindMemo.set(c, null);
    let kind: Kind | null = null;
    if (derives(c, sqlModelMemo, isSqlModel)) kind = isTrue(c.kw.get('table')) ? 'sqlmodel' : null;
    else if (djangoPath && derives(c, djangoMemo, isDjango)) {
      const m = meta(c);
      kind = m && (isTrue(value(stmt(m, 'abstract'))) || isTrue(value(stmt(m, 'proxy')))) ? null : 'django';
    } else if (!isTrue(value(stmt(c, '__abstract__')))) {
      if (pyStr(value(stmt(c, '__tablename__'))) !== null) kind = 'sqlalchemy';
      else {
        let root: PyClass | undefined;
        for (const p of c.parents) { root = kindOf(p) === 'sqlalchemy' ? p : stiRoot.get(p); if (root) break; }
        // A subclass with its own primary key column is joined inheritance: its own table, named after the class.
        const ownPk = (): boolean => stmts(c).some(s => /\bprimary_key\s*=\s*True\b/.test(value(s) ?? ''));
        if (root && !ownPk()) stiRoot.set(c, root);
        else if (root) kind = 'sqlalchemy';
        else if (derives(c, declMemo, isDecl) && stmts(c).some(s => /^(?:\w+\.)?Mapped\s*\[/.test(s.ann ?? '') || /^(?:\w+\.){0,3}(?:Column|mapped_column)\s*\(/.test(value(s) ?? ''))) kind = 'sqlalchemy';
      }
    }
    kindMemo.set(c, kind);
    return kind;
  };

  /** In-file parents that are neither entities nor merged subclasses (mixins, abstract models, SQLModel bases), farthest first. */
  const ancestors = (cls: PyClass): PyClass[] => {
    const out: PyClass[] = [];
    const seen = new Set<PyClass>([cls]);
    const visit = (c: PyClass, depth: number): void => {
      for (const p of c.parents) {
        if (seen.has(p) || kindOf(p) || stiRoot.has(p) || depth >= MAX_DEPTH || seen.size > MAX_DEPTH) continue;
        seen.add(p);
        visit(p, depth + 1);
        out.push(p);
      }
    };
    visit(cls, 0);
    return out;
  };

  // Per-class facts are memoized and combined over at most MAX_DEPTH ancestors, so a large shared mixin is read once.
  const ownPk = new Map<PyClass, string | null>();
  const pkOf = (c: PyClass): string | null => {
    let r = ownPk.get(c);
    if (r === undefined) { r = stmts(c).find(s => /\bprimary_key\s*=\s*True\b/.test(value(s) ?? ''))?.name ?? null; ownPk.set(c, r); }
    return r;
  };
  const ownFks = new Map<PyClass, Set<string>>();
  const fksOf = (c: PyClass): Set<string> => {
    let r = ownFks.get(c);
    if (!r) {
      r = new Set();
      for (const st of stmts(c)) for (const m of (value(st) ?? '').matchAll(ANY_FOREIGN_KEY)) { const fk = sqlaFk(m[1], ctx.tables); if (fk) r.add(fk.table); }
      ownFks.set(c, r);
    }
    return r;
  };
  const ctx: PyCtx = {
    src,
    tables: new Map(),
    pk: name => { const c = defined.get(name); return c && kindOf(c) === 'django' ? [...ancestors(c), c].map(pkOf).find(p => p !== null) ?? 'id' : undefined; },
    pointsAt: (name, table) => { const c = defined.get(name); return !!c && [...ancestors(c), c].some(a => fksOf(a).has(table)); },
  };
  const app = djangoApp(src.rel);
  const tableOf = new Map<PyClass, string>();
  for (const cls of classes) {
    const kind = kindOf(cls);
    if (!kind) continue;
    let table: string;
    if (kind === 'django') {
      const m = meta(cls);
      table = pyStr(value(m && stmt(m, 'db_table'))) ?? (app ? `${app}_${cls.name.toLowerCase()}` : cls.name.toLowerCase());
    } else {
      table = pyStr(value(stmt(cls, '__tablename__'))) ?? (kind === 'sqlmodel' ? cls.name.toLowerCase() : snake(cls.name));
    }
    tableOf.set(cls, table);
    ctx.tables.set(cls.name, table);
  }

  const fieldMemo = new Map<PyClass, Map<PyClass, Field[]>>();
  /** Fields declared in `c` itself, read for the entity `owner` (Django `'self'` and SQLAlchemy relationship direction depend on it). */
  const ownFields = (c: PyClass, owner: PyClass, kind: Kind, table: string): Field[] => {
    let byOwner = fieldMemo.get(c);
    if (!byOwner) { byOwner = new Map(); fieldMemo.set(c, byOwner); }
    let list = byOwner.get(owner);
    if (list) return list;
    list = [];
    for (const st of stmts(c)) {
      const f: Field = { name: st.name, type: '', line: lineOf(src, st.at) };
      const r = kind === 'sqlalchemy' ? sqlaField(ctx, st, f, table) : kind === 'sqlmodel' ? sqlmodelField(ctx, st, f) : djangoField(ctx, owner, st, f);
      if (r) list.push(r);
    }
    byOwner.set(owner, list);
    return list;
  };

  let copies = 0;
  const out: Entity[] = [];
  const built = new Map<PyClass, { fields: Field[]; index: Map<string, number> }>();
  /** Adds the fields of `cls` and its non-entity ancestors to `into`, later names replacing earlier ones in place. */
  const collect = (cls: PyClass, owner: PyClass, kind: Kind, table: string, into: { fields: Field[]; index: Map<string, number> }): void => {
    for (const c of [...ancestors(cls), cls]) {
      if (c !== owner && copies > MAX_COPIES) continue;
      const own = ownFields(c, owner, kind, table);
      if (c !== owner) copies += own.length;
      for (const f of own) {
        const i = into.index.get(f.name);
        if (i === undefined) { into.index.set(f.name, into.fields.length); into.fields.push({ ...f }); } else into.fields[i] = { ...f };
      }
    }
  };
  for (const cls of classes) {
    const kind = kindOf(cls);
    const root = stiRoot.get(cls);
    if (root) {
      const into = built.get(root);
      if (into) collect(cls, cls, 'sqlalchemy', tableOf.get(root)!, into);
      continue;
    }
    if (!kind) continue;
    const table = tableOf.get(cls)!;
    const into = { fields: [] as Field[], index: new Map<string, number>() };
    collect(cls, cls, kind, table, into);
    built.set(cls, into);
    const line = lineOf(src, cls.at);
    if (kind === 'django' && !into.fields.some(f => f.pk)) into.fields.unshift({ name: 'id', type: 'AutoField', line, pk: true, required: true });
    out.push({ name: cls.name, table, orm: kind, file: src.rel, line, fields: into.fields });
  }
  return out;
}

/** Entities from SQLAlchemy (classic and `Mapped`), SQLModel and Django model classes. */
export const schemaPy: Analyzer = {
  name: 'schema-py',
  applies: (_rel, lang) => lang === 'python',
  run(rel, lang, text) {
    if (!text.includes('class') || !(/__tablename__|Column|Mapped|SQLModel/.test(text) || isDjangoPath(rel))) return {};
    return { entities: onePerName(python(scanned(rel, lang, text))) };
  },
};
