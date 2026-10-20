// Third-party notices (after build): writes THIRD_PARTY_NOTICES.md to dist/, dist/ui/ and dist/ui-export/ from the
// two lockfiles, the license files in node_modules and the grammar licenses in scripts/grammar-licenses/, and puts a
// short license comment in the export page. `--check` only checks every shipped package's license against ALLOWED
// and needs no node_modules (npm run licenses:check).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Licenses a shipped package may carry (SPDX ids). An `OR` expression passes when one side does. */
export const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'OFL-1.1', 'EPL-2.0']);

/** Licenses that ask recipients to be told where the source is: each package under one needs an entry in SOURCES. */
const NEEDS_SOURCE = new Set(['EPL-2.0']);
export const SOURCES = { elkjs: 'https://github.com/kieler/elkjs' };

/** Upstream of each grammar dist/grammars ships (GRAMMAR in src/engine/languages.ts), built into tree-sitter-wasms. */
export const GRAMMAR_SOURCES = {
  typescript: ['MIT', 'https://github.com/tree-sitter/tree-sitter-typescript', 'tree-sitter-typescript'],
  tsx: ['MIT', 'https://github.com/tree-sitter/tree-sitter-typescript', 'tree-sitter-typescript'],
  javascript: ['MIT', 'https://github.com/tree-sitter/tree-sitter-javascript', 'tree-sitter-javascript'],
  python: ['MIT', 'https://github.com/tree-sitter/tree-sitter-python', 'tree-sitter-python'],
  go: ['MIT', 'https://github.com/tree-sitter/tree-sitter-go', 'tree-sitter-go'],
  rust: ['MIT', 'https://github.com/tree-sitter/tree-sitter-rust', 'tree-sitter-rust'],
  java: ['MIT', 'https://github.com/tree-sitter/tree-sitter-java', 'tree-sitter-java'],
  kotlin: ['MIT', 'https://github.com/fwcd/tree-sitter-kotlin', 'tree-sitter-kotlin'],
  c_sharp: ['MIT', 'https://github.com/tree-sitter/tree-sitter-c-sharp', 'tree-sitter-c-sharp'],
  php: ['MIT', 'https://github.com/tree-sitter/tree-sitter-php', 'tree-sitter-php'],
  ruby: ['MIT', 'https://github.com/tree-sitter/tree-sitter-ruby', 'tree-sitter-ruby'],
  swift: ['MIT', 'https://github.com/alex-pinkus/tree-sitter-swift', 'tree-sitter-swift'],
  c: ['MIT', 'https://github.com/tree-sitter/tree-sitter-c', 'tree-sitter-c'],
  cpp: ['MIT', 'https://github.com/tree-sitter/tree-sitter-cpp', 'tree-sitter-cpp'],
  dart: ['MIT', 'https://github.com/UserNobody14/tree-sitter-dart', 'tree-sitter-dart'],
};

/** Each grammar package's license text, copied from the package tree-sitter-wasms builds it from. */
const GRAMMAR_LICENSES = 'scripts/grammar-licenses';

/**
 * Dev-only packages whose code still ends up in the UI build: Vite's modulepreload polyfill in the entry chunk,
 * and Tailwind's preflight stylesheet.
 */
export const BUNDLED_DEV = ['vite', 'tailwindcss'];

/** Packages that must be on the lists, so an empty or unreadable lockfile can never pass. */
export const REQUIRED = { ui: ['react', 'elkjs'], engine: ['ws'] };

/** Whether an SPDX expression is allowed: `A OR B` needs one side, `A AND B` both; parentheses are ignored. */
export function allowed(expr) {
  if (!expr) return false;
  const e = expr.replace(/[()]/g, ' ').trim();
  return e.split(/\s+OR\s+/).some(side => side.split(/\s+AND\s+/).every(id => ALLOWED.has(id.trim())));
}

/** The ids in an SPDX expression. */
const ids = (expr) => expr.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/).map(s => s.trim()).filter(Boolean);

/** Packages a lockfile installs for production: not dev-only, not the root itself. */
export function shipped(lock, dir) {
  const out = [];
  for (const [key, p] of Object.entries(lock.packages ?? {})) {
    if (!key || p.dev || p.devOptional || p.link) continue;
    const name = p.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: p.version, license: p.license ?? null, dir: path.join(dir, key) });
  }
  return out;
}

