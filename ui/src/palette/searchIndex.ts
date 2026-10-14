import type { DomainIndex } from '@shared/domain.js';
import type { FileModel, SymbolKind } from '@shared/types.js';
import type { Layer } from '../layers';
import { fileMeta } from '../treeModel';
import { baseName, dirName } from '../recent';
import { tableKey } from '../store';

export type EntryKind = 'file' | 'symbol' | 'route' | 'table';

/** One searchable thing. `id` is the route id or the table key, for focusing it in its view. */
export interface Entry {
  kind: EntryKind;
  label: string;
  detail: string;
  path: string;
  line?: number;
  layer?: Layer;
  symKind?: SymbolKind;
  method?: string;
  id?: string;
}

/** An entry with what matching needs, worked out once when the index is built. */
export interface IndexEntry extends Entry {
  /** Lowercased label (exact and prefix tiers). */
  lo: string;
  /** Lowercased text for the fuzzy tier (and the path tier): the full path for files, else the label. */
  hay: string;
  /** Lowercased camelCase words of the label, in order (initials tier). */
  words: string[];
  /** First letter of every word. */
  ini: string;
  /** Files only: camelCase and segment words of the whole path, and their first letters (path tier). */
  pwords?: string[];
  pini?: string;
  /** Kind order for ties: file, symbol, route, table. */
  rank: number;
}

export interface Result { entry: Entry; score: number }

/**
 * Score tiers, highest first. PATH is a file matched only through its folders (path segment initials or a
 * substring of the path), below any match on a name, so a folder named like the query does not flood results.
 */
export const EXACT = 6, PREFIX = 5, INITIALS = 4, SUBSTRING = 3, PATH = 2, FUZZY = 1;

const KIND_RANK: Record<EntryKind, number> = { file: 0, symbol: 1, route: 2, table: 3 };

/** `orderService.ts` → order, service, ts; `src/HTTPServer` → src, http, server. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    const spaced = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2');
    for (const w of spaced.split(' ')) if (w) out.push(w.toLowerCase());
  }
  return out;
}

const initialsOf = (words: string[]): string => {
  let ini = '';
  for (const w of words) ini += w[0];
  return ini;
};

function make(e: Entry, hay: string, path?: string): IndexEntry {
  const words = wordsOf(e.label);
  const out: IndexEntry = { ...e, lo: e.label.toLowerCase(), hay, words, ini: initialsOf(words), rank: KIND_RANK[e.kind] };
  if (path) {
    out.pwords = [...wordsOf(dirName(path)), ...words];
    out.pini = initialsOf(out.pwords);
  }
  return out;
}

/** Entries per FileModel and per domain: a FileModel or domain object is replaced whenever it changes, so identity is the cache key. */
const fileCache = new WeakMap<FileModel, IndexEntry[]>();
const domainCache = new WeakMap<DomainIndex, IndexEntry[]>();

function fileEntries(f: FileModel): IndexEntry[] {
  let out = fileCache.get(f);
  if (out) return out;
  out = [];
  const { path } = f;
  const meta = fileMeta(f);
  out.push(make({ kind: 'file', label: baseName(path), detail: dirName(path), path, layer: meta.layer }, path.toLowerCase(), path));
  for (const { sym } of meta.flat) {
    if (sym.kind === 'heading') continue;
    out.push(make(
      { kind: 'symbol', label: sym.name, detail: `${path}:${sym.line}`, path, line: sym.line, layer: meta.layer, symKind: sym.kind },
      sym.name.toLowerCase(),
    ));
  }
  fileCache.set(f, out);
  return out;
}

