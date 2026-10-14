import type { Entity, Lang } from '../../shared/types.js';

let cachedText: string | null = null;
let cachedOffsets: number[] = [];

/** Offsets of every '\n' in text; the last text's offsets are cached since analyzers ask about one file at a time. */
function newlines(text: string): number[] {
  if (text === cachedText) return cachedOffsets;
  const out: number[] = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i);
  cachedText = text;
  cachedOffsets = out;
  return out;
}

/** 1-based line of the character at `index`. */
export function lineAt(text: string, index: number): number {
  const nl = newlines(text);
  let lo = 0, hi = nl.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nl[mid] < index) lo = mid + 1; else hi = mid;
  }
  return lo + 1;
}

/**
 * `triple` marks languages with `"""` (or `'''`) multi-line strings; `lineBlock` is a block comment
 * whose markers only count at the start of a line (Ruby `=begin` / `=end`).
 */
interface Syntax { line: string[]; block: [string, string] | null; quotes: string; triple?: true; lineBlock?: [string, string] }

const C_LIKE: Syntax = { line: ['//'], block: ['/*', '*/'], quotes: '"\'`' };
const HASH: Syntax = { line: ['#'], block: null, quotes: '"\'' };
const JVM: Syntax = { ...C_LIKE, quotes: '"\'', triple: true };
const SYNTAX: Partial<Record<Lang, Syntax>> = {
  typescript: C_LIKE, tsx: C_LIKE, javascript: C_LIKE, vue: C_LIKE, svelte: C_LIKE,
  java: JVM, kotlin: JVM, csharp: { ...C_LIKE, quotes: '"\'' },
  swift: { ...C_LIKE, quotes: '"', triple: true }, c: { ...C_LIKE, quotes: '"\'' }, cpp: { ...C_LIKE, quotes: '"\'' },
  dart: JVM, go: C_LIKE, rust: { ...C_LIKE, quotes: '"' },
  php: { line: ['//', '#'], block: ['/*', '*/'], quotes: '"\'' },
  prisma: { line: ['//'], block: null, quotes: '"' },
  css: { line: [], block: ['/*', '*/'], quotes: '"\'' },
  python: { ...HASH, triple: true }, ruby: { ...HASH, lineBlock: ['=begin', '=end'] }, shell: HASH, yaml: HASH, toml: HASH,
  sql: { line: ['--'], block: ['/*', '*/'], quotes: '"\'' },
  html: { line: [], block: ['<!--', '-->'], quotes: '' },
  markdown: { line: [], block: ['<!--', '-->'], quotes: '' },
};

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

/**
 * Blanks comments to spaces (newlines kept) so offsets and lines stay valid and commented-out
 * code does not match. String literals are kept as written; they are only scanned so comment
 * markers inside them are not treated as comments. Single and double quoted strings end at a
 * newline, which bounds the damage of a misread quote (a regex literal, a lifetime).
 */
export function maskCommentsAndStrings(text: string, lang: Lang): string {
  if (text === maskedText && lang === maskedLang) return masked;
  const out = mask(text, lang);
  maskedText = text;
  maskedLang = lang;
  masked = out;
  return out;
}

/** The last masked text is cached since several analyzers mask the same file in turn. */
let maskedText: string | null = null;
let maskedLang: Lang | null = null;
let masked = '';

