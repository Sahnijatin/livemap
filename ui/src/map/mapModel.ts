import type { ChangeSummary, FileModel, Flag, SymbolKind } from '@shared/types.js';
import { LAYER_ORDER, type Layer } from '../layers';
import { cachedTags, fileMeta } from '../treeModel';
import { baseName, dirName, type LiveBadge } from '../recent';
import { LARGE_PROJECT, dirId, isCode, type Level } from './mapBase';

export type { Level } from './mapBase';

export interface MapFolder {
  id: string; path: string; label: string; layer: Layer; files: string[];
  counts: { files: number; symbols: number; routes: number; tables: number };
  isNew: boolean;
}
export interface MapFile {
  id: string; folder: string; label: string; layer: Layer; symbols: number;
  rows: { name: string; kind: SymbolKind; tag?: 'new' | 'changed' }[];
  isNew: boolean; isLive: boolean; isFlagged: boolean;
}
export interface MapEdge { id: string; source: string; target: string; weight: number; isNew: boolean }
export interface MapGraph { level: Level; folders: MapFolder[]; files: MapFile[]; edges: MapEdge[]; large: boolean }
export interface MapInput {
  files: Record<string, FileModel>;
  recent: Record<string, LiveBadge>;
  changes: ChangeSummary[];
  flags: Flag[];
  target: string | null;
  helloEdges: Set<string>;
}

export { LARGE_PROJECT, codeFileCount, dirId, edgeBaseline, isCode } from './mapBase';
export const MAX_ROWS = 8;

const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LAYER_RANK = new Map(LAYER_ORDER.map((l, i) => [l, i]));
/** Markdown every package has, which does not make a folder Docs. */
const BOILERPLATE = /^(readme|changelog|license|contributing|code_of_conduct|security|authors|history)(\.|$)/i;

/**
 * The large-project note for a level: the folders level says it shows folders; the files and functions levels ask to
 * open a folder, then count the folders still closed.
 */
export function largeNote(level: Level, large: boolean, open: number, total: number): string | null {
  if (!large) return null;
  if (level === 'folders') return 'Large project: showing folders. Open one to see its files.';
  if (!open) return `Large project: open a folder to see its ${level}.`;
  const closed = total - open;
  return closed > 0 ? `${closed.toLocaleString()} ${closed === 1 ? 'folder is' : 'folders are'} closed.` : null;
}

export function buildMap(input: MapInput, level: Level, expanded: Set<string>): MapGraph {
  const { files, recent, changes, flags, target, helloEdges } = input;

  // Code files, sorted by path; Markdown files per folder (not README, CHANGELOG and the like): a folder that is
  // mostly Markdown is Docs, even with a script in it.
  const code: FileModel[] = [];
  const docs = new Map<string, number>();
  for (const p in files) {
    const f = files[p];
    if (isCode(f)) code.push(f);
    else if (f.lang === 'markdown' && !BOILERPLATE.test(baseName(p))) { const d = dirName(p); docs.set(d, (docs.get(d) ?? 0) + 1); }
  }
  code.sort((a, b) => byStr(a.path, b.path));
  const large = code.length > LARGE_PROJECT;

  // Folders.
  const folderMap = new Map<string, { path: string; files: string[]; tally: Map<Layer, number>; symbols: number; routes: number; tables: number; isNew: boolean }>();
  const dirOf = new Map<string, string>();
  for (const f of code) {
    const dir = dirName(f.path);
    dirOf.set(f.path, dir);
    let g = folderMap.get(dir);
    if (!g) { g = { path: dir, files: [], tally: new Map(), symbols: 0, routes: 0, tables: 0, isNew: false }; folderMap.set(dir, g); }
    const meta = fileMeta(f);
    g.files.push(f.path);
    g.tally.set(meta.layer, (g.tally.get(meta.layer) ?? 0) + 1);
    g.symbols += meta.total;
    g.routes += f.routes.length;
    g.tables += f.entities.length;
    if (recent[f.path] === 'new') g.isNew = true;
  }
  const folders: MapFolder[] = [];
  for (const dir of [...folderMap.keys()].sort(byStr)) {
    const g = folderMap.get(dir)!;
    const md = docs.get(dir) ?? 0;
    let layer: Layer = 'core', best = -1, bestRank = Infinity;
    if (md > g.files.length) layer = 'docs';
    else {
      for (const [l, n] of g.tally) {
        const rank = LAYER_RANK.get(l) ?? 99;
        if (n > best || (n === best && rank < bestRank)) { layer = l; best = n; bestRank = rank; }
      }
    }
    folders.push({
      id: dirId(dir), path: dir, label: dir === '' ? 'Project root' : dir, layer, files: g.files,
      counts: { files: g.files.length, symbols: g.symbols, routes: g.routes, tables: g.tables }, isNew: g.isNew,
    });
  }

  if (level === 'folders') {
    const agg = new Map<string, MapEdge>();
    for (const f of code) {
      const from = dirOf.get(f.path)!;
      for (const imp of f.imports.local) {
        const to = dirOf.get(imp);
        if (to === undefined || to === from) continue;
        const id = `${dirId(from)}->${dirId(to)}`;
        const e = agg.get(id);
        if (e) e.weight++;
        else agg.set(id, { id, source: dirId(from), target: dirId(to), weight: 1, isNew: !helloEdges.has(id) });
      }
    }
    const edges = [...agg.values()].sort((a, b) => byStr(a.id, b.id));
    return { level, folders, files: [], edges, large };
  }

  // Files and functions levels.
  const shown = large ? code.filter(f => expanded.has(dirId(dirOf.get(f.path)!))) : code;
  const shownSet = new Set<string>();
  for (const f of shown) shownSet.add(f.path);

  const flagged = new Set<string>();
  for (const fl of flags) if (fl.target) flagged.add(fl.target);

  let latest: Map<string, ChangeSummary> | null = null;
  if (level === 'functions') {
    latest = new Map();
    for (const c of changes) {
      const prev = latest.get(c.path);
      if (!prev || c.at >= prev.at) latest.set(c.path, c);
    }
  }

  const outFiles: MapFile[] = [];
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  for (const f of shown) {
    const meta = fileMeta(f);
    const rows: MapFile['rows'] = [];
    if (latest) {
      const ch = latest.get(f.path);
      const tags = ch ? cachedTags(f, ch) : null;
      const n = Math.min(MAX_ROWS, f.symbols.length);
      for (let i = 0; i < n; i++) {
        const s = f.symbols[i];
        const tag = tags?.get(s.qname);
        rows.push(tag ? { name: s.name, kind: s.kind, tag } : { name: s.name, kind: s.kind });
      }
    }
    outFiles.push({
      id: f.path, folder: dirId(dirOf.get(f.path)!), label: baseName(f.path), layer: meta.layer, symbols: meta.total, rows,
      isNew: recent[f.path] === 'new', isLive: f.path === target, isFlagged: flagged.has(f.path),
    });
    for (const imp of f.imports.local) {
      if (!shownSet.has(imp) || imp === f.path) continue;
      const id = `${f.path}->${imp}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, source: f.path, target: imp, weight: 1, isNew: !helloEdges.has(id) });
    }
  }
  edges.sort((a, b) => byStr(a.id, b.id));
  return { level, folders, files: outFiles, edges, large };
}
