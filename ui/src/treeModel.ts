import type { ChangeSummary, CodeSymbol, FileModel } from '@shared/types.js';
import { LAYER_ORDER, layerOf, type Layer } from './layers';
import { countSymbols, flattenSymbols, symbolTags, type SymbolTag } from './changes';
import { baseName, dirName, type LiveBadge } from './recent';

/** At this many files and above, folders start collapsed (only the top level shows); below, all start open. */
export const BIG_PROJECT = 2000;
/** Rows (subfolders, then files) an open folder shows at first; each "Show more" adds this many. */
export const DIR_BATCH = 200;
/** File rows rendered across all folders that have no explicit limit. */
export const ROW_BUDGET = 1000;

export type FlatSymbol = { sym: CodeSymbol; depth: number };
export interface FileMeta { layer: Layer; flat: FlatSymbol[]; total: number }
export interface Row { file: FileModel; name: string; meta: FileMeta; symbols: FlatSymbol[]; forceOpen: boolean }
/** A folder: `path` is its full path ('' for the project root), `count` every file below it, `layer` the most common one. */
export interface DirNode { path: string; name: string; dirs: DirNode[]; rows: Row[]; count: number; layer: Layer }

/** Per-FileModel derived data; a FileModel object is replaced whenever it changes, so identity is the cache key. */
const metaCache = new WeakMap<FileModel, FileMeta>();
export function fileMeta(file: FileModel): FileMeta {
  let m = metaCache.get(file);
  if (!m) {
    m = { layer: layerOf(file.path, file), flat: flattenSymbols(file.symbols), total: countSymbols(file.symbols) };
    metaCache.set(file, m);
  }
  return m;
}

/** Symbol tags for a (file, change) pair, cached so unchanged rows keep the same Map. */
const tagCache = new WeakMap<ChangeSummary, WeakMap<FileModel, Map<string, SymbolTag>>>();
export function cachedTags(file: FileModel, change: ChangeSummary): Map<string, SymbolTag> {
  let byFile = tagCache.get(change);
  if (!byFile) { byFile = new WeakMap(); tagCache.set(change, byFile); }
  let tags = byFile.get(file);
  if (!tags) { tags = symbolTags(file, change); byFile.set(file, tags); }
  return tags;
}

export const symKey = (path: string, s: CodeSymbol): string => `${path}#${s.qname}:${s.line}`;
export const dirKey = (dir: string): string => `dir:${dir}`;
export const moreKey = (dir: string): string => `more:${dir}`;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Case-insensitive natural order (item2 before item10); names that differ only by case keep a fixed order. */
export const compareNames = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const LAYER_INDEX = new Map(LAYER_ORDER.map((l, i) => [l, i]));

/**
 * The folder tree of the files that match `q` (by path, or by symbol name, which keeps only the matching symbols).
 * Folders come first, then files, each in name order. Callers memoize it by the files object.
 */
export function buildTree(files: Record<string, FileModel>, q: string): { root: DirNode; layers: Layer[] } {
  const root: DirNode = { path: '', name: '', dirs: [], rows: [], count: 0, layer: LAYER_ORDER[0] };
  const byPath = new Map<string, DirNode>([['', root]]);
  const ensure = (path: string): DirNode => {
    let n = byPath.get(path);
    if (n) return n;
    n = { path, name: baseName(path), dirs: [], rows: [], count: 0, layer: LAYER_ORDER[0] };
    byPath.set(path, n);
    ensure(dirName(path)).dirs.push(n);
    return n;
  };
  const layersSeen = new Set<Layer>();
  for (const file of Object.values(files)) {
    const meta = fileMeta(file);
    let symbols = meta.flat;
    let forceOpen = false;
    if (q) {
      const fileHit = file.path.toLowerCase().includes(q);
      if (!fileHit) {
        const hits = meta.flat.filter(s => s.sym.name.toLowerCase().includes(q));
        if (hits.length === 0) continue;
        symbols = hits.map(s => ({ ...s, depth: 0 }));
        forceOpen = true;
      }
    }
    layersSeen.add(meta.layer);
    ensure(dirName(file.path)).rows.push({ file, name: baseName(file.path), meta, symbols, forceOpen });
  }
  finish(root);
  return { root, layers: LAYER_ORDER.filter(l => layersSeen.has(l)) };
}