function mask(text: string, lang: Lang): string {
  const syn = SYNTAX[lang];
  if (!syn) return text;
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (syn.quotes.includes(c)) {
      const triple = syn.triple && text.startsWith(c + c + c, i);
      if (triple) {
        const end = text.indexOf(c + c + c, i + 3);
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    const lc = syn.line.find(m => text.startsWith(m, i));
    if (lc) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = n;
      parts.push(text.slice(start, i), blank(text.slice(i, end)));
      start = i = end;
      continue;
    }
    if (syn.lineBlock && (i === 0 || text[i - 1] === '\n') && text.startsWith(syn.lineBlock[0], i)) {
      const close = text.indexOf('\n' + syn.lineBlock[1], i);
      const eol = close === -1 ? -1 : text.indexOf('\n', close + 1);
      const end = eol === -1 ? n : eol;
      parts.push(text.slice(start, i), blank(text.slice(i, end)));
      start = i = end;
      continue;
    }
    if (syn.block && text.startsWith(syn.block[0], i)) {
      const close = text.indexOf(syn.block[1], i + syn.block[0].length);
      const end = close === -1 ? n : close + syn.block[1].length;
      parts.push(text.slice(start, i), blank(text.slice(i, end)));
      start = i = end;
      continue;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.join('');
}

/**
 * Route path rules: `:param` style for `[id]`, `{id}`, `{id:int}`, `<int:id>`; catch-alls
 * (`[...slug]`, `[[...slug]]`) become `:slug*`. Leading `/`, no duplicate or trailing slash except root.
 */
export function normPath(p: string): string {
  const out = p
    .replace(/\[\[\.\.\.(\w+)\]\]/g, ':$1*')
    .replace(/\[\.\.\.(\w+)\]/g, ':$1*')
    .replace(/\[(\w+)\]/g, ':$1')
    .replace(/\{(\w+)(?:[:=][^}/]*)?\}/g, ':$1')
    .replace(/<(?:\w+:)?(\w+)>/g, ':$1')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  return out.startsWith('/') ? out : '/' + out;
}

/** String delimiters of a language for argument scanning (`"` always); `triple` adds `"""` / `'''` multi-line strings. */
export interface Quoting { single: boolean; backtick: boolean; triple: boolean }
export const JS_QUOTING: Quoting = { single: true, backtick: true, triple: false };
export function quotingOf(lang: Lang): Quoting {
  const quotes = SYNTAX[lang]?.quotes ?? '"\'';
  return { single: quotes.includes("'"), backtick: quotes.includes('`'), triple: !!SYNTAX[lang]?.triple };
}
const isQuote = (c: string, q: Quoting): boolean => c === '"' || (c === "'" && q.single) || (c === '`' && q.backtick);

/** Characters argument scanning may still visit in the current file; analyzers reset it per run so the total stays linear in file size. */
let budget = 0;
export const resetScanBudget = (n: number): void => { budget = n; };
export const scanBudget = (): number => budget;
/** Longest stretch scanned for one call's arguments, so a call cut off by an unfinished edit cannot run to EOF repeatedly. */
const MAX_SCAN = 10_000;

/** Index of the last character of the string opening at `i` (single-line quotes end at a newline; backticks and triples may span lines). */
export function skipString(code: string, i: number, limit: number, q: Quoting = JS_QUOTING): number {
  const c = code[i];
  if (q.triple && code[i + 1] === c && code[i + 2] === c) {
    for (let j = i + 3; j + 2 < limit; j++) if (code[j] === c && code[j + 1] === c && code[j + 2] === c) return j + 2;
    return limit;
  }
  let j = i + 1;
  while (j < limit && code[j] !== c && (c === '`' || code[j] !== '\n')) j += code[j] === '\\' ? 2 : 1;
  return j;
}

/**
 * Copy of `code` with string literal bodies blanked (quotes and newlines kept), so patterns never match
 * inside strings. The last result is cached since several analyzers blank the same file in turn.
 */
export function blankStrings(code: string, q: Quoting = JS_QUOTING): string {
  if (code === blankedCode && q.single === blankedQ.single && q.backtick === blankedQ.backtick && q.triple === blankedQ.triple) return blanked;
  const out = blankBodies(code, q);
  blankedCode = code;
  blankedQ = q;
  blanked = out;
  return out;
}

let blankedCode: string | null = null;
let blankedQ: Quoting = JS_QUOTING;
let blanked = '';

function blankBodies(code: string, q: Quoting): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    if (!isQuote(code[i], q)) continue;
    const end = skipString(code, i, code.length, q);
    parts.push(code.slice(start, i + 1), code.slice(i + 1, end).replace(/[^\n]/g, ' '));
    start = i = end;
  }
  parts.push(code.slice(start));
  return parts.join('');
}

/** How far down the open-bracket stack a closer looks for its opener; stray closers past it are ignored, keeping the pass linear. */
const MAX_UNWIND = 8;

