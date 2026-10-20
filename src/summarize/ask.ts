import type { DomainIndex } from '../shared/domain.js';
import type { UsedByEntry } from '../shared/protocol.js';
import type { ChangeSummary, CodeSymbol, FileModel } from '../shared/types.js';

export const ASK_SYSTEM = [
  'You answer questions about a software project for the developer working on it.',
  'You get a map of the project: its stack, routes, tables, files with their symbols, how files connect (imports and used-by), recent changes and the source of the most relevant files.',
  'Answer from that context. Name the files and functions you rely on (as `path` or `path:symbol`). When the context does not hold the answer, say so and say which file to look at.',
  'Be concise: a few short paragraphs or a short list. Plain text with simple markdown (lists, `code`) only.',
].join(' ');

export const MAX_QUESTION = 2_000;
/** About 9k tokens of context: room for the map plus a few files, well under every provider's window. */
const BUDGET = 36_000;
const FOCUS_CHARS = 12_000;
const FILE_CHARS = 5_000;
const MAX_FILES = 4;
const MAX_INDEX_FILES = 400;

export interface AskInput {
  name: string;
  files: FileModel[];
  usedBy: UsedByEntry[];
  domain: DomainIndex;
  changes: ChangeSummary[];
  question: string;
  /** The file open in the inspector, when the question is about it. */
  focus?: string;
  /** A file's text, or null when it may not be sent (secret, binary, too large) or is gone. */
  content: (path: string) => string | null;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'where', 'which', 'when', 'how', 'does', 'this', 'that', 'from', 'into', 'are', 'is', 'it', 'its', 'of', 'to', 'in', 'on', 'a', 'an', 'do', 'why', 'who', 'can', 'file', 'files', 'code', 'function', 'used', 'use', 'work', 'works', 'there', 'all', 'any', 'me', 'my', 'we', 'our', 'you', 'be', 'by', 'or', 'not', 'about']);

/** Lowercase words of 3+ characters (camelCase and snake_case split), minus filler. */
export function terms(text: string): string[] {
  const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return [...new Set(words.filter(w => w.length >= 3 && !STOP.has(w)))];
}

const flatten = (syms: CodeSymbol[], out: CodeSymbol[] = []): CodeSymbol[] => {
  for (const s of syms) { out.push(s); flatten(s.children, out); }
  return out;
};

const sendable = (f: FileModel): boolean => f.lang !== 'secret' && !f.flags.secret && !f.flags.binary && !f.flags.tooLarge;

