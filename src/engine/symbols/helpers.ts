import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';
import type { CodeSymbol, SymbolKind } from '../../shared/types.js';

export const MAX_SYMBOLS = 1500;
const MAX_SIGNATURE = 220;

/** Per-file extraction budget shared by every language extractor. */
export interface Budget { count: number }

export function newBudget(): Budget {
  return { count: 0 };
}

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export function hashOf(node: Node): string {
  return hashText(node.text);
}

export function tidySignature(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*[{:=]$/, '').trim();
  if (s.length > MAX_SIGNATURE) s = s.slice(0, MAX_SIGNATURE - 1) + '…';
  return s;
}

/** Source from the node start to the start of its `body` field, or the first line if there is no body. */
export function signatureOf(node: Node, body?: Node | null): string {
  const b = body ?? node.childForFieldName('body');
  const text = node.text;
  if (b && b.startIndex > node.startIndex) {
    return tidySignature(text.slice(0, b.startIndex - node.startIndex));
  }
  const nl = text.indexOf('\n');
  return tidySignature(nl === -1 ? text : text.slice(0, nl));
}

export function qnameOf(parent: CodeSymbol | undefined, name: string): string {
  return parent ? `${parent.qname}.${name}` : name;
}

/**
 * Builds a symbol for `node` (line numbers, hash from this node), or null once the per-file limit is hit.
 */
export function makeSymbol(
  budget: Budget,
  node: Node,
  parent: CodeSymbol | undefined,
  info: { name: string; kind: SymbolKind; signature: string; exported: boolean },
): CodeSymbol | null {
  if (budget.count >= MAX_SYMBOLS) return null;
  budget.count++;
  return {
    name: info.name,
    qname: qnameOf(parent, info.name),
    kind: info.kind,
    signature: info.signature,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    exported: info.exported,
    hash: hashOf(node),
    children: [],
  };
}

/** Named children without nulls (web-tree-sitter types allow null entries). */
export function namedKids(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

export function allKids(node: Node): Node[] {
  return node.children.filter((c): c is Node => c !== null);
}