/**
 * Matching-bracket table for a comment-masked, string-blanked text: `pairs[i]` is the index of the bracket
 * matching the one at `i` (both directions), or -1. Unclosed openers stay -1; a closer skips over at most
 * a few unclosed openers of another kind. The last table is cached since analyzers share a file.
 */
export function bracketPairs(scan: string): Int32Array {
  if (scan === pairedText) return paired;
  const pairs = new Int32Array(scan.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < scan.length; i++) {
    const c = scan.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) { stack.push(i); continue; }
    const open = c === 41 ? 40 : c === 93 ? 91 : c === 125 ? 123 : 0;
    if (!open) continue;
    for (let d = stack.length - 1; d >= 0 && d >= stack.length - MAX_UNWIND; d--) {
      if (scan.charCodeAt(stack[d]) !== open) continue;
      pairs[stack[d]] = i;
      pairs[i] = stack[d];
      stack.length = d;
      break;
    }
  }
  pairedText = scan;
  paired = pairs;
  return pairs;
}

let pairedText: string | null = null;
let paired = new Int32Array(0);

/**
 * `[start, end)` ranges of the top-level comma-separated parts of `scan[from, to)`, a string-blanked text
 * with its `bracketPairs` table. Closed nested groups are stepped over in one move, so a block costs only its
 * top-level characters. Whitespace-only parts (a trailing comma) are dropped.
 */
export function topLevelParts(scan: string, pairs: Int32Array, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  const push = (end: number): void => { if (scan.slice(start, end).trim()) out.push([start, end]); };
  for (let i = from; i < to; i++) {
    const c = scan.charCodeAt(i);
    if (c === 40 || c === 91 || c === 123) { const j = pairs[i]; if (j > i && j < to) i = j; continue; }
    if (c === 44) { push(i); start = i + 1; }
  }
  push(to);
  return out;
}

/**
 * `line`: the parts start at `open` itself (no bracket) and end at a newline outside brackets that does
 * not follow a comma (Ruby calls without parentheses). `pairs`: a `bracketPairs` table of the same text,
 * used to step over balanced nested groups in one move, so a long block costs only its top-level characters.
 */
export interface ArgOptions { line?: boolean; pairs?: Int32Array }

/**
 * Top-level comma-separated parts between the bracket at `open` and its match; tolerates EOF. At most
 * MAX_SCAN characters (and the remaining budget) are visited per call; jumps over paired groups count as one.
 */
export function splitArgs(code: string, open: number, q: Quoting = JS_QUOTING, opts: ArgOptions = {}): { args: string[]; end: number } {
  const { line = false, pairs } = opts;
  const args: string[] = [];
  const n = code.length;
  const first = line ? open : open + 1;
  const allowed = Math.min(MAX_SCAN, Math.max(0, budget));
  let used = 0;
  let depth = 0;
  let start = first;
  let i = first;
  let last = '';
  const push = (to: number): void => { const t = code.slice(start, to).trim(); if (t) args.push(t); };
  for (; i < n && used < allowed; i++, used++) {
    const c = code[i];
    if (isQuote(c, q)) { const j = skipString(code, i, Math.min(n, i + allowed - used), q); used += j - i; i = j; last = c; continue; }
    if (c === '(' || c === '[' || c === '{') {
      const close = pairs ? pairs[i] : -1;
      if (close > i) { i = close; last = code[close]; continue; }
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { push(i); budget -= used; return { args, end: i + 1 }; }
      depth--;
    } else if (c === ',' && depth === 0) { push(i); start = i + 1; }
    else if (line && c === '\n' && depth === 0 && last !== ',') break;
    if (line && c > ' ') last = c;
  }
  push(i);
  budget -= used;
  return { args, end: i };
}

const IDENT = /^[A-Za-z_$][\w$]*(?:(?:\.|::|\\)[A-Za-z_$][\w$]*)*$/;
const JS_INLINE = /^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

/**
 * The handler is the last argument: an identifier, an inline function (`inline` tells the language's
 * forms apart), or one of those wrapped in one call (`asyncHandler(getX)`).
 */
