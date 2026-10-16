import type { ChangeSummary, CodeSymbol, FileModel } from '@shared/types.js';
import { LAYER_ORDER, layerOf, type Layer } from './layers';
import { countSymbols, flattenSymbols, symbolTags, type SymbolTag } from './changes';
import { baseName, dirName, type LiveBadge } from './recent';

/** At this many files and above, folders start collapsed (only the top level shows); below, all start open. */
export const BIG_PROJECT = 2000;
/** Rows (subfolders, then files) an open folder shows at first; each "Show more" adds this many. */
export const DIR_BATCH = 200;
/** Rows (folders and files) rendered across all folders that have no explicit limit. */
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

/**
 * Row ids for keyboard focus. A file's id is its path; folder, "Show more" and symbol ids carry a NUL, which no POSIX
 * path can hold, so no file name can collide with them.
 */
export const symKey = (path: string, s: CodeSymbol): string => `${path}\0s\0${s.qname}:${s.line}`;
export const dirKey = (dir: string): string => `\0d\0${dir}`;
export const moreKey = (dir: string, part: 'dirs' | 'files' = 'files'): string => `\0${part === 'dirs' ? 'M' : 'm'}\0${dir}`;

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

/** The shared empty set of paths. */
export const NO_PATHS: ReadonlySet<string> = new Set();

/** `set` with `add` added and `del` removed, as a new set. */
export function editSet(set: ReadonlySet<string>, add: readonly string[], del: readonly string[] = []): ReadonlySet<string> {
  const next = new Set(set);
  for (const a of add) next.add(a);
  for (const d of del) next.delete(d);
  return next;
}

/** Every folder above `path`, outermost first. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  // From index 1: a leading slash never yields the root ('') as a folder.
  for (let i = path.indexOf('/', 1); i >= 0; i = path.indexOf('/', i + 1)) out.push(path.slice(0, i));
  return out;
}

/** Open (true) and closed (false) folders the user chose, by full path, oldest first. */
export type DirState = ReadonlyMap<string, boolean>;

/**
 * Whether a folder row is open. `paths` are the folders the row stands for (several for a compact chain): it is open
 * only when each is. A folder revealed this session (`revealed`) is open; otherwise the user's choice counts, and
 * without one a folder is open in a project under BIG_PROJECT files and closed above.
 */
export function chainOpen(paths: string[], state: DirState, big: boolean, revealed?: ReadonlySet<string>): boolean {
  return paths.every(p => revealed?.has(p) || (state.get(p) ?? !big));
}