/** The grammars dist/grammars ships, read from GRAMMAR in src/engine/languages.ts (as scripts/copy-grammars.mjs does). */
export function grammars(src) {
  const body = /export const GRAMMAR\b[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
  return [...new Set([...(body ?? '').matchAll(/:\s*'([\w-]+)'/g)].map(m => m[1]))];
}

/** A lockfile package entry by name, from the top level of node_modules. */
function entry(lock, dir, name) {
  const p = lock.packages?.[`node_modules/${name}`];
  return p && { name, version: p.version, license: p.license ?? null, dir: path.join(dir, `node_modules/${name}`) };
}

/**
 * Every shipped package and grammar, grouped, with problems: a disallowed or unknown license, a missing source link
 * or license text, an empty list, or a required package missing.
 */
export function collect(root = repo) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const rootLock = read('package-lock.json');
  const uiLock = read('ui/package-lock.json');
  const uiDir = path.join(root, 'ui');
  const ui = shipped(uiLock, uiDir);
  for (const name of BUNDLED_DEV) {
    const p = entry(uiLock, uiDir, name);
    if (p && !ui.some(u => u.name === name)) ui.push(p);
  }
  const engine = shipped(rootLock, root);
  // Dev-only in the lockfile, but dist/grammars ships some of its files: listed with the grammars.
  const wasms = entry(rootLock, root, 'tree-sitter-wasms');
  const grammar = grammars(fs.readFileSync(path.join(root, 'src/engine/languages.ts'), 'utf8')).map(g => {
    const [license, source, pkg] = GRAMMAR_SOURCES[g] ?? [null, null, null];
    return { name: `tree-sitter-${g}`, license, source, pkg };
  });

  const problems = [];
  for (const p of [...ui, ...engine, ...(wasms ? [wasms] : [])]) {
    p.license ??= licenseFromPackage(p.dir);
    if (!allowed(p.license)) problems.push(`${p.name}@${p.version}: license ${p.license ?? 'unknown'} is not on the allowlist`);
    else if (ids(p.license).some(id => NEEDS_SOURCE.has(id)) && !SOURCES[p.name]) problems.push(`${p.name}@${p.version}: ${p.license} needs a source link in SOURCES`);
    p.source = SOURCES[p.name] ?? null;
  }
  for (const g of grammar) {
    if (!g.license) problems.push(`${g.name}: add its license and source to GRAMMAR_SOURCES in scripts/notices.mjs`);
    else if (!allowed(g.license)) problems.push(`${g.name}: license ${g.license} is not on the allowlist`);
    else if (!fs.existsSync(path.join(root, GRAMMAR_LICENSES, `${g.pkg}.txt`))) problems.push(`${g.name}: add its license text as ${GRAMMAR_LICENSES}/${g.pkg}.txt`);
  }
  if (!ui.length) problems.push('ui/package-lock.json lists no shipped packages (missing, empty or not lockfile version 2 or 3)');
  if (!engine.length) problems.push('package-lock.json lists no shipped packages (missing, empty or not lockfile version 2 or 3)');
  if (!grammar.length) problems.push('no grammars found in GRAMMAR in src/engine/languages.ts');
  if (grammar.length && !wasms) problems.push('tree-sitter-wasms is not in package-lock.json, but dist/grammars ships its files');
  for (const [list, names] of Object.entries(REQUIRED)) {
    const have = list === 'ui' ? ui : engine;
    for (const name of names) if (!have.some(p => p.name === name)) problems.push(`${name} is missing from the ${list === 'ui' ? 'UI' : 'engine'} packages`);
  }
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : 1);
  return { ui: ui.sort(byName), engine: engine.sort(byName), wasms, grammar, problems, root };
}

function licenseFromPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg.license === 'string' ? pkg.license : null;
  } catch {
    return null;
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** The license and notice files a package ships, as [file name, text]. */
function licenseTexts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(n => LICENSE_FILE.test(n)).sort();
  } catch {
    return [];
  }
  return names.map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8').trim()]);
}

/** A fence longer than any backtick run in the text, so a license cannot close it. */
function fence(text) {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  return '`'.repeat(run + 1);
}

