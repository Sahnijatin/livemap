import { posix } from 'node:path';
import type { Lang } from '../shared/types.js';
import { parentDir } from './files.js';

export interface ImportCtx {
  has(path: string): boolean;
  /** Sorted project paths; may be omitted when `index` is given. */
  files?: string[];
  aliases: [string, string[]][];
  goModule: string | null;
  /**
   * JS/TS specifiers per file for its latest text, owned by the caller (ProjectModel). Relinking
   * re-resolves every file whenever the file set changes while almost every text is unchanged,
   * so with a cache only resolution (cheap) is redone.
   */
  specCache?: Map<string, { text: string; specs: string[] }>;
  /** A prebuilt index of the project's paths, kept current by the caller; built from `files` when absent. */
  index?: FileIndex;
}

type Result = { local: string[]; external: string[] };

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte'];
const JS_SWAP: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
};

const norm = (p: string): string => {
  const n = posix.normalize(p);
  return n === '.' ? '' : n.replace(/^\.\//, '');
};
const join = (...parts: string[]): string => norm(parts.filter(Boolean).join('/'));

export interface FileIndex { byDir: Map<string, string[]>; byBase: Map<string, string[]> }
const INDEXES = new WeakMap<string[], FileIndex>();
export const indexStats = { builds: 0, jsParses: 0 };

const splitPath = (f: string): [dir: string, base: string] => [parentDir(f), f.slice(f.lastIndexOf('/') + 1)];

/** Dir to files and basename to files, each list sorted; `files` must be sorted. */
export function buildIndex(files: string[]): FileIndex {
  indexStats.builds++;
  const idx: FileIndex = { byDir: new Map(), byBase: new Map() };
  for (const f of files) {
    const [dir, base] = splitPath(f);
    const d = idx.byDir.get(dir); if (d) d.push(f); else idx.byDir.set(dir, [f]);
    const b = idx.byBase.get(base); if (b) b.push(f); else idx.byBase.set(base, [f]);
  }
  return idx;
}

/** Where f is, or would be inserted, in a sorted list. */
function lowerBound(list: string[], f: string): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < f) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Adds (or removes) one file, keeping the lists sorted as buildIndex makes them. */
export function indexUpdate(idx: FileIndex, f: string, present: boolean): void {
  const [dir, base] = splitPath(f);
  for (const [map, key] of [[idx.byDir, dir], [idx.byBase, base]] as const) {
    const list = map.get(key);
    if (!list) {
      if (present) map.set(key, [f]);
      continue;
    }
    const i = lowerBound(list, f);
    if (present && list[i] !== f) list.splice(i, 0, f);
    else if (!present && list[i] === f) {
      list.splice(i, 1);
      if (!list.length) map.delete(key);
    }
  }
}

const NO_FILES: string[] = [];

/** The ctx's own index, or one built once per ctx.files array. */
function indexOf(ctx: ImportCtx): FileIndex {
  if (ctx.index) return ctx.index;
  const files = ctx.files ?? NO_FILES;
  let idx = INDEXES.get(files);
  if (!idx) {
    idx = buildIndex(files);
    INDEXES.set(files, idx);
  }
  return idx;
}

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/** Code after which a `/` starts a regex literal rather than a division. */
// `<` is left out: in JSX `</p>` its `/` closes a tag. `>` (an arrow or a comparison) is in.
const REGEX_AFTER = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '>', '+', '-', '*', '%', '~', '^']);
const REGEX_KEYWORD = /\b(?:return|typeof|case|void|yield|await|in|of|delete|instanceof)$/;

/** End of the regex literal opening at `i` (past its closing `/`), or -1 when the line does not close one. */
function regexEnd(src: string, i: number): number {
  let cls = false;
  for (let j = i + 1; j < src.length && src[j] !== '\n'; j++) {
    const c = src[j];
    if (c === '\\') j++;
    else if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) return j + 1;
  }
  return -1;
}

/**
 * `src` with comments and the bodies of string, template and regex literals blanked (quotes and newlines
 * kept), so offsets still match `src`: statements are matched here and their specifiers read back from `src`.
 * A stray quote or backtick in a regex must not hide the imports after it: a quoted string ends at its line's
 * end and regex literals are skipped. (A raw backtick in JSX text still opens a template to the next one.)
 */
