import type { FileModel } from '../shared/types.js';
import type { UsedByEntry } from '../shared/protocol.js';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const usedByStats = { scans: 0 };

const IDENT = /^[\w$]+$/;

/**
 * Identifier tokens (maximal [\w$] runs) per file, for its latest text only. Matching a name
 * against them is the same test as the whole-word regex below, and the index is rebuilt every
 * second during edits while almost every importer's text is unchanged.
 */
const TOKENS = new Map<string, { text: string; tokens: Set<string> }>();
const TOKENS_MAX_FILES = 200_000;

function tokensOf(path: string, text: string): Set<string> {
  const hit = TOKENS.get(path);
  if (hit && hit.text === text) return hit.tokens;
  usedByStats.scans++;
  const tokens = new Set(text.match(/[\w$]+/g) ?? []);
  if (!hit && TOKENS.size >= TOKENS_MAX_FILES) TOKENS.clear();
  TOKENS.set(path, { text, tokens });
  return tokens;
}

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
      let uses: (path: string, t: string) => boolean;
      if (IDENT.test(name)) {
        uses = (p, t) => tokensOf(p, t).has(name);
      } else {
        // \b-equivalent boundary that also treats `$` as part of an identifier.
        const re = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
        uses = (_p, t) => re.test(t);
      }
      const usedIn = users.filter(u => {
        const t = text(u);
        return t !== null && uses(u, t);
      });
      if (usedIn.length) out.push({ file: f.path, symbol: name, usedIn: [...new Set(usedIn)].sort(cmp) });
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || cmp(a.symbol, b.symbol));
}