const row = (p) => `| ${p.name} | ${p.version ?? ''} | ${p.license} | ${p.source ?? ''} |`;
const HEAD = '| Package | Version | License | Source |\n|---|---|---|---|';

/** The notices file: three tables, then each package's and grammar's license text. */
export function render({ ui, engine, wasms, grammar, root = repo }) {
  const lines = [
    '# Third-party notices',
    '',
    'LiveMap includes or installs the open source software listed below. Each table gives the package, its version and its license. Where a license asks for it, the Source column says where to get the source code. The full license texts follow the tables.',
    '',
    '## In the browser UI (`dist/ui`, `dist/ui-export`)',
    '',
    '`vite` and `tailwindcss` are build tools: the UI includes a small part of each (a module preload helper and a base stylesheet).',
    '',
    HEAD, ...ui.map(row),
    '',
    '## Installed with LiveMap',
    '',
    'npm installs these with LiveMap.',
    '',
    HEAD, ...engine.map(row),
    '',
    '## Parser grammars (`dist/grammars`)',
    '',
    'LiveMap ships these grammars as WebAssembly files from `tree-sitter-wasms`, which compiles them from the projects below.',
    '',
    HEAD, ...(wasms ? [row(wasms)] : []),
    '',
    '| Grammar | License | Source |\n|---|---|---|',
    ...grammar.map(g => `| ${g.name} | ${g.license} | ${g.source} |`),
    '',
    '## License texts',
  ];
  const seen = new Set();
  for (const p of [...ui, ...engine, ...(wasms ? [wasms] : [])]) {
    const id = `${p.name}@${p.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    lines.push('', `### ${id}`, '');
    const texts = licenseTexts(p.dir);
    if (!texts.length) lines.push(`License: ${p.license}. The package includes no license file.`);
    for (const [, text] of texts) {
      const f = fence(text);
      lines.push(f, text, f);
    }
  }
  for (const g of grammar) {
    if (!g.pkg || seen.has(g.pkg)) continue;
    seen.add(g.pkg);
    lines.push('', `### ${g.pkg} (grammar)`, '');
    const text = fs.readFileSync(path.join(root, GRAMMAR_LICENSES, `${g.pkg}.txt`), 'utf8').trim();
    const f = fence(text);
    lines.push(f, text, f);
  }
  return lines.join('\n') + '\n';
}

/** The comment the export page carries, since an exported file travels without the notices file. */
export const EXPORT_NOTICE = '<!-- This page includes open source software, among it React and React Flow (MIT) and elkjs (EPL-2.0, source: https://github.com/kieler/elkjs). THIRD_PARTY_NOTICES.md in the LiveMap package lists every package with its license. -->';

/** The export page with EXPORT_NOTICE after its doctype (once). */
export function withExportNotice(html) {
  if (html.includes(EXPORT_NOTICE)) return html;
  const m = /^\s*<!doctype html>/i.exec(html);
  return m ? `${m[0]}\n${EXPORT_NOTICE}${html.slice(m[0].length)}` : `${EXPORT_NOTICE}\n${html}`;
}

function main() {
  const check = process.argv.includes('--check');
  const result = collect();
  if (result.problems.length) {
    console.error(`licenses: ${result.problems.length} problem(s):\n${result.problems.map(p => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  const count = result.ui.length + result.engine.length + 1 + result.grammar.length;
  if (check) {
    console.log(`licenses: ok (${count} shipped packages and grammars)`);
    return;
  }
  const text = render(result);
  const outs = ['dist/THIRD_PARTY_NOTICES.md', 'dist/ui/THIRD_PARTY_NOTICES.md', 'dist/ui-export/THIRD_PARTY_NOTICES.md'];
  for (const out of outs) {
    fs.mkdirSync(path.dirname(path.join(repo, out)), { recursive: true });
    fs.writeFileSync(path.join(repo, out), text);
  }
  const page = path.join(repo, 'dist/ui-export/index.html');
  if (fs.existsSync(page)) fs.writeFileSync(page, withExportNotice(fs.readFileSync(page, 'utf8')));
  console.log(`notices: ${count} packages and grammars to ${outs.join(', ')}; export page notice added`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