function blankJs(src: string): string {
  let out = '';
  let i = 0;
  // The last code character on this line ('' at a line start), to tell a regex from a division.
  let prev = '';
  // Set when a `/` opened no regex: the rest of the line is not read for one again, keeping long lines linear.
  let divisions = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let closed = false;
      for (; j < src.length; j += src[j] === '\\' ? 2 : 1) {
        if (src[j] === c) { closed = true; break; }
        if (src[j] === '\n' && c !== '`') break;
      }
      j = Math.min(j, src.length);
      out += c + blank(src.slice(i + 1, j)) + (closed ? c : '');
      i = closed ? j + 1 : j;
      prev = c;
    } else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : src[i + 1] === '/' ? end : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === '/' && !divisions && (REGEX_AFTER.has(prev) || (/[\w$]/.test(prev) && REGEX_KEYWORD.test(src.slice(Math.max(0, i - 12), i).trimEnd())))) {
      const end = regexEnd(src, i);
      if (end < 0) { out += c; i++; prev = c; divisions = true; continue; }
      out += '/' + blank(src.slice(i + 1, end - 1)) + '/';
      i = end;
      prev = ')';
    } else {
      out += c;
      i++;
      if (c === '\n') { prev = ''; divisions = false; }
      else if (c !== ' ' && c !== '\t' && c !== '\r') prev = c;
    }
  }
  return out;
}

function resolveJsPath(base: string, ctx: ImportCtx): string | null {
  if (base.startsWith('../') || base === '..') return null;
  if (base && ctx.has(base)) return base;
  const ext = posix.extname(base);
  if (JS_SWAP[ext]) {
    const stem = base.slice(0, -ext.length);
    for (const e of JS_SWAP[ext]) if (ctx.has(stem + e)) return stem + e;
  }
  for (const e of JS_EXTS) if (ctx.has(base + e)) return base + e;
  for (const e of JS_EXTS) if (ctx.has(join(base, 'index' + e))) return join(base, 'index' + e);
  return null;
}

function jsSpecs(path: string, src: string, cache: ImportCtx['specCache']): string[] {
  const hit = cache?.get(path);
  if (hit && hit.text === src) return hit.specs;
  const specs = parseJsSpecs(src);
  cache?.set(path, { text: src, specs });
  return specs;
}

const STATIC_HEAD = /\b(?:import|export)\s+(?:type\s+)?/g;
/** Whether `from` (after a space or `}`) ends the clause before `stop`, past any whitespace. */
function endsWithFrom(bare: string, stop: number): boolean {
  let j = stop - 1;
  while (j >= 0 && /\s/.test(bare[j])) j--;
  return j >= 4 && bare.slice(j - 3, j + 1) === 'from' && /[\s}*]/.test(bare[j - 4]);
}

/**
 * Specifiers of static `import ... from 'x'`, `import 'x'` and `export ... from 'x'` statements, of any length
 * (a barrel import may name hundreds of bindings). The clause runs to the first quote or `;`; that position
 * is found once per stretch of text, so the scan stays linear even on a long run of `import` with no quote.
 */
function staticSpecs(src: string, bare: string, out: string[]): void {
  let stop = -1;
  let fromTail = false;
  let skip = 0;
  for (const m of bare.matchAll(STATIC_HEAD)) {
    if (m.index < skip) continue;
    const from = m.index + m[0].length;
    if (stop < from) {
      stop = from;
      while (stop < bare.length && bare[stop] !== "'" && bare[stop] !== '"' && bare[stop] !== ';') stop++;
      // Every head before this quote shares the clause's end, so its `from` is checked once.
      fromTail = endsWithFrom(bare, stop);
    }
    if (stop >= bare.length || bare[stop] === ';') continue;
    // `import 'x'` (nothing between) or `import ... from 'x'`.
    if (from !== stop && !fromTail) continue;
    const close = bare.indexOf(bare[stop], stop + 1);
    if (close < 0) continue;
    const spec = src.slice(stop + 1, close);
    if (spec.trim() && !spec.includes('\n')) out.push(spec);
    skip = close + 1;
  }
}