/** How well a file matches the question: path words weigh most, then symbol names, routes and tables. */
function score(f: FileModel, qs: string[]): number {
  if (!qs.length) return 0;
  const path = f.path.toLowerCase();
  const names = flatten(f.symbols).map(s => s.name.toLowerCase());
  const extra = [...f.routes.map(r => r.path.toLowerCase()), ...f.entities.map(e => e.table.toLowerCase())];
  let n = 0;
  for (const q of qs) {
    if (path.includes(q)) n += 3;
    if (names.some(s => s === q)) n += 3;
    else if (names.some(s => s.includes(q))) n += 1;
    if (extra.some(s => s.includes(q))) n += 2;
  }
  return n;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}\n[... cut]`);

/** The project context for one question, within a fixed character budget. Never includes secret, binary or too-large files. */
export function buildAskContext(input: AskInput): string {
  const { files, domain, usedBy, changes, focus } = input;
  const byPath = new Map(files.map(f => [f.path, f]));
  const importers = new Map<string, string[]>();
  for (const f of files) for (const to of f.imports.local) {
    const list = importers.get(to);
    if (list) list.push(f.path); else importers.set(to, [f.path]);
  }
  const qs = terms(input.question);
  const ranked = files
    .filter(f => f.path !== focus)
    .map(f => ({ f, s: score(f, qs) }))
    .sort((a, b) => b.s - a.s || (importers.get(b.f.path)?.length ?? 0) - (importers.get(a.f.path)?.length ?? 0) || a.f.path.localeCompare(b.f.path));
  const relevant = ranked.filter(r => r.s > 0).map(r => r.f);

  const out: string[] = [];
  let left = BUDGET;
  const add = (s: string): boolean => {
    if (s.length > left) return false;
    out.push(s);
    left -= s.length;
    return true;
  };

  const head = [`Project: ${input.name} (${files.length} files)`];
  if (domain.stack.length) head.push(`Stack: ${domain.stack.map(t => t.name).join(', ')}`);
  add(head.join('\n'));

  const connections = (path: string): string => {
    const f = byPath.get(path);
    const lines = [`Connections of ${path}:`];
    lines.push(`  imports: ${f?.imports.local.join(', ') || '-'}`);
    if (f?.imports.external.length) lines.push(`  packages: ${f.imports.external.slice(0, 30).join(', ')}`);
    lines.push(`  imported by: ${importers.get(path)?.slice(0, 40).join(', ') || '-'}`);
    for (const u of usedBy.filter(u => u.file === path).slice(0, 20)) lines.push(`  ${u.symbol} used in: ${u.usedIn.slice(0, 10).join(', ')}`);
    return lines.join('\n');
  };

  // The focused file first: its symbols, connections and source.
  const focused = focus ? byPath.get(focus) : undefined;
  if (focused) {
    add(`\n## Focus: ${focused.path} (${focused.lang}, ${focused.lines} lines)`);
    add(connections(focused.path));
    const text = sendable(focused) ? input.content(focused.path) : null;
    if (text !== null) add(`\nSource of ${focused.path}:\n${clip(text, FOCUS_CHARS)}`);
  }

  if (domain.routes.length) {
    const lines = domain.routes.slice(0, 80).map(r => `  ${r.method} ${r.fullPath} -> ${r.file}:${r.line}${r.handler ? ` ${r.handler}` : ''}`);
    add(`\n## Routes (${domain.routes.length})\n${lines.join('\n')}`);
  }
  if (domain.tables.length) {
    const lines = domain.tables.slice(0, 50).map(t => `  ${t.table} (${t.orm}, ${t.sources[0]?.file ?? '?'}): ${t.fields.slice(0, 20).map(f => f.name).join(', ')}${t.relations.length ? `; relations: ${t.relations.map(r => `${r.field}->${r.to}`).join(', ')}` : ''}`);
    add(`\n## Tables (${domain.tables.length})\n${lines.join('\n')}`);
  }

  const recent = changes.slice(-10).reverse();
  if (recent.length) {
    const lines = recent.map(c => `  ${new Date(c.at).toISOString().slice(0, 16)} ${c.kind} ${c.path}${c.summary ? `: ${c.summary}` : c.attribution?.intent ? `: ${c.attribution.intent}` : ''}`);
    add(`\n## Recent changes\n${lines.join('\n')}`);
  }

  // The most relevant files' source and connections, while the budget lasts (half of it stays for the index).
  for (const f of relevant.slice(0, MAX_FILES)) {
    if (left < BUDGET / 2) break;
    add(`\n## Relevant: ${f.path}`);
    add(connections(f.path));
    const room = Math.min(FILE_CHARS, left - BUDGET / 2 - 100);
    const text = room > 500 && sendable(f) ? input.content(f.path) : null;
    if (text !== null) add(`Source of ${f.path}:\n${clip(text, room)}`);
  }

  // The file index: relevant files first, then the most imported. Each line: path, then top-level symbols.
  const order = [...(focused ? [focused] : []), ...ranked.map(r => r.f)].slice(0, MAX_INDEX_FILES);
  if (add(`\n## Files (path: top-level symbols; ${files.length > order.length ? `${order.length} of ${files.length}` : 'all'})`)) {
    for (const f of order) {
      const syms = f.symbols.slice(0, 12).map(s => s.name).join(', ');
      if (!add(`${f.path}${syms ? `: ${syms}` : ''}`)) break;
    }
  }
  return out.join('\n');
}
