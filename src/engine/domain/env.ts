import type { Lang } from '../../shared/types.js';
import { envKeys } from '../files.js';
import { isSecretEnvPath } from '../languages.js';
import type { Analyzer } from './index.js';
import { maskCommentsAndStrings } from './util.js';
import { baseName } from '../paths.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const N = '([A-Za-z_][A-Za-z0-9_]*)';
/** Quoted literal key: the quote is captured in group 1 and must close the name (group 2). */
const Q = `(['"\`])${N}\\1`;

const JS = [
  new RegExp(`\\bprocess\\.env\\.${N}`, 'g'),
  new RegExp(`\\bprocess\\.env\\[\\s*${Q}\\s*\\]`, 'g'),
  new RegExp(`\\bimport\\.meta\\.env\\.${N}`, 'g'),
  new RegExp(`\\bDeno\\.env\\.get\\(\\s*${Q}`, 'g'),
];
/** `const { A, B: b, C = 1, ...rest } = process.env` (or `import.meta.env`); group 1 is the pattern body. */
const JS_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*(?::[^=;]+)?=\s*(?:process\.env|import\.meta\.env)(?![\w$.[?])/g;

/** Keys of a destructuring pattern body; renames and defaults are skipped, the rest element ignored. */
function destructuredKeys(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if ((c === ',' && depth === 0) || i === body.length) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:=]|$)/.exec(body.slice(start, i));
      if (m) out.push(m[1]);
      start = i + 1;
    }
  }
  return out;
}

const PATTERNS: Partial<Record<Lang, RegExp[]>> = {
  typescript: JS, tsx: JS, javascript: JS, vue: JS, svelte: JS,
  python: [
    new RegExp(`\\bos\\.environ\\[\\s*${Q}\\s*\\]`, 'g'),
    new RegExp(`\\bos\\.environ\\.get\\(\\s*${Q}`, 'g'),
    new RegExp(`\\bos\\.getenv\\(\\s*${Q}`, 'g'),
  ],
  go: [new RegExp(`\\bos\\.(?:Getenv|LookupEnv)\\(\\s*"${N}"`, 'g')],
  rust: [new RegExp(`\\benv::var(?:_os)?\\(\\s*"${N}"`, 'g')],
  ruby: [
    new RegExp(`\\bENV\\[\\s*${Q}\\s*\\]`, 'g'),
    new RegExp(`\\bENV\\.fetch\\(\\s*${Q}`, 'g'),
  ],
  php: [
    new RegExp(`\\bgetenv\\(\\s*${Q}`, 'g'),
    new RegExp(`\\$_ENV\\[\\s*${Q}\\s*\\]`, 'g'),
    new RegExp(`\\benv\\(\\s*${Q}`, 'g'),
  ],
  kotlin: [new RegExp(`\\bSystem\\.getenv\\(\\s*"${N}"`, 'g')],
  java: [new RegExp(`\\bSystem\\.getenv\\(\\s*"${N}"`, 'g')],
};

/** `.env.example`, `.env.sample`, `.env.template`, and the `.env.<x>.example` style variants. */
export const isEnvTemplate = (rel: string): boolean => !isSecretEnvPath(rel) && /^\.env([._-][\w.-]*)?[._-](example|sample|template)$/i.test(baseName(rel));

/** Environment variable names read by code, or declared by an env template file. */
export const env: Analyzer = {
  name: 'env',
  applies: (rel, lang) => lang in PATTERNS || isEnvTemplate(rel),
  run(rel, lang, text) {
    if (isEnvTemplate(rel)) return { env: envKeys(text).filter(k => NAME.test(k)) };
    const code = maskCommentsAndStrings(text, lang);
    const out: string[] = [];
    for (const re of PATTERNS[lang] ?? []) {
      for (const m of code.matchAll(re)) out.push(m[m.length - 1]);
    }
    if (PATTERNS[lang] === JS) for (const m of code.matchAll(JS_DESTRUCTURE)) out.push(...destructuredKeys(m[1]));
    return { env: out };
  },
};