/** Sorts a folder's children and fills in counts and dominant layers, bottom up; returns the layer tally. */
function finish(n: DirNode): number[] {
  n.dirs.sort((a, b) => compareNames(a.name, b.name));
  n.rows.sort((a, b) => compareNames(a.name, b.name));
  const tally = new Array<number>(LAYER_ORDER.length).fill(0);
  let count = n.rows.length;
  for (const r of n.rows) tally[LAYER_INDEX.get(r.meta.layer)!]++;
  for (const d of n.dirs) {
    const t = finish(d);
    count += d.count;
    for (let i = 0; i < t.length; i++) tally[i] += t[i];
  }
  let best = 0;
  for (let i = 1; i < tally.length; i++) if (tally[i] > tally[best]) best = i;
  n.count = count;
  n.layer = LAYER_ORDER[best];
  return tally;
}

/** A folder and the single-folder folders below it that show as one compact row (`src/app/(admin)`). */
export function chainOf(node: DirNode): DirNode[] {
  const chain = [node];
  for (let n = node; n.rows.length === 0 && n.dirs.length === 1; ) { n = n.dirs[0]; chain.push(n); }
  return chain;
}

/** Every folder above `path`, outermost first. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i));
  return out;
}

/**
 * Whether a folder row is open. `paths` are the folders the row stands for (several for a compact chain): it is open
 * only when each is. A folder without a stored choice is open in a project under BIG_PROJECT files and closed above.
 */
export function chainOpen(paths: string[], state: Record<string, boolean>, big: boolean): boolean {
  return paths.every(p => {
    const v = state[p];
    return typeof v === 'boolean' ? v : !big;
  });
}

/** The folders above `path` that are closed now, so revealing it opens only those. */
export function closedAbove(path: string, state: Record<string, boolean>, big: boolean): string[] {
  return ancestors(path).filter(a => !chainOpen([a], state, big));
}

export type Activity = LiveBadge | 'now';
const RANK: Record<Activity, number> = { new: 1, edited: 2, now: 3 };

/** For each folder above a live file, its strongest activity: the file being written, then edits, then new files. */
export function dirActivity(live: Record<string, LiveBadge>, target: string | null): Map<string, Activity> {
  const out = new Map<string, Activity>();
  const mark = (path: string, a: Activity) => {
    for (const d of ancestors(path)) { const had = out.get(d); if (!had || RANK[a] > RANK[had]) out.set(d, a); }
  };
  for (const [path, badge] of Object.entries(live)) mark(path, badge);
  if (target !== null) mark(target, 'now');
  return out;
}

export type Item =
  | { kind: 'dir'; node: DirNode; chain: string[]; label: string; level: number; open: boolean; up: string | null }
  | { kind: 'file'; row: Row; open: boolean; level: number; up: string | null }
  | { kind: 'more'; dir: string; shown: number; hidden: number; level: number };

/**
 * What the tree renders, depth first. Root's children always render. An open folder renders its subfolders (as
 * compact chains), then its files: up to its own limit (`dirLimit`, set by "Show more") or, without one, up to
 * DIR_BATCH, with files only while the shared budget of ROW_BUDGET file rows lasts. A folder with rows left over
 * gets a "more" item. Pinned files, and the folders that hold them, render even past the cap. `navKeys` lists the
 * focusable rows in order, including visible symbol rows.
 */