function parseJsSpecs(src: string): string[] {
  indexStats.jsParses++;
  const out: string[] = [];
  // Text inside other strings (`"import x from 'y'"`) is blank, so only real statements match.
  const bare = blankJs(src);
  staticSpecs(src, bare, out);
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/dg,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/dg,
  ];
  for (const re of patterns) {
    for (const m of bare.matchAll(re)) {
      const [start, end] = m.indices![1];
      const spec = src.slice(start, end);
      if (spec.trim()) out.push(spec);
    }
  }
  return out;
}

function packageName(spec: string): string {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const SORTED_ALIASES = new WeakMap<ImportCtx['aliases'], ImportCtx['aliases']>();

/** Aliases with the longest prefix first, sorted once per aliases array. */
function longestFirst(aliases: ImportCtx['aliases']): ImportCtx['aliases'] {
  let sorted = SORTED_ALIASES.get(aliases);
  if (!sorted) {
    sorted = [...aliases].sort((a, b) => b[0].length - a[0].length);
    SORTED_ALIASES.set(aliases, sorted);
  }
  return sorted;
}

type JsTarget = { local: string | null } | { external: string };

/** One JS/TS specifier: a project file (null when it does not resolve or is a URL) or a package name. */
function resolveJs(dir: string, spec: string, ctx: ImportCtx): JsTarget {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { local: resolveJsPath(join(dir, spec), ctx) };
  }
  let any: string[] = [];
  for (const [prefix, targets] of longestFirst(ctx.aliases)) {
    if (prefix === '*') { any = targets; continue; }
    if (spec !== prefix && !spec.startsWith(prefix + '/')) continue;
    const rest = spec.slice(prefix.length).replace(/^\//, '');
    for (const t of targets) {
      const r = resolveJsPath(join(t, rest), ctx);
      if (r) return { local: r };
    }
    return { local: null };
  }
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    const rest = spec.slice(2);
    for (const root of ['src', 'app', '']) {
      const r = resolveJsPath(join(root, rest), ctx);
      if (r) return { local: r };
    }
    return { local: null };
  }
  if (spec.startsWith('/') || /^[a-z]+:\/\//i.test(spec)) return { local: null };
  // `baseUrl` and a `"*"` path: a bare specifier is a project file only when one exists there.
  for (const t of any) {
    const r = resolveJsPath(join(t, spec), ctx);
    if (r) return { local: r };
  }
  return { external: packageName(spec) };
}

function jsImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = parentDir(path);
  for (const spec of jsSpecs(path, src, ctx.specCache)) {
    const t = resolveJs(dir, spec, ctx);
    if ('external' in t) external.add(t.external);
    else if (t.local) local.add(t.local);
  }
}

function pyModule(base: string, ctx: ImportCtx): string | null {
  if (ctx.has(base + '.py')) return base + '.py';
  if (ctx.has(join(base, '__init__.py'))) return join(base, '__init__.py');
  return null;
}


/**
 * Modules built into the interpreter (CPython 3.11+ `Modules/Setup.bootstrap`, plus `sys`, `builtins`,
 * `marshal`) or imported while it starts (`site` and what it loads): Python has them before it searches any
 * directory, so a project file of the same name never replaces them.
 */
const PY_PRELOADED = new Set([
  'abc', 'atexit', 'builtins', 'codecs', 'encodings', 'errno', 'faulthandler', 'genericpath', 'io', 'itertools',
  'linecache', 'marshal', 'nt', 'ntpath', 'os', 'posix', 'posixpath', 'pwd', 'site', 'stat', 'sys', 'time',
  'zipimport',
]);

