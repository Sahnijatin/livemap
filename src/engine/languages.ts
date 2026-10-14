import type { Lang } from '../shared/types.js';

const EXT: Record<string, Lang> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  dart: 'dart', vue: 'vue', svelte: 'svelte', sql: 'sql', prisma: 'prisma',
  md: 'markdown', mdx: 'markdown',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  txt: 'text',
};

const BINARY = new Set(
  'png jpg jpeg gif webp ico pdf zip gz tgz woff woff2 ttf otf eot mp3 mp4 mov webm wav db sqlite sqlite3 wasm so dylib dll exe bin jar class pyc lockb'.split(' '),
);

/** Lang to tree-sitter-wasms grammar file stem. */
export const GRAMMAR: Partial<Record<Lang, string>> = {
  typescript: 'typescript', tsx: 'tsx', javascript: 'javascript', python: 'python',
  go: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', csharp: 'c_sharp',
  php: 'php', ruby: 'ruby', swift: 'swift', c: 'c', cpp: 'cpp', dart: 'dart',
};

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function extOf(path: string): string {
  const b = baseName(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** Files whose values are never stored or sent; only variable names are read from them. */
const SECRET_NAMES = new Set(['.env', '.envrc', '.npmrc', '.netrc', '.pypirc']);

/**
 * `.env`, `.env.*`, `.envrc` (direnv), `*.env` and credential rc files, except `.env.*` / `.envrc.*`
 * variants ending in `.example`, `.sample` or `.template`.
 */
export function isSecretEnvPath(path: string): boolean {
  // Editor backups (`.env~`) and autosaves (`#.env#`) hold the same values as the file itself.
  const b = baseName(path).toLowerCase().replace(/^#(.*)#$/, '$1').replace(/~+$/, '');
  if (SECRET_NAMES.has(b) || /^.+\.env$/.test(b)) return true;
  if (!/^\.env(rc)?[._-]/.test(b)) return false;
  return !/[._-](example|sample|template)$/.test(b);
}

export function isBinaryPath(path: string): boolean {
  return BINARY.has(extOf(path));
}

export function langOf(path: string): Lang {
  if (isSecretEnvPath(path)) return 'secret';
  return EXT[extOf(path)] ?? (baseName(path).startsWith('.env.') ? 'text' : 'other');
}
