import type { ChangeSummary, CodeSymbol, FileModel } from '@shared/types.js';
import { LAYER_ORDER, layerOf, type Layer } from './layers';
import { countSymbols, flattenSymbols, symbolTags, type SymbolTag } from './changes';
import { baseName, dirName } from './recent';

/** Above this many files, folders start collapsed. */
export const BIG_PROJECT = 2000;
/** File rows an open folder shows at first; each "Show more" adds this many. */
export const DIR_BATCH = 200;
/** File rows rendered across all folders that have no explicit limit. */
export const ROW_BUDGET = 1000;

export type FlatSymbol = { sym: CodeSymbol; depth: number };
export interface FileMeta { layer: Layer; flat: FlatSymbol[]; total: number }
export interface Row { file: FileModel; meta: FileMeta; symbols: FlatSymbol[]; forceOpen: boolean }
export interface Group { dir: string; layer: Layer; rows: Row[] }

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

export function buildGroups(files: Record<string, FileModel>, q: string): { groups: Group[]; layers: Layer[] } {
  const byDir = new Map<string, Row[]>();
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
    const dir = dirName(file.path);
    const row: Row = { file, meta, symbols, forceOpen };
    const list = byDir.get(dir);
    if (list) list.push(row); else byDir.set(dir, [row]);
  }
  const groups: Group[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const rows = byDir.get(dir)!.sort((a, b) => baseName(a.file.path).localeCompare(baseName(b.file.path)));
    const tally = new Map<Layer, number>();
    for (const r of rows) tally.set(r.meta.layer, (tally.get(r.meta.layer) ?? 0) + 1);
    const layer = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    groups.push({ dir, layer, rows });
  }
  return { groups, layers: LAYER_ORDER.filter(l => layersSeen.has(l)) };
}

export type Item =
  | { kind: 'dir'; group: Group; open: boolean }
  | { kind: 'file'; row: Row; open: boolean }
  | { kind: 'more'; dir: string; shown: number; hidden: number };

/**
 * What the tree renders. Folder headers always render. An open folder renders its file rows up
 * to its own limit (`dirLimit`, set by "Show more") or, without one, up to DIR_BATCH and while
 * the shared budget of ROW_BUDGET rows lasts. A folder with rows left over gets a "more" item.
 * Pinned rows render even past the cap. `navKeys` lists the focusable rows in order, including visible symbol rows.
 */
export function visibleItems(
  groups: Group[],
  dirOpen: (dir: string) => boolean,
  rowOpen: (row: Row) => boolean,
  dirLimit: Record<string, number>,
  pinned: (path: string) => boolean = () => false,
): { items: Item[]; navKeys: string[]; rendered: number } {
  const items: Item[] = [];
  const navKeys: string[] = [];
  let budget = ROW_BUDGET;
  let rendered = 0;
  for (const group of groups) {
    const open = dirOpen(group.dir);
    items.push({ kind: 'dir', group, open });
    navKeys.push(dirKey(group.dir));
    if (!open) continue;
    const explicit = dirLimit[group.dir];
    const cap = explicit ?? Math.max(0, Math.min(DIR_BATCH, budget));
    const shown = Math.min(group.rows.length, cap);
    if (explicit === undefined) budget -= shown;
    let extra = 0;
    for (let i = 0; i < group.rows.length; i++) {
      const row = group.rows[i];
      // Past the cap, only pinned rows (selected or changing right now) still render.
      if (i >= shown) { if (!pinned(row.file.path)) continue; extra++; }
      const ro = row.symbols.length > 0 && rowOpen(row);
      items.push({ kind: 'file', row, open: ro });
      navKeys.push(row.file.path);
      if (ro) for (const { sym } of row.symbols) navKeys.push(symKey(row.file.path, sym));
    }
    rendered += shown + extra;
    if (shown + extra < group.rows.length) {
      items.push({ kind: 'more', dir: group.dir, shown, hidden: group.rows.length - shown - extra });
      navKeys.push(moreKey(group.dir));
    }
  }
  return { items, navKeys, rendered };
}