export function handlerOf(args: string[], inline: RegExp = JS_INLINE): string | undefined {
  const last = args[args.length - 1];
  if (!last) return undefined;
  const wrapped = /^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)$/.exec(last);
  for (const a of wrapped ? [last, wrapped[1].trim()] : [last]) {
    if (inline.test(a)) return 'inline';
    if (IDENT.test(a)) return a;
  }
  return undefined;
}

const ID = '[A-Za-z_$][\\w$]*';

/** Name and line of a JS module's default export; line 1 when there is none. */
export function defaultExport(code: string): { name?: string; line: number } {
  const fn = new RegExp(`\\bexport\\s+default\\s+(?:async\\s+)?(?:function\\s*\\*?|class)\\s*(${ID})?`).exec(code);
  if (fn) return { name: fn[1], line: lineAt(code, fn.index) };
  const id = new RegExp(`\\bexport\\s+default\\s+(${ID})\\s*(?:;|$)`, 'm').exec(code);
  if (id) return { name: id[1], line: lineAt(code, id.index) };
  return { line: 1 };
}

/** Folder segments of a file-based router to a route path: `(group)` and `@slot` dropped, SvelteKit matchers and optionals handled. */
export function filePath(segs: string[]): string {
  const kept = segs
    .filter(s => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
    .map(s => s.replace(/^\[\[(\w+)\]\]$/, ':$1?').replace(/^\[(\w+)=\w+\]$/, '[$1]'));
  return normPath(kept.join('/'));
}

/** A file ready for matching: `code` has comments blanked, `scan` also string bodies (same offsets), `pairs` its brackets. */
export interface Scanned { rel: string; text: string; code: string; scan: string; pairs: Int32Array }

export function scanned(rel: string, lang: Lang, text: string): Scanned {
  const code = maskCommentsAndStrings(text, lang);
  const scan = blankStrings(code, quotingOf(lang));
  return { rel, text, code, scan, pairs: bracketPairs(scan) };
}

export const isOpenBracket = (c: number): boolean => c === 40 || c === 91 || c === 123;

/** Offset of the first non-space character of `[s, e)` in `text` (`e` when there is none). */
export function firstAt(text: string, s: number, e: number): number {
  while (s < e && /\s/.test(text[s])) s++;
  return s;
}

/** One entity per lowercased name in a file; a later definition replaces the earlier one in place. */
export function onePerName(list: Entity[]): Entity[] {
  const out: Entity[] = [];
  const at = new Map<string, number>();
  for (const e of list) {
    const key = e.name.toLowerCase();
    const i = at.get(key);
    if (i === undefined) { at.set(key, out.length); out.push(e); } else out[i] = e;
  }
  return out;
}

/** Longest argument text kept per part; real arguments are short, and the cap keeps hostile input linear. */
const ARG_CAP = 500;

/** Positional and `key = value` arguments of the call whose paren is at `open`. */
export interface Args { pos: string[]; kw: Map<string, string> }
const KWARG = /\s*([A-Za-z_]\w*)\s*=(?!=)\s*/y;
export function argsOf(src: Scanned, open: number, close: number): Args {
  const pos: string[] = [];
  const kw = new Map<string, string>();
  for (const [s, e] of topLevelParts(src.scan, src.pairs, open + 1, close)) {
    KWARG.lastIndex = s;
    const k = KWARG.exec(src.scan);
    const named = k && KWARG.lastIndex <= e;
    const from = named ? KWARG.lastIndex : s;
    const v = src.code.slice(from, Math.min(e, from + ARG_CAP)).trim();
    if (!named) pos.push(v);
    else if (!kw.has(k[1])) kw.set(k[1], v);
  }
  return { pos, kw };
}

export interface Call extends Args { name: string }
const CALLEE = /\s*([A-Za-z_][\w.]*)\s*\(/y;
/** A call starting at `at` whose parens close before `end`; `name` is the callee's last segment. */
export function callAt(src: Scanned, at: number, end: number): Call | null {
  CALLEE.lastIndex = at;
  const m = CALLEE.exec(src.scan);
  if (!m) return null;
  const open = CALLEE.lastIndex - 1;
  const close = src.pairs[open];
  if (close < open || close > end) return null;
  return { name: m[1].slice(m[1].lastIndexOf('.') + 1), ...argsOf(src, open, close) };
}
