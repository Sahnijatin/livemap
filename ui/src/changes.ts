import type { ApiRoute } from '@shared/domain.js';
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

export type FactTone = 'add' | 'chg' | 'del' | 'rt' | 'db' | 'dep' | 'env';
export interface Fact { tone: FactTone; label: string; code: string; note?: string }

const ADD_LABEL: Partial<Record<CodeSymbol['kind'], string>> = { component: 'Component', hook: 'Hook', class: 'Class' };
const short = (sig: string, name: string) => (sig && sig.length <= 72 ? sig : name);
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const list = (xs: string[], n = 3) => xs.slice(0, n).join(', ') + (xs.length > n ? ` +${xs.length - n}` : '');

/**
 * Plain-language facts for a change card, in reading order: code, routes, tables, imports, packages, env.
 * `routes` (the domain index's routes of this file) gives an added route its full mounted path(s); a route
 * with no match keeps the file-level path.
 */
export function changeFacts(c: ChangeSummary, routes: ApiRoute[] = []): Fact[] {
  const out: Fact[] = [];
  for (const s of c.symbols.added) out.push({ tone: 'add', label: ADD_LABEL[s.kind] ?? 'Added', code: short(s.signature, s.name) });
  for (const s of c.symbols.modified) out.push({ tone: 'chg', label: 'Changed', code: s.signatureChanged ? short(s.signature, s.name) : s.name, note: s.signatureChanged ? 'new signature' : undefined });
  for (const s of c.symbols.removed) out.push({ tone: 'del', label: 'Removed', code: s.name });
  for (const r of c.routes.added) {
    const full = [...new Set(routes.filter(x => x.file === c.path && x.method === r.method && x.path === r.path).map(x => x.fullPath))];
    for (const p of full.length ? full : [r.path]) out.push({ tone: 'rt', label: 'Route', code: `${r.method} ${p}`, note: r.handler ? `to ${r.handler}` : undefined });
  }
  for (const r of c.routes.removed) out.push({ tone: 'del', label: 'Route gone', code: `${r.method} ${r.path}` });
  for (const e of c.entities.added) out.push({ tone: 'db', label: 'Table', code: e.name, note: `${e.fields} ${e.fields === 1 ? 'field' : 'fields'}` });
  for (const e of c.entities.changed) {
    const parts = [e.addedFields.length && `+${list(e.addedFields)}`, e.removedFields.length && `−${list(e.removedFields)}`, e.changedFields.length && `changed ${list(e.changedFields)}`].filter(Boolean);
    out.push({ tone: 'db', label: 'Table', code: e.name, note: parts.join(' · ') || undefined });
  }
  for (const e of c.entities.removed) out.push({ tone: 'del', label: 'Table gone', code: e.name });
  if (c.imports.added.length) out.push({ tone: 'add', label: 'Now uses', code: list(c.imports.added.map(fileName)) });
  if (c.imports.removed.length) out.push({ tone: 'del', label: 'Stopped using', code: list(c.imports.removed.map(fileName)) });
  if (c.imports.externalAdded.length) out.push({ tone: 'dep', label: 'Package', code: list(c.imports.externalAdded) });
  for (const d of c.deps?.added ?? []) out.push({ tone: 'dep', label: 'Dependency', code: `${d.name} ${d.version}` });
  for (const d of c.deps?.changed ?? []) out.push({ tone: 'dep', label: 'Dependency', code: d.name, note: `${d.from} to ${d.version}` });
  for (const d of c.deps?.removed ?? []) out.push({ tone: 'del', label: 'Dependency gone', code: d.name });
  if (c.env.added.length) out.push({ tone: 'env', label: 'Env', code: list(c.env.added) });
  if (c.env.removed.length) out.push({ tone: 'del', label: 'Env gone', code: list(c.env.removed) });
  return out;
}