/** Top-level standard library modules (Python 3.13 `sys.stdlib_module_names`, plus ones removed since 3.12). */
const PY_STDLIB = new Set([
  'abc', 'antigravity', 'argparse', 'array', 'ast', 'asynchat', 'asyncio', 'asyncore', 'atexit', 'audioop',
  'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'cProfile', 'calendar', 'cgi', 'cgitb', 'chunk',
  'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections', 'colorsys', 'compileall', 'concurrent',
  'configparser', 'contextlib', 'contextvars', 'copy', 'copyreg', 'crypt', 'csv', 'ctypes', 'curses',
  'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'distutils', 'doctest', 'email', 'encodings',
  'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions',
  'ftplib', 'functools', 'gc', 'genericpath', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip',
  'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'imghdr', 'imp', 'importlib', 'inspect',
  'io', 'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes', 'mmap', 'modulefinder', 'msilib', 'msvcrt',
  'multiprocessing', 'netrc', 'nis', 'nntplib', 'nt', 'ntpath', 'nturl2path', 'numbers', 'opcode', 'operator',
  'optparse', 'os', 'ossaudiodev', 'pathlib', 'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform',
  'plistlib', 'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
  'pyclbr', 'pydoc', 'pydoc_data', 'pyexpat', 'queue', 'quopri', 'random', 're', 'readline', 'reprlib',
  'resource', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil',
  'signal', 'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'sre_compile',
  'sre_constants', 'sre_parse', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess',
  'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny', 'tarfile', 'telnetlib', 'tempfile', 'termios',
  'textwrap', 'this', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace',
  'traceback', 'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref',
  'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo', '__future__',
]);

/**
 * Candidate directories for a dotted module, in order: relative to `dir` (rel leading dots), or, for an
 * absolute module, each ancestor of the importing file nearest first that is not itself a package (a
 * project nested under `backend/` or `services/ml/` runs with its own directory on the import path, while
 * inside a package Python 3 has no implicit relative imports), then the root and `src`. A standard library
 * module is found in the standard library unless the importing script's own directory (`sys.path[0]`)
 * holds a file of that name, as Python does; one Python loads before any search (`PY_PRELOADED`) always is.
 */
function pyBases(dir: string, mod: string, rel: number, ctx: ImportCtx): string[] {
  const p = mod.replace(/\./g, '/');
  if (rel > 0) return [join(dir, ...Array(rel - 1).fill('..'), p)];
  const top = mod.split('.')[0];
  if (PY_PRELOADED.has(top)) return [];
  if (PY_STDLIB.has(top)) return ctx.has(join(dir, '__init__.py')) ? [] : [join(dir, p)];
  const out: string[] = [];
  if (mod) for (let d = dir; d; d = parentDir(d)) if (!ctx.has(join(d, '__init__.py'))) out.push(join(d, p));
  for (const r of ['', 'src']) out.push(join(r, p));
  return out;
}

/** The module file at a base; an empty module (`from . import x`) is the package's `__init__.py`. */
function pyTarget(base: string, mod: string, ctx: ImportCtx): string | null {
  if (mod) return pyModule(base, ctx);
  return ctx.has(join(base, '__init__.py')) ? join(base, '__init__.py') : null;
}

function pythonImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = parentDir(path);
  // The first base holding the module or one of the imported submodules wins, as on Python's import path.
  const add = (mod: string, names: string[], rel: number): boolean => {
    for (const b of pyBases(dir, mod, rel, ctx)) {
      const hits = [pyTarget(b, mod, ctx), ...names.map(n => pyModule(join(b, n), ctx))].filter((h): h is string => !!h);
      if (!hits.length) continue;
      for (const h of hits) local.add(h);
      return true;
    }
    return false;
  };
  for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*)/gm)) {
    const rel = m[1].length;
    const names = m[3].replace(/[()\\]/g, ' ').split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(n => /^\w+$/.test(n));
    const found = add(m[2], names, rel);
    if (!found && rel === 0 && m[2]) external.add(m[2].split('.')[0]);
  }
  for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (!/^[\w.]+$/.test(mod)) continue;
      if (!add(mod, [], 0)) external.add(mod.split('.')[0]);
    }
  }
}

function goImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const specs: string[] = [];
  for (const m of src.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) {
    for (const s of m[1].matchAll(/"([^"\n]+)"/g)) specs.push(s[1]);
  }
  for (const m of src.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) specs.push(m[1]);
  for (const spec of specs) {
    const mod = ctx.goModule;
    if (mod && (spec === mod || spec.startsWith(mod + '/'))) {
      const dir = spec.slice(mod.length).replace(/^\//, '');
      for (const f of indexOf(ctx).byDir.get(dir) ?? []) {
        if (f.endsWith('.go') && !f.endsWith('_test.go')) local.add(f);
      }
    } else {
      const parts = spec.split('/');
      external.add(parts[0].includes('.') ? parts.slice(0, 3).join('/') : spec);
    }
  }
}

function rustImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = parentDir(path);
  const stem = posix.basename(path, '.rs');
  const modDir = ['lib', 'main', 'mod'].includes(stem) ? dir : join(dir, stem);
  const tryMod = (base: string, name: string): string | null => {
    if (ctx.has(join(base, name + '.rs'))) return join(base, name + '.rs');
    if (ctx.has(join(base, name, 'mod.rs'))) return join(base, name, 'mod.rs');
    return null;
  };
  for (const m of src.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm)) {
    const r = tryMod(modDir, m[1]);
    if (r) local.add(r);
  }
  const segs = path.split('/');
  const si = segs.lastIndexOf('src');
  const crateRoot = si >= 0 ? segs.slice(0, si + 1).join('/') : dir;
  for (const m of src.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm)) {
    const body = m[1].trim();
    const brace = body.indexOf('{');
    const head = (brace >= 0 ? body.slice(0, brace) : body).split('::').map(s => s.trim()).filter(Boolean);
    const group = brace >= 0 ? body.slice(brace + 1, body.lastIndexOf('}')).split(',').map(s => s.trim().split('::')[0].split(/\s+as\s+/)[0]).filter(n => /^\w+$/.test(n)) : [];
    const first = head[0];
    if (!first) continue;
    let base: string, rest: string[];
    if (first === 'crate') { base = crateRoot; rest = head.slice(1); }
    else if (first === 'self') { base = modDir; rest = head.slice(1); }
    else if (first === 'super') { base = parentDir(modDir); rest = head.slice(1); }
    else if (tryMod(modDir, first)) { base = modDir; rest = head; }
    else { external.add(first); continue; }
    const attempt = (segments: string[]): void => {
      let cur = base;
      for (const s of segments) {
        const r = tryMod(cur, s);
        if (r) local.add(r);
        cur = join(cur, s);
      }
    };
    attempt(rest);
    for (const g of group) attempt([...rest, g]);
  }
}

function jvmImports(src: string, ctx: ImportCtx, ext: string, local: Set<string>, external: Set<string>): void {
  for (const m of src.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?(\w+(?:\.\w+)*)(\.\*)?[ \t]*;?/gm)) {
    const parts = m[1].split('.');
    let found = false;
    const idx = indexOf(ctx);
    if (m[2]) {
      const relDir = parts.join('/');
      for (const [dir, files] of idx.byDir) {
        if (dir !== relDir && !dir.endsWith('/' + relDir)) continue;
        for (const f of files) if (f.endsWith(ext)) { local.add(f); found = true; }
      }
    }
    // Not a local package: a wildcard may name a class (`import static a.B.*`) or a nested one
    // (`a.B.Inner.*`), whose file is the nearest class-like (capitalized) segment's, so a lowercase
    // package segment never matches a stray file. A plain import tries every prefix (`a.B.Inner`).
    if (!found) {
      for (let n = parts.length; n >= 1 && !found; n--) {
        if (m[2] && !/^[A-Z]/.test(parts[n - 1])) continue;
        const rel = parts.slice(0, n).join('/') + ext;
        const hit = (idx.byBase.get(parts[n - 1] + ext) ?? []).find(f => f === rel || f.endsWith('/' + rel));
        if (hit) { local.add(hit); found = true; }
      }
    }
    if (!found) external.add(m[2] ? m[1] : parts.slice(0, -1).join('.') || m[1]);
  }
}

function rubyImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = parentDir(path);
  const withExt = (p: string) => (p.endsWith('.rb') ? p : p + '.rb');
  for (const m of src.matchAll(/^[ \t]*require_relative[ \t(]+['"]([^'"\n]+)['"]/gm)) {
    const p = join(dir, withExt(m[1]));
    if (ctx.has(p)) local.add(p);
  }
  for (const m of src.matchAll(/^[ \t]*require[ \t(]+['"]([^'"\n]+)['"]/gm)) {
    const hit = ['', 'lib', 'app'].map(r => join(r, withExt(m[1]))).find(p => ctx.has(p));
    if (hit) local.add(hit); else external.add(m[1]);
  }
}

function cImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = parentDir(path);
  for (const m of src.matchAll(/^[ \t]*#[ \t]*include[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm)) {
    if (m[1]) {
      const hit = [join(dir, m[1]), join('', m[1]), join('include', m[1]), join('src', m[1])].find(p => !p.startsWith('..') && ctx.has(p));
      if (hit) local.add(hit);
    } else {
      external.add(m[2]);
    }
  }
}

/**
 * Resolves a file's imports to project files (local, sorted) and package names (external, in source order).
 * For vue/svelte, pass the script block as `src`.
 */
export function extractImports(path: string, lang: Lang, src: string, ctx: ImportCtx): Result {
  const local = new Set<string>();
  const external = new Set<string>();
  switch (lang) {
    case 'typescript': case 'tsx': case 'javascript': case 'vue': case 'svelte':
      jsImports(path, src, ctx, local, external); break;
    case 'python': pythonImports(path, src, ctx, local, external); break;
    case 'go': goImports(path, src, ctx, local, external); break;
    case 'rust': rustImports(path, src, ctx, local, external); break;
    case 'java': jvmImports(src, ctx, '.java', local, external); break;
    case 'kotlin': jvmImports(src, ctx, '.kt', local, external); break;
    case 'ruby': rubyImports(path, src, ctx, local, external); break;
    case 'c': case 'cpp': cImports(path, src, ctx, local, external); break;
    case 'csharp':
      for (const m of src.matchAll(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;/gm)) external.add(m[1]);
      break;
    case 'php':
      for (const m of src.matchAll(/^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?([\w\\]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm)) external.add(m[1]);
      break;
    default: break;
  }
  local.delete(path);
  return { local: [...local].sort(), external: [...external] };
}

/**
 * Resolves one module specifier the way `extractImports` does: JS/TS (relative, tsconfig aliases,
 * extension swaps, index files) and Python (relative `.a.b` / `..x` and absolute dotted). Null for
 * packages, unresolved specifiers and other languages.
 */
export function resolveSpecifier(from: string, lang: Lang, spec: string, ctx: ImportCtx): string | null {
  const dir = posix.dirname(from) === '.' ? '' : posix.dirname(from);
  switch (lang) {
    case 'typescript': case 'tsx': case 'javascript': case 'vue': case 'svelte': {
      const t = resolveJs(dir, spec, ctx);
      return 'local' in t ? t.local : null;
    }
    case 'python': {
      const m = /^(\.*)([\w.]*)$/.exec(spec);
      if (!m) return null;
      for (const b of pyBases(dir, m[2], m[1].length, ctx)) {
        const hit = pyTarget(b, m[2], ctx);
        if (hit) return hit;
      }
      return null;
    }
    default: return null;
  }
}

function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Alias prefix to target directories from tsconfig/jsconfig `compilerOptions.paths` (with `baseUrl` applied).
 * A `"*"` path and `baseUrl` itself become one `*` entry (paths targets first), tried for any bare specifier.
 */
export function readTsconfigAliases(json: string): [string, string[]][] {
  try {
    const cfg = JSON.parse(stripJsonc(json)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const opts = cfg.compilerOptions;
    const hasBase = typeof opts?.baseUrl === 'string';
    if (!opts || (!opts.paths && !hasBase)) return [];
    const baseUrl = hasBase ? opts.baseUrl! : '';
    const out: [string, string[]][] = [];
    const any: string[] = [];
    for (const [key, values] of Object.entries(opts.paths ?? {})) {
      if (!Array.isArray(values)) continue;
      const prefix = key.replace(/\/\*$/, '');
      const targets = values.filter((v): v is string => typeof v === 'string').map(v => join(baseUrl, v.replace(/\/?\*$/, '')));
      if (prefix === '*') any.push(...targets);
      else out.push([prefix, targets]);
    }
    if (hasBase) any.push(join(baseUrl));
    if (any.length) out.push(['*', [...new Set(any)]]);
    return out;
  } catch {
    return [];
  }
}