export function visibleItems(
  root: DirNode,
  dirOpen: (paths: string[], level: number) => boolean,
  rowOpen: (row: Row) => boolean,
  dirLimit: Record<string, number>,
  pins: Iterable<string> = [],
): { items: Item[]; navKeys: string[]; rendered: number } {
  const items: Item[] = [];
  const navKeys: string[] = [];
  const pinned = new Set(pins);
  const pinnedDirs = new Set<string>();
  for (const p of pinned) for (const d of ancestors(p)) pinnedDirs.add(d);
  let budget = ROW_BUDGET;
  let rendered = 0;
  const walk = (node: DirNode, level: number, up: string | null) => {
    const explicit = dirLimit[node.path];
    const limit = explicit ?? DIR_BATCH;
    const dirsShown = Math.min(node.dirs.length, limit);
    let extra = 0;
    for (let i = 0; i < node.dirs.length; i++) {
      const d = node.dirs[i];
      if (i >= dirsShown) { if (!pinnedDirs.has(d.path)) continue; extra++; }
      const chain = chainOf(d);
      const tail = chain[chain.length - 1];
      const paths = chain.map(c => c.path);
      const open = dirOpen(paths, level);
      const key = dirKey(tail.path);
      items.push({ kind: 'dir', node: tail, chain: paths, label: chain.map(c => c.name).join('/'), level, open, up });
      navKeys.push(key);
      if (open) walk(tail, level + 1, key);
    }
    const cap = explicit !== undefined ? limit - dirsShown : Math.max(0, Math.min(limit - dirsShown, budget));
    const filesShown = Math.min(node.rows.length, cap);
    if (explicit === undefined) budget -= filesShown;
    const fileUp = node.path === '' ? null : dirKey(node.path);
    let extraFiles = 0;
    for (let i = 0; i < node.rows.length; i++) {
      const row = node.rows[i];
      // Past the cap, only pinned rows (selected or changing right now) still render.
      if (i >= filesShown) { if (!pinned.has(row.file.path)) continue; extraFiles++; }
      const ro = row.symbols.length > 0 && rowOpen(row);
      items.push({ kind: 'file', row, open: ro, level, up: fileUp });
      navKeys.push(row.file.path);
      if (ro) for (const { sym } of row.symbols) navKeys.push(symKey(row.file.path, sym));
    }
    rendered += filesShown + extraFiles;
    const shown = dirsShown + filesShown;
    const total = node.dirs.length + node.rows.length;
    if (shown + extra + extraFiles < total) {
      items.push({ kind: 'more', dir: node.path, shown, hidden: total - shown - extra - extraFiles, level });
      navKeys.push(moreKey(node.path));
    }
  };
  walk(root, 1, null);
  return { items, navKeys, rendered };
}

/** Names up to this long are not split; a split end is at most this long. */
const TAIL_MAX = 14;
/** The last folder of a chain up to this long is kept whole as the end. */
const SEGMENT_MAX = 16;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

/**
 * A name split for middle truncation into a start (which ellipsizes) and an end (which always shows). A file keeps
 * its last word and extension: the longest end of at most 14 chars that starts after `-`, `_`, `.`, a space or a
 * lower-to-upper case change, else its last 10 chars. A folder row keeps its last folder when that is at most 16
 * chars, else splits the last folder the same way. A short name comes back whole, with an empty end.
 */
export function splitName(name: string, kind: 'file' | 'dir' = 'file'): [string, string] {
  const slash = kind === 'dir' ? name.lastIndexOf('/') : -1;
  if (slash >= 0) {
    const last = name.slice(slash + 1);
    if (last.length <= SEGMENT_MAX) return [name.slice(0, slash + 1), last];
    const [head, tail] = splitWord(last);
    return [name.slice(0, slash + 1) + head, tail];
  }
  return splitWord(name);
}

function splitWord(name: string): [string, string] {
  if (name.length <= TAIL_MAX) return [name, ''];
  for (let i = name.length - TAIL_MAX; i <= name.length - 4; i++) {
    const a = name[i - 1];
    if ('-_. '.includes(a) || (LOWER.test(a) && UPPER.test(name[i]))) return [name.slice(0, i), name.slice(i)];
  }
  return [name.slice(0, -10), name.slice(-10)];
}

/** Open and closed folders, by full path, stored per project. */
export const treeKey = (root: string): string => `livemap:tree:${root}`;
/** Stored choices beyond this many drop the oldest. */
const MAX_STORED = 2000;

export function parseTreeState(raw: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (typeof b === 'boolean') out[k] = b;
  return out;
}

/** The project's stored folders; empty when storage is missing, blocked, throws or holds something unreadable. */
export function loadTreeState(root: string): Record<string, boolean> {
  try {
    return parseTreeState(globalThis.localStorage?.getItem(treeKey(root)) ?? null);
  } catch {
    return {};
  }
}

export function saveTreeState(root: string, state: Record<string, boolean>): void {
  try {
    const entries = Object.entries(state);
    globalThis.localStorage?.setItem(treeKey(root), JSON.stringify(Object.fromEntries(entries.slice(-MAX_STORED))));
  } catch {
    // Private mode, quota or blocked storage: folders stay as set for this page only.
  }
}
