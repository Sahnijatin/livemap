import type { CodeSymbol, Lang } from '../../shared/types.js';
import { getParser } from '../parser.js';
import { extractJs } from './js.js';
import { extractGeneric } from './generic.js';
import { newBudget, hashText } from './helpers.js';
import { markdownOutline, scriptBlocks, shiftLines } from './markup.js';
import { posix } from 'node:path';
import type { Node } from 'web-tree-sitter';

type Extractor = (root: Node, lang: Lang) => CodeSymbol[];

/** Language to extractor dispatch. Later tasks register more grammars here. */
const EXTRACTORS: Partial<Record<Lang, Extractor>> = {
  typescript: (root, lang) => extractJs(root, lang, newBudget()),
  tsx: (root, lang) => extractJs(root, lang, newBudget()),
  javascript: (root, lang) => extractJs(root, lang, newBudget()),
};
for (const lang of ['python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift', 'c', 'cpp', 'dart'] as const) {
  EXTRACTORS[lang] = (root, l) => extractGeneric(root, l, newBudget());
}

/**
 * Grammar-based symbol extraction. ok is false when there is no grammar or the parse
 * tree contains errors; symbols recovered despite errors are still returned.
 */
export async function extractSymbols(lang: Lang, source: string): Promise<{ symbols: CodeSymbol[]; ok: boolean }> {
  const parser = await getParser(lang);
  if (!parser) return { symbols: [], ok: false };
  const tree = parser.parse(source);
  if (!tree) return { symbols: [], ok: false };
  try {
    const root = tree.rootNode;
    const extract = EXTRACTORS[lang];
    const symbols = extract ? extract(root, lang) : [];
    return { symbols, ok: !root.hasError };
  } finally {
    tree.delete();
  }
}

export function flattenSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const walk = (list: CodeSymbol[]) => {
    for (const s of list) {
      out.push(s);
      walk(s.children);
    }
  };
  walk(symbols);
  return out;
}

/**
 * Symbols for any indexed file: markdown outline, Vue/Svelte component wrapping the script block
 * (named after `path`), or grammar extraction for everything else.
 */
export async function fileSymbols(lang: Lang, src: string, path?: string): Promise<{ symbols: CodeSymbol[]; ok: boolean }> {
  if (lang === 'markdown') return { symbols: markdownOutline(src), ok: true };
  if (lang === 'vue' || lang === 'svelte') {
    const base = posix.basename(path ?? `Component.${lang}`);
    const dot = base.lastIndexOf('.');
    const name = dot > 0 ? base.slice(0, dot) : base;
    const children: CodeSymbol[] = [];
    let ok = true;
    for (const block of scriptBlocks(src)) {
      const r = await extractSymbols('typescript', block.code);
      children.push(...shiftLines(r.symbols, block.lineOffset));
      ok &&= r.ok;
    }
    const lines = src.split('\n').length;
    const comp: CodeSymbol = {
      name, qname: name, kind: 'component', signature: base,
      line: 1, endLine: lines, exported: true, hash: hashText(src), children,
    };
    return { symbols: [comp], ok };
  }
  return extractSymbols(lang, src);
}
