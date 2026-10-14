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

/** Formats an env file is written in (`prod.env.json`, `.env.sh`); other known formats are not env files. */
const ENV_FORMATS = new Set<Lang>(['json', 'yaml', 'toml', 'shell', 'text']);
/** Data formats an env file or its example may be written in; stripped before example checks. */
const DATA_EXT = /\.(json|ya?ml|toml|txt)$/;
/** Ends in an example/sample/template segment (`.env.example`, `.env-sample`, `x.env.template.json`). */
const endsAsExample = (s: string): boolean => /(^|[._-])(example|sample|template)$/.test(s.replace(DATA_EXT, ''));
/**
 * A known non-env format that merely has `.env` in its name: source code (`config.env.ts`,
 * `settings.env.py`), docs, markup or SQL (`deploy.env.md`). It is shown like any other such file
 * (LiveMap serves `settings.py` whatever it holds); env-style formats (`.env.json`, `.env.sh`) and
 * unknown suffixes (`.env.local`, `.env.bak`) are not.
 */
function isCode(suffix: string): boolean {
  const ext = suffix.slice(suffix.lastIndexOf('.') + 1);
  return Object.hasOwn(EXT, ext) && !ENV_FORMATS.has(EXT[ext]);
}

/**
 * Secret files: `.env`, `.env.*`, `.envrc(.*)`, `*.env`, `*.env.*` and credential rc files
 * (`.npmrc`, `.netrc`, `.pypirc`, and their `.bak`-style copies). Examples are not secret when
 * the example marker is the last segment (`.env.example`, `.env.example.json`) or the stem's last
 * dot-segment with nothing but a data extension after `.env` (`example.env`,
 * `app.template.env.json`). `*.env.*` source code (`config.env.ts`, `settings.env.py`) and
 * `.env.d.ts` declarations are not secret; a `.env.*` JS file (`.env.local.js`) is.
 */
export function isSecretEnvPath(path: string): boolean {
  // Editor backups (`.env~`) and autosaves (`#.env#`) hold the same values as the file itself.
  // Agents on Windows send backslash paths: take the name after either separator.
  const b = baseName(path.replace(/\\/g, '/')).toLowerCase().replace(/^#(.*)#$/, '$1').replace(/~+$/, '');
  if (SECRET_NAMES.has(b)) return true;
  const prefixed = /^\.(?:envrc|env|npmrc|netrc|pypirc)([._-].*)$/.exec(b);
  if (prefixed) return !endsAsExample(prefixed[1]) && b !== '.env.d.ts';
  const m = /^(.+)\.env(?:[._-](.+))?$/.exec(b);
  if (!m) return false;
  const [, stem, suffix] = m;
  // `example.env` / `example.env.json` are examples; `example.env.local` is a real override.
  if (/(^|\.)(example|sample|template)$/.test(stem) && (suffix === undefined || /^(json|ya?ml|toml|txt)$/.test(suffix))) return false;
  return suffix === undefined || (!endsAsExample(suffix) && !isCode(suffix));
}

export function isBinaryPath(path: string): boolean {
  return BINARY.has(extOf(path));
}

export function langOf(path: string): Lang {
  if (isSecretEnvPath(path)) return 'secret';
  return EXT[extOf(path)] ?? (baseName(path).startsWith('.env.') ? 'text' : 'other');
}
