import type { ChangeSummary, FileModel, Flag, SymbolKind } from '@shared/types.js';
import { LAYER_ORDER, type Layer } from '../layers';
import { cachedTags, fileMeta } from '../treeModel';
import { baseName, dirName, type LiveBadge } from '../recent';

export type Level = 'folders' | 'files' | 'functions';

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

/** Above this many code files, the files and functions levels show only expanded folders. */
export const LARGE_PROJECT = 500;
export const MAX_ROWS = 8;

const NON_CODE = new Set(['other', 'text', 'json', 'yaml', 'toml', 'markdown', 'secret']);

/** Whether a file appears on the map: source code, or config/text with real symbols. */
export function isCode(f: FileModel): boolean {
  if (f.flags.binary || f.flags.tooLarge || f.flags.secret || f.lang === 'secret' || f.lang === 'markdown') return false;
  if (!NON_CODE.has(f.lang)) return true;
  // Other/text/config files count only when the parser found real symbols (not just headings).
  return f.symbols.some(s => s.kind !== 'heading');
}

export const dirId = (dir: string): string => `dir:${dir}`;
const byStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const LAYER_RANK = new Map(LAYER_ORDER.map((l, i) => [l, i]));

/** Code files on the map (the Map tab badge). */
export function codeFileCount(files: Record<string, FileModel>): number {
  let n = 0;
  for (const p in files) if (isCode(files[p])) n++;
  return n;
}

/**
 * Every edge id `buildMap` can produce for these files, at file level (`a->b`) and folder level
 * (`dir:x->dir:y`): the baseline captured at hello, against which later edges read as new.
 */
export function edgeBaseline(files: Record<string, FileModel>): Set<string> {
  const out = new Set<string>();
  for (const p in files) {
    const f = files[p];
    if (!isCode(f)) continue;
    const from = dirName(f.path);
    for (const imp of f.imports.local) {
      const g = files[imp];
      if (!g || imp === f.path || !isCode(g)) continue;
      out.add(`${f.path}->${imp}`);
      const to = dirName(imp);
      if (to !== from) out.add(`${dirId(from)}->${dirId(to)}`);
    }
  }
  return out;
}

export function buildMap(input: MapInput, level: Level, expanded: Set<string>): MapGraph {
  const { files, recent, changes, flags, target, helloEdges } = input;

  // Code files, sorted by path.
  const code: FileModel[] = [];
  for (const p in files) if (isCode(files[p])) code.push(files[p]);
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
    let layer: Layer = 'core', best = -1, bestRank = Infinity;
    for (const [l, n] of g.tally) {
      const rank = LAYER_RANK.get(l) ?? 99;
      if (n > best || (n === best && rank < bestRank)) { layer = l; best = n; bestRank = rank; }
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
