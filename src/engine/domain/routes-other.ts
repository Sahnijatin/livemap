import type { Lang, Mount, Route } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { blankStrings, bracketPairs, handlerOf, lineAt, maskCommentsAndStrings, normPath, quotingOf, resetScanBudget, scanBudget, splitArgs, type Quoting } from './util.js';

type MountFact = Omit<Mount, 'target'>;
interface Facts { routes: Route[]; mounts: MountFact[] }
/** A file ready for matching: `code` has comments blanked, `scan` also has string bodies blanked (same offsets), `pairs` matches its brackets. */
interface Src { code: string; scan: string; q: Quoting; pairs: Int32Array }

/** Arguments of the call whose bracket is at `open` (or, in `line` mode, of a Ruby call starting there). */
const split = (src: Src, open: number, line = false): { args: string[]; end: number } => splitArgs(src.code, open, src.q, { line, pairs: src.pairs });

const ID = '[A-Za-z_]\\w*';
const GO_INLINE = /^func\b/;

/** The value of a single string literal (Python `r''` / `b''` prefixes allowed), or null. */
function str(arg: string | undefined): string | null {
  const m = arg ? /^[rRbBuU]{0,2}(['"`])/.exec(arg) : null;
  if (!m || !arg || arg.length < m[0].length + 1 || arg[arg.length - 1] !== m[1]) return null;
  const body = arg.slice(m[0].length, -1);
  return body.includes(m[1]) || body.includes('\n') ? null : body;
}
const strs = (text: string): string[] => [...text.matchAll(/(['"])([^'"\n]*)\1/g)].map(m => m[2]);
/** Value of a `key = value` argument (Python, Java and Kotlin named arguments). */
function kwarg(args: string[], key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*`);
  const a = args.find(x => re.test(x));
  return a === undefined ? undefined : a.replace(re, '');
}
const isPath = (p: string | null): p is string => p !== null && (p === '' || p.startsWith('/'));
/** A raw (regex) route pattern as a path: leading slash, no duplicate or trailing slash, parameters untouched. */
const rawPath = (p: string): string => { const t = ('/' + p).replace(/\/{2,}/g, '/'); return t.length > 1 ? t.replace(/\/$/, '') : t; };
const singular = (w: string): string =>
  w.endsWith('ies') ? w.slice(0, -3) + 'y' : /(?:ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

function route(out: Facts, src: Src, method: string, path: string, handler: string | undefined, index: number, framework: string): void {
  const r: Route = { method, path, line: lineAt(src.code, index), kind: 'api', framework };
  if (handler) r.handler = handler;
  out.routes.push(r);
}

// ---------------------------------------------------------------- Python: FastAPI, Flask, Django

interface PyImports { from: Map<string, { mod: string; name: string }>; mods: Map<string, string>; fw: Set<string> }

function pyImports(src: Src): PyImports {
  const out: PyImports = { from: new Map(), mods: new Map(), fw: new Set() };
  const note = (mod: string): void => { const top = mod.split('.')[0]; if (top === 'fastapi' || top === 'flask') out.fw.add(top); };
  for (const m of src.scan.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]*/gm)) {
    if (scanBudget() <= 0) break;
    const at = m.index + m[0].length;
    note(m[1]);
    let names: string[];
    if (src.scan[at] === '(') names = split(src, at).args;
    else { const eol = src.scan.indexOf('\n', at); names = src.scan.slice(at, eol === -1 ? undefined : eol).split(','); }
    for (const n of names) {
      const p = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(n.trim());
      if (p) out.from.set(p[2] ?? p[1], { mod: m[1], name: p[1] });
    }
  }
  for (const m of src.scan.matchAll(/^[ \t]*import[ \t]+([^\n]*)/gm)) {
    for (const part of m[1].split(',')) {
      const p = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
      if (!p) continue;
      out.mods.set(p[2] ?? p[1], p[1]);
      note(p[1]);
    }
  }
  return out;
}

/** The dotted module a mounted router came from; relative imports keep their leading dots. */
function pySpec(arg: string | undefined, imp: PyImports): string | null {
  if (!arg || !new RegExp(`^${ID}(?:\\s*\\.\\s*${ID})*$`).test(arg)) return null;
  const parts = arg.split('.').map(s => s.trim());
  const f = imp.from.get(parts[0]);
  if (f) return parts.length === 1 ? f.mod : f.mod.endsWith('.') ? f.mod + f.name : `${f.mod}.${f.name}`;
  for (let k = parts.length - 1; k >= 1; k--) {
    const mod = imp.mods.get(parts.slice(0, k).join('.'));
    if (mod) return [mod, ...parts.slice(k, -1)].join('.');
  }
  return null;
}

const PY_DECO = /\s*@[\w.]+\s*/y;
const PY_DEF = /\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/y;

/** Name of the function under a decorator ending at `i`, skipping further decorators. */
function pyDef(src: Src, i: number): string | undefined {
  for (let guard = 0; guard < 16; guard++) {
    PY_DECO.lastIndex = i;
    if (!PY_DECO.exec(src.scan)) break;
    i = PY_DECO.lastIndex;
    if (src.scan[i] === '(') i = split(src, i).end;
  }
  PY_DEF.lastIndex = i;
  return PY_DEF.exec(src.scan)?.[1];
}

const PY_CTOR = /^[ \t]*([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=[ \t]*(?:(?:fastapi|flask)[ \t]*\.[ \t]*)?(FastAPI|APIRouter|Flask|Blueprint)[ \t]*\(/gm;
const PY_ROUTE = /^[ \t]*@[ \t]*([A-Za-z_]\w*)[ \t]*\.[ \t]*(get|post|put|patch|delete|options|head|trace|route|api_route)[ \t]*\(/gm;
const PY_MOUNT = /(?<![\w.])([A-Za-z_]\w*)[ \t]*\.[ \t]*(include_router|register_blueprint)[ \t]*\(/g;

/** FastAPI and Flask decorators, router prefixes and mounts. A receiver counts when built here or when the file imports the framework. */
function python(src: Src, out: Facts): void {
  const imp = pyImports(src);
  const fileFw = imp.fw.has('fastapi') ? 'fastapi' : imp.fw.has('flask') ? 'flask' : null;
  const recv = new Map<string, { fw: string; prefix: string }>();
  for (const m of src.scan.matchAll(PY_CTOR)) {
    if (scanBudget() <= 0) break;
    const fw = m[2] === 'FastAPI' || m[2] === 'APIRouter' ? 'fastapi' : 'flask';
    const { args } = split(src, m.index + m[0].length - 1);
    const prefix = str(kwarg(args, fw === 'fastapi' ? 'prefix' : 'url_prefix')) ?? '';
    recv.set(m[1], { fw, prefix });
  }
  for (const m of src.scan.matchAll(PY_ROUTE)) {
    if (scanBudget() <= 0) break;
    const r = recv.get(m[1]) ?? (fileFw ? { fw: fileFw, prefix: '' } : null);
    const verb = m[2];
    if (!r || (verb === 'route' && r.fw !== 'flask') || (verb === 'api_route' && r.fw !== 'fastapi')) continue;
    const { args, end } = split(src, m.index + m[0].length - 1);
    const path = str(args[0]);
    if (!isPath(path)) continue;
    const listed = kwarg(args, 'methods');
    const methods = verb === 'route' || verb === 'api_route' ? (listed ? strs(listed).map(x => x.toUpperCase()) : ['GET']) : [verb.toUpperCase()];
    const handler = pyDef(src, end);
    for (const method of methods) route(out, src, method, normPath(r.prefix + '/' + path), handler, m.index, r.fw);
  }
  for (const m of src.scan.matchAll(PY_MOUNT)) {
    if (scanBudget() <= 0) break;
    const fw = m[2] === 'include_router' ? 'fastapi' : 'flask';
    const { args } = split(src, m.index + m[0].length - 1);
    const spec = pySpec(args[0], imp);
    if (!spec) continue;
    const prefix = str(kwarg(args, fw === 'fastapi' ? 'prefix' : 'url_prefix')) ?? '';
    out.mounts.push({ prefix: normPath((recv.get(m[1])?.prefix ?? '') + '/' + prefix), spec, line: lineAt(src.code, m.index), framework: fw });
  }
}

const DJ_CALL = /(?<![\w.])(path|re_path|url)[ \t]*\(/g;
const DJ_INCLUDE = /^include\s*\(\s*(?:\(\s*)?(['"])([^'"\n]+)\1/;

/** Django `path()` / `re_path()` entries of a urls.py; `include('x.urls')` becomes a mount. */
function django(src: Src, out: Facts): void {
  for (const m of src.scan.matchAll(DJ_CALL)) {
    if (scanBudget() <= 0) break;
    const { args } = split(src, m.index + m[0].length - 1);
    const pattern = str(args[0]);
    if (pattern === null || !args[1]) continue;
    const path = m[1] === 'path' ? normPath(pattern) : rawPath(pattern.replace(/^\^/, '').replace(/\$$/, ''));
    const inc = DJ_INCLUDE.exec(args[1]);
    if (inc) { out.mounts.push({ prefix: path, spec: inc[2], line: lineAt(src.code, m.index), framework: 'django' }); continue; }
    if (/^include\b/.test(args[1])) continue;
    route(out, src, 'ANY', path, handlerOf([args[1].replace(/\s*\.\s*as_view\s*\([^)]*\)$/, '')], /^lambda\b/), m.index, 'django');
  }
}

// ---------------------------------------------------------------- Go: net/http, gin, chi

const GO_CALL = /(?:(?<!\w)([A-Za-z_]\w*)|\))\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle|HandleFunc|Get|Post|Put|Patch|Delete|Head|Options|Connect|Trace|Method|MethodFunc|Route)\s*\(/g;
const GO_GIN_NEW = new RegExp(`(${ID})\\s*(?::=|=|:)\\s*gin\\s*\\.\\s*(?:Default|New)\\s*\\(|(${ID})\\s+\\*\\s*gin\\s*\\.\\s*(?:Engine|RouterGroup)\\b`, 'g');
const GO_CHI_NEW = new RegExp(`(${ID})\\s*(?::=|=|:)\\s*chi\\s*\\.\\s*(?:NewRouter|NewMux)\\s*\\(|(${ID})\\s+\\*?\\s*chi\\s*\\.\\s*(?:Router|Mux)\\b`, 'g');
const GO_MUX_NEW = new RegExp(`(${ID})\\s*(?::=|=|:)\\s*http\\s*\\.\\s*NewServeMux\\s*\\(|(${ID})\\s+\\*?\\s*http\\s*\\.\\s*ServeMux\\b`, 'g');
const GO_CHI_DERIVE = new RegExp(`(${ID})\\s*:?=\\s*(${ID})\\s*\\.\\s*(?:With|Group)\\s*\\(`, 'g');
const GO_CHAIN = /(?:(?<![\w.])([A-Za-z_]\w*)|\))\s*\.\s*(?:With|Group)\s*$/;
const GO_GROUP = new RegExp(`(${ID})\\s*:?=\\s*(${ID})\\s*\\.\\s*Group\\s*\\(\\s*"([^"\\n]*)"`, 'g');

/** net/http 1.22 patterns: an optional method, an optional host, `{x...}` wildcards and the `{$}` anchor. */
function muxPattern(p: string): { method: string; path: string } | null {
  const m = /^(?:([A-Z]+)\s+)?(\S+)$/.exec(p);
  if (!m) return null;
  const slash = m[2].indexOf('/');
  if (slash < 0) return null;
  return { method: m[1] ?? 'ANY', path: normPath(m[2].slice(slash).replace(/\{(\w+)\.\.\.\}/g, ':$1*').replace(/\{\$\}/g, '')) };
}

/** Whether the call chain ending in the `)` at `close` (`r.With(mw).Group(fn)`) starts at a chi router. */
function chiChain(src: Src, close: number, chi: Set<string>): boolean {
  for (let guard = 0; guard < 8; guard++) {
    const open = src.pairs[close];
    if (open < 0 || open > close) return false;
    const from = Math.max(0, open - 120);
    const m = GO_CHAIN.exec(src.scan.slice(from, open));
    if (!m) return false;
    if (m[1] !== undefined) return chi.has(m[1]);
    close = from + m.index;
  }
  return false;
}

/** Whether the identifier at `i` is a member access (`s.mux`): a `.` precedes it, spaces allowed. */
function fieldReceiver(scan: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && i - j < 64 && (scan[j] === ' ' || scan[j] === '\t')) j--;
  return j >= 0 && scan[j] === '.';
}

function go(src: Src, out: Facts): void {
  const { code, scan, q } = src;
  const ginFile = /"github\.com\/gin-gonic\/gin"/.test(code);
  const chiFile = /"github\.com\/go-chi\/chi(?:\/v\d+)?"/.test(code);
  const httpFile = /"net\/http"/.test(code);
  const gin = new Map<string, string>();
  for (const m of scan.matchAll(GO_GIN_NEW)) gin.set(m[1] ?? m[2], '');
  for (const m of scan.matchAll(GO_GROUP)) {
    if (!gin.has(m[2]) && !ginFile) continue;
    const at = m.index + m[0].length - m[3].length - 1;
    gin.set(m[1], (gin.get(m[2]) ?? '') + '/' + code.slice(at, at + m[3].length));
  }
  const chi = new Set<string>();
  if (chiFile) {
    for (const m of scan.matchAll(GO_CHI_NEW)) chi.add(m[1] ?? m[2]);
    for (const m of scan.matchAll(GO_CHI_DERIVE)) if (chi.has(m[2])) chi.add(m[1]);
  }
  const mux = new Set<string>();
  if (httpFile) for (const m of scan.matchAll(GO_MUX_NEW)) mux.add(m[1] ?? m[2]);
  const frames: { end: number; prefix: string }[] = [];
  for (const m of scan.matchAll(GO_CALL)) {
    if (scanBudget() <= 0) break;
    while (frames.length && frames[frames.length - 1].end <= m.index) frames.pop();
    const name = m[1];
    const verb = m[2];
    // A struct-field receiver (`s.mux`, `a.Router`) counts only when that field was declared or assigned as a router.
    const field = name !== undefined && fieldReceiver(scan, m.index);
    if (field && !gin.has(name) && !chi.has(name) && !mux.has(name)) continue;
    const isGin = name !== undefined && (gin.has(name) || (ginFile && !field)) && name !== 'http';
    const upper = verb === verb.toUpperCase() || verb === 'Any';
    if (upper && !isGin) continue;
    const isChi = !upper && chiFile && name !== 'http' && (name !== undefined ? chi.has(name) : chiChain(src, m.index, chi));
    if (!upper && verb !== 'Handle' && verb !== 'HandleFunc' && !isChi) continue;
    const { args, end } = split(src, m.index + m[0].length - 1);
    if (upper || (verb === 'Handle' && isGin && str(args[1]) !== null)) {
      const own = verb === 'Handle';
      const path = str(args[own ? 1 : 0]);
      const method = own ? str(args[0])?.toUpperCase() : verb === 'Any' ? 'ANY' : verb;
      if (!isPath(path) || !method) continue;
      route(out, src, method, normPath((gin.get(name!) ?? '') + '/' + path.replace(/\*(\w+)/g, ':$1*')), handlerOf(args.slice(own ? 2 : 1), GO_INLINE), m.index, 'gin');
      continue;
    }
    const prefix = frames.length ? frames[frames.length - 1].prefix : '';
    if (verb === 'Route') {
      const path = str(args[0]);
      if (isPath(path)) frames.push({ end, prefix: prefix + '/' + path });
    } else if (verb === 'Handle' || verb === 'HandleFunc') {
      const fw = isChi ? 'chi' : httpFile && name !== undefined && (!field || mux.has(name)) ? 'go-http' : null;
      const pat = str(args[0]);
      const mp = pat === null ? null : fw === 'chi' ? (isPath(pat) ? { method: 'ANY', path: pat } : null) : muxPattern(pat);
      if (fw && mp) route(out, src, mp.method, normPath(prefix + '/' + mp.path), handlerOf(args.slice(1), GO_INLINE), m.index, fw);
    } else if (verb === 'Method' || verb === 'MethodFunc') {
      const method = str(args[0]);
      const path = str(args[1]);
      if (method && isPath(path)) route(out, src, method.toUpperCase(), normPath(prefix + '/' + path), handlerOf(args.slice(2), GO_INLINE), m.index, 'chi');
    } else {
      const path = str(args[0]);
      if (isPath(path)) route(out, src, verb.toUpperCase(), normPath(prefix + '/' + path), handlerOf(args.slice(1), GO_INLINE), m.index, 'chi');
    }
  }
}

// ---------------------------------------------------------------- Spring (Java and Kotlin)

const SP_MAPPING = /@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/g;
const SP_CLASS_KW = /(?<![\w.])(?:class|interface|object)\s+[A-Za-z_]/g;
const SP_ANNOT = /\s*@[\w.]+\s*/y;
const SP_CLASS = /\s*(?:(?:public|private|protected|internal|open|abstract|final|static|data|sealed|inner)\s+)*(?:class|interface|object)\b/y;

/** Paths named by a mapping's arguments: positional, `value =` or `path =`, single or array; [''] when none is given. */
function springPaths(args: string[]): string[] {
  if (!args.length) return [''];
  const v = kwarg(args, 'value') ?? kwarg(args, 'path') ?? (/^\w+\s*=/.test(args[0]) ? undefined : args[0]);
  return v === undefined ? [''] : strs(v);
}

/** The identifier right before the first `(` after `i`: the annotated method's name. */
function springMethod(scan: string, i: number): string | undefined {
  const window = scan.slice(i, i + 400);
  const p = window.indexOf('(');
  if (p < 0 || /[;{}=]/.test(window.slice(0, p))) return undefined;
  let e = p;
  while (e > 0 && /\s/.test(window[e - 1])) e--;
  let s = e;
  while (s > 0 && /\w/.test(window[s - 1])) s--;
  return s < e && /^[A-Za-z_]/.test(window[s]) ? window.slice(s, e) : undefined;
}

function spring(src: Src, out: Facts): void {
  const { code, scan, q } = src;
  if (/@FeignClient\b/.test(scan)) return;
  const all = [...scan.matchAll(SP_CLASS_KW)].map(m => m.index);
  /** Top-level classes (outside any brace): nested classes and companion objects never own a prefix. */
  const classes: number[] = [];
  let depth = 0;
  let p = 0;
  for (const k of all) {
    for (; p < k; p++) {
      if (scan[p] === '{') depth++;
      else if (scan[p] === '}' && depth > 0) depth--;
    }
    if (depth === 0) classes.push(k);
  }
  const topLevel = new Set(classes);
  const prefixes = new Map<number, string>();
  const methods: { index: number; verb: string; args: string[]; handler?: string }[] = [];
  let next = 0;
  for (const m of scan.matchAll(SP_MAPPING)) {
    if (scanBudget() <= 0) break;
    let i = m.index + m[0].length;
    while (i < scan.length && /\s/.test(scan[i]) && i - m.index < 200) i++;
    const { args, end } = scan[i] === '(' ? split(src, i) : { args: [], end: m.index + m[0].length };
    i = end;
    for (let guard = 0; guard < 16; guard++) {
      SP_ANNOT.lastIndex = i;
      if (!SP_ANNOT.exec(scan)) break;
      i = SP_ANNOT.lastIndex;
      if (scan[i] === '(') i = split(src, i).end;
    }
    SP_CLASS.lastIndex = i;
    if (SP_CLASS.exec(scan)) {
      while (next < all.length && all[next] < i) next++;
      if (next < all.length && topLevel.has(all[next]) && m[1] === 'RequestMapping') prefixes.set(all[next], springPaths(args)[0] ?? '');
      continue;
    }
    methods.push({ index: m.index, verb: m[1], args, handler: springMethod(scan, i) });
  }
  let ci = -1;
  for (const mm of methods) {
    while (ci + 1 < classes.length && classes[ci + 1] < mm.index) ci++;
    const prefix = ci >= 0 ? prefixes.get(classes[ci]) ?? '' : '';
    let verbs: string[];
    if (mm.verb === 'RequestMapping') {
      const listed = kwarg(mm.args, 'method');
      verbs = listed ? [...listed.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/g)].map(x => x[1]) : [];
      if (!verbs.length) verbs = ['ANY'];
    } else verbs = [mm.verb.slice(0, -'Mapping'.length).toUpperCase()];
    for (const path of springPaths(mm.args)) {
      for (const v of verbs) route(out, src, v, normPath(prefix + '/' + path), mm.handler, mm.index, 'spring');
    }
  }
}

// ---------------------------------------------------------------- Rails (config/routes.rb)

interface RbFrame { prefix: string; module: string; res?: { ctrl: string; member: string; collection: string; nested: string } }
const RB_TOKEN = /^[ \t]*(namespace|scope|resources|resource|member|collection|get|post|put|patch|delete|match|root|if|unless|case|begin|def|class|module)\b(?![?!:])|\b(do|end)\b(?![?!:])/gm;
const RB_OPENERS = new Set(['if', 'unless', 'case', 'begin', 'def', 'class', 'module']);
const RB_BLOCK = /(?:^|\s+)do(?:\s*\|[^|\n]*\|)?$/;
const RB_AFTER_PARENS = /[ \t]*do\b(?:[ \t]*\|[^|\n]*\|)?/y;
const RB_REST: [string, string, string][] = [['index', 'GET', ''], ['show', 'GET', '/:id'], ['new', 'GET', '/new'], ['create', 'POST', ''], ['edit', 'GET', '/:id/edit'], ['update', 'PATCH', '/:id'], ['destroy', 'DELETE', '/:id']];
const RB_SINGULAR: [string, string, string][] = [['show', 'GET', ''], ['new', 'GET', '/new'], ['create', 'POST', ''], ['edit', 'GET', '/edit'], ['update', 'PATCH', ''], ['destroy', 'DELETE', '']];

/** `key: value` or `:key => value` options of a Ruby call. */
function rbOpt(args: string[], key: string): string | undefined {
  const re = new RegExp(`^(?:${key}:|:${key}\\s*=>)\\s*`);
  const a = args.find(x => re.test(x));
  return a === undefined ? undefined : a.replace(re, '');
}
const rbName = (arg: string | undefined): string | null => (arg ? /^:(\w+)$/.exec(arg)?.[1] ?? str(arg) : null);
const rbWords = (v: string): string[] => v.replace(/^%[iwIW]/, '').match(/\w+/g) ?? [];
const joinMod = (a: string, b: string): string => (a ? `${a}/${b}` : b);
/** An explicit `controller#action` inside a namespace or scope module resolves under it, unless it names its own path. */
const inModule = (f: RbFrame, h: string | null): string | undefined => (h ? (h.includes('/') ? h : joinMod(f.module, h)) : undefined);

/** One routes.rb statement: its arguments, where it ends, and whether it opens a `do` block. */
function rbStatement(src: Src, at: number): { args: string[]; end: number; block: boolean } {
  if (src.scan[at] === '(') {
    const r = split(src, at);
    RB_AFTER_PARENS.lastIndex = r.end;
    const d = RB_AFTER_PARENS.exec(src.scan);
    return { args: r.args, end: d ? RB_AFTER_PARENS.lastIndex : r.end, block: !!d };
  }
  const r = split(src, at, true);
  const last = r.args[r.args.length - 1];
  const block = last !== undefined && RB_BLOCK.test(last);
  if (block) {
    const t = last.replace(RB_BLOCK, '');
    if (t) r.args[r.args.length - 1] = t; else r.args.pop();
  }
  return { ...r, block };
}

function rails(src: Src, out: Facts): void {
  const stack: RbFrame[] = [{ prefix: '', module: '' }];
  const top = (): RbFrame => stack[stack.length - 1];
  const re = new RegExp(RB_TOKEN.source, 'gm');
  const add = (method: string, path: string, handler: string | undefined, index: number): void => route(out, src, method, normPath(path), handler, index, 'rails');
  for (let m = re.exec(src.scan); m; m = re.exec(src.scan)) {
    if (scanBudget() <= 0) break;
    const cur = top();
    if (m[2] === 'do') { stack.push({ ...cur }); continue; }
    if (m[2] === 'end') { if (stack.length > 1) stack.pop(); continue; }
    const kw = m[1];
    if (RB_OPENERS.has(kw)) { stack.push({ ...cur }); continue; }
    const st = rbStatement(src, m.index + m[0].length);
    re.lastIndex = Math.max(re.lastIndex, st.end);
    const { args } = st;
    let frame: RbFrame = { ...cur };
    if (kw === 'namespace') {
      const name = rbName(args[0]);
      if (name) frame = { prefix: `${cur.prefix}/${name}`, module: joinMod(cur.module, name) };
    } else if (kw === 'scope') {
      const path = str(args[0]) ?? str(rbOpt(args, 'path'));
      const mod = rbName(rbOpt(args, 'module'));
      frame = { ...cur, prefix: path ? `${cur.prefix}/${path}` : cur.prefix, module: mod ? joinMod(cur.module, mod) : cur.module };
    } else if (kw === 'resources' || kw === 'resource') {
      const only = rbOpt(args, 'only');
      const except = rbOpt(args, 'except');
      const keep = (a: string): boolean => (!only || rbWords(only).includes(a)) && (!except || !rbWords(except).includes(a));
      for (const arg of args) {
        const name = /^:(\w+)$/.exec(arg)?.[1];
        if (!name) continue;
        const base = `${cur.prefix}/${name}`;
        const ctrl = rbName(rbOpt(args, 'controller')) ?? joinMod(cur.module, kw === 'resources' ? name : name + 's');
        for (const [action, method, suffix] of kw === 'resources' ? RB_REST : RB_SINGULAR) if (keep(action)) add(method, base + suffix, `${ctrl}#${action}`, m.index);
        frame = kw === 'resources'
          ? { ...cur, res: { ctrl, member: `${base}/:id`, collection: base, nested: `${base}/:${singular(name)}_id` }, prefix: `${base}/:${singular(name)}_id` }
          : { ...cur, res: { ctrl, member: base, collection: base, nested: base }, prefix: base };
      }
    } else if (kw === 'member' || kw === 'collection') {
      if (cur.res) frame = { ...cur, prefix: kw === 'member' ? cur.res.member : cur.res.collection };
    } else if (kw === 'root') {
      add('GET', cur.prefix, inModule(cur, str(args[0]) ?? str(rbOpt(args, 'to'))), m.index);
    } else {
      const rocket = args[0] ? /^(['"])([^'"\n]*)\1\s*=>\s*(['"])([^'"\n]*)\3$/.exec(args[0]) : null;
      const name = rocket ? rocket[2] : rbName(args[0]);
      if (name !== null) {
        const on = rbName(rbOpt(args, 'on'));
        const base = on && cur.res ? (on === 'member' ? cur.res.member : cur.res.collection) : cur.prefix;
        const to = inModule(cur, rocket ? rocket[4] : str(rbOpt(args, 'to')));
        const handler = to ?? (cur.res && /^:\w+$/.test(args[0]) ? `${cur.res.ctrl}#${name}` : undefined);
        const via = rbOpt(args, 'via');
        const methods = kw !== 'match' ? [kw.toUpperCase()] : via && !rbWords(via).includes('all') ? rbWords(via).map(x => x.toUpperCase()) : ['ANY'];
        for (const method of methods) add(method, `${base}/${name}`, handler, m.index);
      }
    }
    if (st.block) stack.push(frame);
  }
}

// ---------------------------------------------------------------- Laravel (routes/*.php)

const LV_CALL = /(?<![\w$])Route\s*::\s*([A-Za-z_]\w*)\s*\(/g;
const LV_CHAIN = /\s*->\s*([A-Za-z_]\w*)\s*\(/y;
const LV_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any']);
const LV_REST: [string, string, string][] = [['index', 'GET', ''], ['create', 'GET', '/create'], ['store', 'POST', ''], ['show', 'GET', '/:p'], ['edit', 'GET', '/:p/edit'], ['update', 'PUT', '/:p'], ['destroy', 'DELETE', '/:p']];

function lvHandler(arg: string | undefined): string | undefined {
  if (!arg) return undefined;
  if (/^(?:static\s+)?(?:function|fn)\b/.test(arg)) return 'inline';
  const pair = /^\[\s*([\w\\]+)::class\s*,\s*(['"])(\w+)\2\s*\]$/.exec(arg);
  if (pair) return `${pair[1]}@${pair[3]}`;
  return /^([\w\\]+)::class$/.exec(arg)?.[1] ?? str(arg) ?? undefined;
}

function laravel(rel: string, src: Src, out: Facts): void {
  const { code, scan, q } = src;
  const frames = [{ end: Infinity, prefix: /(?:^|\/)routes\/api\.php$/.test(rel) ? '/api' : '' }];
  for (const m of scan.matchAll(LV_CALL)) {
    if (scanBudget() <= 0) break;
    while (frames.length > 1 && frames[frames.length - 1].end <= m.index) frames.pop();
    const prefix = frames[frames.length - 1].prefix;
    const chain = [{ name: m[1], ...split(src, m.index + m[0].length - 1) }];
    for (let guard = 0; guard < 32 && scanBudget() > 0; guard++) {
      LV_CHAIN.lastIndex = chain[chain.length - 1].end;
      const c = LV_CHAIN.exec(scan);
      if (!c) break;
      chain.push({ name: c[1], ...split(src, LV_CHAIN.lastIndex - 1) });
    }
    const call = (name: string) => chain.find(c => c.name === name);
    const group = call('group');
    if (group) {
      const opts = group.args[0]?.startsWith('[') ? /(['"])prefix\1\s*=>\s*(['"])([^'"\n]*)\2/.exec(group.args[0])?.[3] : undefined;
      const p = str(call('prefix')?.args[0]) ?? opts ?? '';
      frames.push({ end: group.end, prefix: `${prefix}/${p}` });
      continue;
    }
    const { name, args } = chain[0];
    if (LV_VERBS.has(name)) {
      const path = str(args[0]);
      if (path !== null) route(out, src, name === 'any' ? 'ANY' : name.toUpperCase(), normPath(`${prefix}/${path}`), lvHandler(args[args.length - 1]), m.index, 'laravel');
    } else if (name === 'match') {
      const path = str(args[1]);
      if (path !== null && args[0]) for (const v of strs(args[0])) route(out, src, v.toUpperCase(), normPath(`${prefix}/${path}`), lvHandler(args[2]), m.index, 'laravel');
    } else if (name === 'resource' || name === 'apiResource') {
      const res = str(args[0]);
      const ctrl = lvHandler(args[1]);
      if (!res) continue;
      const only = call('only')?.args[0];
      const except = call('except')?.args[0];
      const param = singular(res.split(/[./]/).pop()!);
      for (const [action, method, suffix] of LV_REST) {
        if (name === 'apiResource' && (action === 'create' || action === 'edit')) continue;
        if ((only && !strs(only).includes(action)) || (except && strs(except).includes(action))) continue;
        route(out, src, method, normPath(`${prefix}/${res}${suffix.replace(':p', ':' + param)}`), ctrl ? `${ctrl}@${action}` : undefined, m.index, 'laravel');
      }
    }
  }
}

// ----------------------------------------------------------------

const RAILS_FILE = /(?:^|\/)config\/routes(?:\.rb$|\/)/;
const LARAVEL_FILE = /(?:^|\/)routes\/[^\n]*\.php$/;

/** HTTP routes and mounts for Python (FastAPI, Flask, Django), Go (net/http, gin, chi), Spring, Rails and Laravel. */
export const routesOther: Analyzer = {
  name: 'routes-other',
  applies(rel: string, lang: Lang) {
    switch (lang) {
      case 'python': case 'go': case 'java': case 'kotlin': return true;
      case 'ruby': return RAILS_FILE.test(rel);
      case 'php': return LARAVEL_FILE.test(rel);
      default: return false;
    }
  },
  run(rel, lang, text) {
    const code = maskCommentsAndStrings(text, lang);
    const q = quotingOf(lang);
    const scan = blankStrings(code, q);
    const src: Src = { code, scan, q, pairs: bracketPairs(scan) };
    const out: Facts = { routes: [], mounts: [] };
    resetScanBudget(2 * code.length + 50_000);
    if (lang === 'python') {
      if (/(?:^|\/)urls\.py$/.test(rel)) django(src, out); else python(src, out);
    } else if (lang === 'go') go(src, out);
    else if (lang === 'ruby') rails(src, out);
    else if (lang === 'php') laravel(rel, src, out);
    else spring(src, out);
    return out;
  },
};