function domainEntries(domain: DomainIndex): IndexEntry[] {
  let out = domainCache.get(domain);
  if (out) return out;
  out = [];
  for (const r of domain.routes) {
    const label = `${r.method} ${r.fullPath}`;
    out.push(make({ kind: 'route', label, detail: `${r.file}:${r.line}`, path: r.file, line: r.line, layer: 'api', method: r.method, id: r.id }, label.toLowerCase()));
  }
  for (const t of domain.tables) {
    const src = t.sources[0];
    out.push(make(
      { kind: 'table', label: t.name, detail: `table · ${t.orm}`, path: src?.file ?? '', line: src?.line, layer: 'data', id: tableKey(t) },
      t.name.toLowerCase(),
    ));
  }
  domainCache.set(domain, out);
  return out;
}

/**
 * Every file, symbol (headings excluded), route (pages and screens too) and table. Incremental: entries of
 * unchanged files and an unchanged domain are reused, so a live edit re-derives only the edited file.
 */
export function buildIndex(files: Record<string, FileModel>, domain: DomainIndex): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const path in files) {
    const list = fileEntries(files[path]);
    for (let i = 0; i < list.length; i++) out.push(list[i]);
  }
  const d = domainEntries(domain);
  for (let i = 0; i < d.length; i++) out.push(d[i]);
  return out;
}

/** True when every character of `q` appears in `s`, in order. */
function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s.charCodeAt(j) === q.charCodeAt(i)) i++;
  return i === q.length;
}

/**
 * True when `q` splits into pieces that each start at the first letter of a word and continue within
 * that word, words in order (`ordsvc` → **ord**er **s**er**v**i**c**e).
 */
export function initialsMatch(q: string, words: string[]): boolean {
  const failed = new Set<string>();
  const go = (qi: number, wi: number, ci: number): boolean => {
    if (qi === q.length) return true;
    const key = `${qi},${wi},${ci}`;
    if (failed.has(key)) return false;
    const c = q[qi];
    if (wi >= 0) {
      const at = words[wi].indexOf(c, ci);
      if (at >= 0 && go(qi + 1, wi, at + 1)) return true;
    }
    for (let wj = wi + 1; wj < words.length; wj++) {
      if (words[wj][0] === c && go(qi + 1, wj, 1)) return true;
    }
    failed.add(key);
    return false;
  };
  return go(0, -1, 0);
}

function score(e: IndexEntry, q: string, qs: string): number {
  if (e.lo === q) return EXACT;
  if (e.lo.startsWith(q)) return PREFIX;
  // Everything below needs the letters in order somewhere; most entries stop here.
  if (!subsequence(qs, e.hay)) return 0;
  if (e.ini.includes(qs[0]) && initialsMatch(qs, e.words)) return INITIALS;
  if (e.lo.includes(q)) return SUBSTRING;
  if (e.pwords && ((e.pini!.includes(qs[0]) && initialsMatch(qs, e.pwords)) || e.hay.includes(q))) return PATH;
  return FUZZY;
}

/**
 * The best `limit` matches for `q` (case-insensitive): exact label, label prefix, camelCase or path
 * initials, substring, then fuzzy subsequence. Ties go to file, symbol, route, table, then the shorter label.
 */
export function query(index: IndexEntry[], q: string, limit = 50): Result[] {
  const needle = q.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!needle) return [];
  const qs = needle.replace(/ /g, '');
  // One sortable number per hit: tier, then kind, then shorter label, then index order.
  const keys: number[] = [];
  for (let i = 0; i < index.length; i++) {
    const e = index[i];
    const s = score(e, needle, qs);
    if (!s) continue;
    keys.push(s * 1e13 + (3 - e.rank) * 1e12 + (999_999 - Math.min(e.lo.length, 999_999)) * 1e6 + (999_999 - Math.min(i, 999_999)));
  }
  const sorted = Float64Array.from(keys).sort().reverse();
  const out: Result[] = [];
  for (let k = 0; k < sorted.length && out.length < limit; k++) {
    const key = sorted[k];
    const i = 999_999 - (key % 1e6);
    out.push({ entry: index[i], score: Math.floor(key / 1e13) });
  }
  return out;
}
