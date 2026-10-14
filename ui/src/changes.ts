import type { ChangeSummary, CodeSymbol, FileModel } from '@shared/types.js';

export type SymbolTag = 'new' | 'changed';

/** The most recent change for a path, if any. */
export function latestChange(changes: ChangeSummary[], path: string): ChangeSummary | undefined {
  for (let i = changes.length - 1; i >= 0; i--) if (changes[i].path === path) return changes[i];
  return undefined;
}

/** New-file line numbers of the lines a change added (the `+` lines of its hunks). */
export function changedLines(change: ChangeSummary | undefined): Set<number> {
  const out = new Set<number>();
  if (!change || change.kind === 'deleted') return out;
  for (const h of change.hunks) {
    let n = Math.max(1, h.newStart);
    for (const line of h.lines) {
      const c = line[0];
      if (c === '+') out.add(n++);
      else if (c === ' ') n++;
      // '-' lines and '\ No newline' markers do not exist in the new file.
    }
  }
  return out;
}

/**
 * NEW / CHANGED tags per symbol qname from a change. A modified method also reports its
 * container as modified, so a container is tagged only when none of its descendants are.
 */
export function symbolTags(file: FileModel, change: ChangeSummary | undefined): Map<string, SymbolTag> {
  const tags = new Map<string, SymbolTag>();
  if (!change || change.kind === 'deleted') return tags;
  const added = new Set(change.symbols.added.map(s => s.qname));
  const modified = new Set(change.symbols.modified.map(s => s.qname));
  const walk = (s: CodeSymbol): boolean => {
    let childTagged = false;
    for (const c of s.children) if (walk(c)) childTagged = true;
    if (added.has(s.qname)) tags.set(s.qname, 'new');
    else if (modified.has(s.qname) && !childTagged) tags.set(s.qname, 'changed');
    return childTagged || tags.has(s.qname);
  };
  for (const s of file.symbols) walk(s);
  return tags;
}

/** Depth-first list of symbols with their nesting depth. */
export function flattenSymbols(symbols: CodeSymbol[], depth = 0, out: { sym: CodeSymbol; depth: number }[] = []): { sym: CodeSymbol; depth: number }[] {
  for (const s of symbols) {
    out.push({ sym: s, depth });
    flattenSymbols(s.children, depth + 1, out);
  }
  return out;
}

export function countSymbols(symbols: CodeSymbol[]): number {
  let n = 0;
  for (const s of symbols) n += 1 + countSymbols(s.children);
  return n;
}
