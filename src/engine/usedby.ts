import type { FileModel } from '../shared/types.js';
import type { UsedByEntry } from '../shared/protocol.js';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Approximate "used by" index: for each exported top-level symbol S of file F, the files that
 * import F and mention S as a whole word. Only symbols with at least one user are listed.
 */
export function buildUsedBy(files: FileModel[], contents: (p: string) => string | null): UsedByEntry[] {
  const importers = new Map<string, string[]>();
  for (const f of files) {
    for (const target of f.imports.local) {
      const list = importers.get(target);
      if (list) list.push(f.path); else importers.set(target, [f.path]);
    }
  }
  const textCache = new Map<string, string | null>();
  const text = (p: string): string | null => {
    if (!textCache.has(p)) textCache.set(p, contents(p));
    return textCache.get(p)!;
  };
  const out: UsedByEntry[] = [];
  for (const f of files) {
    const users = importers.get(f.path);
    if (!users) continue;
    const names = new Set(f.symbols.filter(s => s.exported && s.name).map(s => s.name));
    for (const name of names) {
      // \b-equivalent boundary that also treats `$` as part of an identifier.
      const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
      const usedIn = users.filter(u => {
        const t = text(u);
        return t !== null && re.test(t);
      });
      if (usedIn.length) out.push({ file: f.path, symbol: name, usedIn: [...new Set(usedIn)].sort(cmp) });
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || cmp(a.symbol, b.symbol));
}
