import type { HighlighterCore, ThemedToken } from 'shiki/core';
import type { Lang } from '@shared/types.js';

/**
 * Shiki, loaded on first use. One css-variables theme drives both light and dark: token colors
 * are CSS custom properties (see styles.css) mapped onto the prototype palette, so the code
 * follows the theme toggle without re-highlighting.
 */
type Loader = () => Promise<unknown>;
const LANGS: Partial<Record<Lang, [string, Loader]>> = {
  typescript: ['typescript', () => import('shiki/langs/typescript.mjs')],
  tsx: ['tsx', () => import('shiki/langs/tsx.mjs')],
  javascript: ['javascript', () => import('shiki/langs/javascript.mjs')],
  python: ['python', () => import('shiki/langs/python.mjs')],
  go: ['go', () => import('shiki/langs/go.mjs')],
  rust: ['rust', () => import('shiki/langs/rust.mjs')],
  java: ['java', () => import('shiki/langs/java.mjs')],
  kotlin: ['kotlin', () => import('shiki/langs/kotlin.mjs')],
  csharp: ['csharp', () => import('shiki/langs/csharp.mjs')],
  php: ['php', () => import('shiki/langs/php.mjs')],
  ruby: ['ruby', () => import('shiki/langs/ruby.mjs')],
  swift: ['swift', () => import('shiki/langs/swift.mjs')],
  c: ['c', () => import('shiki/langs/c.mjs')],
  cpp: ['cpp', () => import('shiki/langs/cpp.mjs')],
  dart: ['dart', () => import('shiki/langs/dart.mjs')],
  vue: ['vue', () => import('shiki/langs/vue.mjs')],
  svelte: ['svelte', () => import('shiki/langs/svelte.mjs')],
  sql: ['sql', () => import('shiki/langs/sql.mjs')],
  prisma: ['prisma', () => import('shiki/langs/prisma.mjs')],
  markdown: ['markdown', () => import('shiki/langs/markdown.mjs')],
  json: ['json', () => import('shiki/langs/json.mjs')],
  yaml: ['yaml', () => import('shiki/langs/yaml.mjs')],
  toml: ['toml', () => import('shiki/langs/toml.mjs')],
  css: ['css', () => import('shiki/langs/css.mjs')],
  html: ['html', () => import('shiki/langs/html.mjs')],
  shell: ['shellscript', () => import('shiki/langs/shellscript.mjs')],
};
/** JSX files are classified as javascript by the engine; the jsx grammar handles both. */
const JSX: [string, Loader] = ['jsx', () => import('shiki/langs/jsx.mjs')];

/** Highlighting is skipped above this size; the plain view stays fast. */
export const MAX_HIGHLIGHT_LINES = 5000;
const THEME = 'livemap';

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createOnigurumaEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
    ]);
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-', fontStyle: true })],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  })();
  return highlighter;
}

function grammarFor(lang: Lang, path: string): [string, Loader] | undefined {
  if (/\.jsx$/i.test(path)) return JSX;
  return LANGS[lang];
}

/** Tokens per line, or null when the language is not supported or highlighting failed. */
export async function highlight(code: string, lang: Lang, path: string): Promise<ThemedToken[][] | null> {
  const grammar = grammarFor(lang, path);
  if (!grammar) return null;
  const [id, load] = grammar;
  try {
    const hl = await getHighlighter();
    let ready = loaded.get(id);
    if (!ready) {
      ready = load()
        .then(async mod => { await hl.loadLanguage((mod as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default); return true; })
        .catch(() => false);
      loaded.set(id, ready);
    }
    if (!(await ready)) return null;
    return hl.codeToTokensBase(code, { lang: id, theme: THEME });
  } catch {
    return null;
  }
}
