import type { HighlighterCore, LanguageInput, ThemedToken } from 'shiki/core';
import { EXPORT_GRAMMARS_ID, type ExportGrammars } from '@shared/export.js';
import { grammarId } from '@shared/grammars.js';
import type { Lang } from '@shared/types.js';

/**
 * Shiki, loaded on first use. One css-variables theme drives both light and dark: token colors
 * are CSS custom properties (see styles.css) mapped onto the prototype palette, so the code
 * follows the theme toggle without re-highlighting.
 */
type Loader = () => Promise<{ default: LanguageInput }>;
// The live app loads each grammar on first use. The export build carries none: an export with code
// embeds the grammars its files need and the engine's wasm (see `embedded`).
const LANGS: Record<string, Loader> = import.meta.env.MODE === 'export' ? {} : {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
};

/** Highlighting is skipped above this size; the plain view stays fast. */
export const MAX_HIGHLIGHT_LINES = 5000;
const THEME = 'livemap';

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<boolean>>();

let grammars: ExportGrammars | null | undefined;
/** An export's embedded grammars, or null when it has none (`--no-code`). */
function embedded(): ExportGrammars | null {
  if (grammars === undefined) {
    try {
      const el = document.getElementById(EXPORT_GRAMMARS_ID);
      grammars = el ? (JSON.parse(el.textContent ?? '') as ExportGrammars) : null;
    } catch {
      grammars = null;
    }
  }
  return grammars;
}

const bytes = (base64: string): Uint8Array => Uint8Array.from(atob(base64), c => c.charCodeAt(0));

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createOnigurumaEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/oniguruma'),
    ]);
    const page = import.meta.env.MODE === 'export' ? embedded()! : null;
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-', fontStyle: true })],
      langs: (page?.langs ?? []) as LanguageInput[],
      engine: createOnigurumaEngine(import.meta.env.MODE === 'export' ? bytes(page!.wasm) : import('shiki/wasm')),
    });
  })();
  return highlighter;
}

/** Loads a grammar the live app has a loader for. An export's grammars all load with the highlighter. */
function ready(hl: HighlighterCore, id: string): Promise<boolean> {
  let p = loaded.get(id);
  if (!p) {
    p = LANGS[id]().then(async mod => { await hl.loadLanguage(mod.default); return true; }).catch(() => false);
    loaded.set(id, p);
  }
  return p;
}

/** Tokens per line, or null when the language is not supported or highlighting failed. */
export async function highlight(code: string, lang: Lang, path: string): Promise<ThemedToken[][] | null> {
  const id = grammarId(lang, path);
  if (import.meta.env.MODE === 'export' ? !embedded()?.langs.some(g => g.name === id) : !LANGS[id]) return null;
  try {
    const hl = await getHighlighter();
    if (import.meta.env.MODE !== 'export' && !(await ready(hl, id))) return null;
    return hl.codeToTokensBase(code, { lang: id, theme: THEME });
  } catch {
    return null;
  }
}
