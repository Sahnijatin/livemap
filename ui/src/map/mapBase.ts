import type { FileModel } from '@shared/types.js';
import { dirName } from '../recent';

/**
 * The map's basics the store and the tab bar need at first paint (map levels, which files are code, the hello edge
 * baseline), apart from mapModel so the map itself loads with the Map tab.
 */
export type Level = 'folders' | 'files' | 'functions';

/** Above this many code files, the files and functions levels show only expanded folders. */
export const LARGE_PROJECT = 500;

const NON_CODE = new Set(['other', 'text', 'json', 'yaml', 'toml', 'markdown', 'secret']);

/** Whether a file appears on the map: source code, or config/text with real symbols. */
export function isCode(f: FileModel): boolean {
  if (f.flags.binary || f.flags.tooLarge || f.flags.secret || f.lang === 'secret' || f.lang === 'markdown') return false;
  if (!NON_CODE.has(f.lang)) return true;
  // Other/text/config files count only when the parser found real symbols (not just headings).
  return f.symbols.some(s => s.kind !== 'heading');
}

export const dirId = (dir: string): string => `dir:${dir}`;

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
