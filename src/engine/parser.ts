import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import type { Lang } from '../shared/types.js';
import { GRAMMAR } from './languages.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
let initPromise: Promise<void> | null = null;
const cache = new Map<string, Promise<Parser | null>>();

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

/**
 * The grammar's wasm file: `<dist>/grammars/` next to cli.js in a built package, else tree-sitter-wasms
 * (a source checkout, where tests run from src/).
 */
export function grammarPath(grammar: string, dir: string = HERE): string {
  const built = path.join(dir, 'grammars', `tree-sitter-${grammar}.wasm`);
  return fs.existsSync(built) ? built : require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

async function load(grammar: string): Promise<Parser | null> {
  try {
    await init();
    const language = await Language.load(grammarPath(grammar));
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
