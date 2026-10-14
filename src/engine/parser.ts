import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import type { Lang } from '../shared/types.js';
import { GRAMMAR } from './languages.js';

const require = createRequire(import.meta.url);
let initPromise: Promise<void> | null = null;
const cache = new Map<string, Promise<Parser | null>>();

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function load(grammar: string): Promise<Parser | null> {
  try {
    await init();
    const wasm = require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
    const language = await Language.load(wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  } catch {
    return null;
  }
}

/** Returns a cached parser for the language's grammar, or null if there is none or it fails to load. */
export function getParser(lang: Lang): Promise<Parser | null> {
  const grammar = GRAMMAR[lang];
  if (!grammar) return Promise.resolve(null);
  let p = cache.get(grammar);
  if (!p) {
    p = load(grammar);
    cache.set(grammar, p);
  }
  return p;
}