/** The folders above `path` that are closed now, so revealing it opens only those. */
export function closedAbove(path: string, state: DirState, big: boolean, revealed?: ReadonlySet<string>): string[] {
  return ancestors(path).filter(a => !chainOpen([a], state, big, revealed));
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
  | { kind: 'more'; dir: string; part: 'dirs' | 'files'; shown: number; hidden: number; level: number; up: string | null };

/**
 * What the tree renders, depth first. The project root's children are listed like any open folder's children. An
 * open folder renders its subfolders (as compact chains), then its files, each up to its own limit (set by "Show
 * more", keyed by `moreKey(folder, part)`) or, without one, up to DIR_BATCH rows for both together, while the shared
 * budget of ROW_BUDGET rows (folders and files) lasts. The budget goes level by level (breadth first), so a deep
 * subtree never hides the files of a shallower folder. Hidden subfolders get a "more" item after the last shown
 * subfolder, hidden files one after the last shown file. Pinned files, and the folders that hold them, render even
 * past the cap. `navKeys` lists the focusable rows in order, including visible symbol rows.
 */
export function visibleItems(
  root: DirNode,
  dirOpen: (paths: string[]) => boolean,
  rowOpen: (row: Row) => boolean,
  limits: ReadonlyMap<string, number>,
  pins: Iterable<string> = [],
): { items: Item[]; navKeys: string[] } {
  const pinned = new Set(pins);
  const pinnedDirs = new Set<string>();
  for (const p of pinned) for (const d of ancestors(p)) pinnedDirs.add(d);
  type Sub = { chain: DirNode[]; open: boolean; past: boolean };
  type Plan = { dirsShown: number; filesShown: number; subs: Sub[] };
  // Pass 1, breadth first: which subfolders show and are open, and how many files each open folder shows.
  const plans = new Map<DirNode, Plan>();
  let budget = ROW_BUDGET;
  const queue: DirNode[] = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const node = queue[qi];
    const dirsSet = limits.get(moreKey(node.path, 'dirs'));
    const filesSet = limits.get(moreKey(node.path));
    const dirsShown = Math.min(node.dirs.length, dirsSet ?? Math.max(0, Math.min(DIR_BATCH, budget)));
    if (dirsSet === undefined) budget -= dirsShown;
    // Files share DIR_BATCH with the folders shown by default; after "Show more folders" they get a batch of their own.
    const room = dirsSet === undefined ? DIR_BATCH - dirsShown : DIR_BATCH;
    const filesShown = Math.min(node.rows.length, filesSet ?? Math.max(0, Math.min(room, budget)));
    if (filesSet === undefined) budget -= filesShown;
    const subs: Sub[] = [];
    for (let i = 0; i < node.dirs.length; i++) {
      const d = node.dirs[i];
      if (i >= dirsShown && !pinnedDirs.has(d.path)) continue;
      const chain = chainOf(d);
      const open = dirOpen(chain.map(c => c.path));
      subs.push({ chain, open, past: i >= dirsShown });
      if (open) queue.push(chain[chain.length - 1]);
    }
    plans.set(node, { dirsShown, filesShown, subs });
  }
  // Pass 2, depth first: the rows in display order.
  const items: Item[] = [];
  const navKeys: string[] = [];
  const more = (dir: string, part: 'dirs' | 'files', shown: number, hidden: number, level: number, up: string | null) => {
    if (hidden <= 0) return;
    items.push({ kind: 'more', dir, part, shown, hidden, level, up });
    navKeys.push(moreKey(dir, part));
  };
  const walk = (node: DirNode, level: number, up: string | null) => {
    const { dirsShown, filesShown, subs } = plans.get(node)!;
    let extra = 0;
    for (const { chain, open, past } of subs) {
      if (past) extra++;
      const tail = chain[chain.length - 1];
      const key = dirKey(tail.path);
      items.push({ kind: 'dir', node: tail, chain: chain.map(c => c.path), label: chain.map(c => c.name).join('/'), level, open, up });
      navKeys.push(key);
      if (open) walk(tail, level + 1, key);
    }
    more(node.path, 'dirs', dirsShown, node.dirs.length - dirsShown - extra, level, up);
    let extraFiles = 0;
    for (let i = 0; i < node.rows.length; i++) {
      const row = node.rows[i];
      // Past the cap, only pinned rows (selected or changing right now) still render.
      if (i >= filesShown) { if (!pinned.has(row.file.path)) continue; extraFiles++; }
      const ro = row.symbols.length > 0 && rowOpen(row);
      items.push({ kind: 'file', row, open: ro, level, up });
      navKeys.push(row.file.path);
      if (ro) for (const { sym } of row.symbols) navKeys.push(symKey(row.file.path, sym));
    }
    more(node.path, 'files', filesShown, node.rows.length - filesShown - extraFiles, level, up);
  };
  walk(root, 1, null);
  return { items, navKeys };
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
 * chars, else splits the last folder the same way; a single folder of at most 16 chars stays whole. A short name
 * comes back whole, with an empty end.
 */
export function splitName(name: string, kind: 'file' | 'dir' = 'file'): [string, string] {
  const slash = kind === 'dir' ? name.lastIndexOf('/') : -1;
  if (slash >= 0) {
    const last = name.slice(slash + 1);
    if (last.length <= SEGMENT_MAX) return [name.slice(0, slash + 1), last];
    const [head, tail] = splitWord(last);
    return [name.slice(0, slash + 1) + head, tail];
  }
  // A single folder: kept whole up to the same length as a chain's last folder.
  if (kind === 'dir' && name.length <= SEGMENT_MAX) return [name, ''];
  return splitWord(name);
}

function splitWord(name: string): [string, string] {
  if (name.length <= TAIL_MAX) return [name, ''];
  for (let i = name.length - TAIL_MAX; i <= name.length - 4; i++) {
    const a = name[i - 1];
    if ('-_. '.includes(a) || (LOWER.test(a) && UPPER.test(name[i]))) return [name.slice(0, i), name.slice(i)];
  }
  // No word to keep: the last 10 code points, so a surrogate pair is never cut in two (a character made of several
  // code points, like a flag or a joined emoji, can still be).
  const chars = Array.from(name);
  return [chars.slice(0, -10).join(''), chars.slice(-10).join('')];
}

/** Open and closed folders, by full path, stored per project. */
export const treeKey = (root: string): string => `livemap:tree:${root}`;

/** Stored choices as [path, open] pairs, oldest first; anything else is ignored. */
export function parseTreeState(raw: string | null): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return out;
  }
  if (Array.isArray(v)) for (const e of v) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean') out.set(e[0], e[1]);
  return out;
}

/** Stored choices beyond this many drop the oldest. */
const MAX_STORED = 2000;

/** The newest `max` choices as [path, open] pairs. */
export function serializeTreeState(state: DirState, max = MAX_STORED): string {
  return JSON.stringify([...state].slice(-max));
}

export function saveTreeState(root: string, state: DirState): void {
  try {
    globalThis.localStorage?.setItem(treeKey(root), serializeTreeState(state));
  } catch {
    // Private mode, quota or blocked storage: folders stay as set for this page only.
  }
}

/** The project's stored folders; empty when storage is missing, blocked, throws or holds something unreadable. */
export function loadTreeState(root: string): Map<string, boolean> {
  try {
    return parseTreeState(globalThis.localStorage?.getItem(treeKey(root)) ?? null);
  } catch {
    return new Map();
  }
}
