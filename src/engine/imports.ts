import { posix } from 'node:path';
import type { Lang } from '../shared/types.js';

export interface ImportCtx {
  has(path: string): boolean;
  files: string[];
  aliases: [string, string[]][];
  goModule: string | null;
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

interface FileIndex { byDir: Map<string, string[]>; byBase: Map<string, string[]> }
const INDEXES = new WeakMap<string[], FileIndex>();
export const indexStats = { builds: 0 };

/** Built once per ctx.files array: dir to files, and basename to files. */
function indexOf(files: string[]): FileIndex {
  let idx = INDEXES.get(files);
  if (idx) return idx;
  indexStats.builds++;
  idx = { byDir: new Map(), byBase: new Map() };
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    const dir = slash === -1 ? '' : f.slice(0, slash);
    const base = slash === -1 ? f : f.slice(slash + 1);
    const d = idx.byDir.get(dir); if (d) d.push(f); else idx.byDir.set(dir, [f]);
    const b = idx.byBase.get(base); if (b) b.push(f); else idx.byBase.set(base, [f]);
  }
  INDEXES.set(files, idx);
  return idx;
}

function stripJsComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else { out += c; i++; }
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

function jsSpecs(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  const clean = stripJsComments(src);
  for (const re of patterns) for (const m of clean.matchAll(re)) out.push(m[1]);
  return out;
}

function packageName(spec: string): string {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

type JsTarget = { local: string | null } | { external: string };

/** One JS/TS specifier: a project file (null when it does not resolve or is a URL) or a package name. */
function resolveJs(dir: string, spec: string, ctx: ImportCtx): JsTarget {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { local: resolveJsPath(join(dir, spec), ctx) };
  }
  const sortedAliases = [...ctx.aliases].sort((a, b) => b[0].length - a[0].length);
  for (const [prefix, targets] of sortedAliases) {
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
  return { external: packageName(spec) };
}

function jsImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  for (const spec of jsSpecs(src)) {
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

/** Candidate directories for a dotted module: relative to `dir` (rel leading dots) or to the roots. */
function pyBases(dir: string, mod: string, rel: number): string[] {
  const p = mod.replace(/\./g, '/');
  return rel > 0 ? [join(dir, ...Array(rel - 1).fill('..'), p)] : ['', 'src'].map(r => join(r, p));
}

/** The module file at a base; an empty module (`from . import x`) is the package's `__init__.py`. */
function pyTarget(base: string, mod: string, ctx: ImportCtx): string | null {
  if (mod) return pyModule(base, ctx);
  return ctx.has(join(base, '__init__.py')) ? join(base, '__init__.py') : null;
}

function pythonImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const add = (mod: string, names: string[], rel: number): boolean => {
    let found = false;
    for (const b of pyBases(dir, mod, rel)) {
      const m = pyTarget(b, mod, ctx);
      if (m) { local.add(m); found = true; }
      for (const n of names) {
        const s = pyModule(join(b, n), ctx);
        if (s) { local.add(s); found = true; }
      }
    }
    return found;
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
      for (const f of indexOf(ctx.files).byDir.get(dir) ?? []) {
        if (f.endsWith('.go') && !f.endsWith('_test.go')) local.add(f);
      }
    } else {
      const parts = spec.split('/');
      external.add(parts[0].includes('.') ? parts.slice(0, 3).join('/') : spec);
    }
  }
}

function rustImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
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
    else if (first === 'super') { base = posix.dirname(modDir) === '.' ? '' : posix.dirname(modDir); rest = head.slice(1); }
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
  for (const m of src.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)(\.\*)?[ \t]*;?/gm)) {
    const parts = m[1].split('.');
    let found = false;
    const idx = indexOf(ctx.files);
    if (m[2]) {
      const relDir = parts.join('/');
      for (const [dir, files] of idx.byDir) {
        if (dir !== relDir && !dir.endsWith('/' + relDir)) continue;
        for (const f of files) if (f.endsWith(ext)) { local.add(f); found = true; }
      }
    } else {
      for (let n = parts.length; n >= 1 && !found; n--) {
        const rel = parts.slice(0, n).join('/') + ext;
        const hit = (idx.byBase.get(parts[n - 1] + ext) ?? []).find(f => f === rel || f.endsWith('/' + rel));
        if (hit) { local.add(hit); found = true; }
      }
    }
    if (!found) external.add(m[2] ? m[1] : parts.slice(0, -1).join('.') || m[1]);
  }
}

function rubyImports(path: string, src: string, ctx: ImportCtx, local: Set<string>, external: Set<string>): void {
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
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
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
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
      const rel = m[1].length;
      // An absolute module also resolves from each ancestor of the importing file, nearest first: a project
      // nested under `backend/` or `services/ml/` runs with its own directory on the import path.
      const ancestors: string[] = [];
      if (rel === 0 && m[2]) for (let d = dir; d; d = posix.dirname(d) === '.' ? '' : posix.dirname(d)) ancestors.push(join(d, m[2].replace(/\./g, '/')));
      for (const b of [...ancestors, ...pyBases(dir, m[2], rel)]) {
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

/** Alias prefix to target directories from tsconfig/jsconfig `compilerOptions.paths` (with `baseUrl` applied). */
export function readTsconfigAliases(json: string): [string, string[]][] {
  try {
    const cfg = JSON.parse(stripJsonc(json)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const opts = cfg.compilerOptions;
    if (!opts?.paths) return [];
    const baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '';
    const out: [string, string[]][] = [];
    for (const [key, values] of Object.entries(opts.paths)) {
      if (!Array.isArray(values)) continue;
      const prefix = key.replace(/\/\*$/, '');
      const targets = values.filter((v): v is string => typeof v === 'string').map(v => join(baseUrl, v.replace(/\/\*$/, '')));
      out.push([prefix, targets]);
    }
    return out;
  } catch {
    return [];
  }
}
