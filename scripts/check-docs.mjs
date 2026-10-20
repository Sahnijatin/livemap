#!/usr/bin/env node
/**
 * `npm run docs:check [-- --allow-missing-media]`: checks README.md, CONTRIBUTING.md and docs/*.md.
 *
 * - Every relative link and image resolves to an existing file. Screenshots (docs/images/*.png) and
 *   the gitignored demo (docs/demo/*.html) may be missing only with --allow-missing-media.
 * - Every #anchor matches a heading in the target file.
 * - No em dash (U+2014).
 * - Every flag (--x) the docs mention appears in the CLI sources (src/cli.ts, src/cli-args.ts, plugins/servicenow/cli.ts,
 *   src/proxy/cli.ts),
 *   apart from the few non-LiveMap flags below.
 * - A table row whose first cell starts with --port or --pull states the default the code uses.
 *
 * Flags are checked against the whole of src/cli.ts, not per command: `livemap export --port`
 * would pass. Links starting with `/` are read as repo-root paths, as GitHub does.
 *
 * Exits 1 with a list of problems. `--self-test` runs the checks on built-in samples instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowMissingMedia = process.argv.includes('--allow-missing-media');
const selfTest = process.argv.includes('--self-test');

/** Flags that belong to other tools or scripts, not to the livemap CLI. */
const OTHER_FLAGS = new Set([
  '--allow-missing-media', // this script
  '--shots', // scripts/demo.mjs
  '--ff-only', // git pull, run by --pull
  '--incognito', // a browser's own flag, in the BROWSER example
  '--prefix', // npm --prefix ui
  '--self-test', // this script
]);

const docFiles = ['README.md', 'CONTRIBUTING.md', ...fs.readdirSync(path.join(root, 'docs'))
  .filter(n => n.endsWith('.md'))
  .map(n => `docs/${n}`)]
  .filter(f => fs.existsSync(path.join(root, f)));

const cliSource = ['src/cli.ts', 'src/cli-args.ts', 'plugins/servicenow/cli.ts', 'src/proxy/cli.ts'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const serverSource = fs.readFileSync(path.join(root, 'src/server/server.ts'), 'utf8');
const constant = (src, name) => {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1];
};
const DEFAULT_PORT = constant(serverSource, 'DEFAULT_PORT');
const DEFAULT_PULL_SEC = constant(cliSource, 'DEFAULT_PULL_SEC');

const escapeRe = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A flag the CLI parses: quoted in src/cli.ts and followed by a closing quote or `=`, so `--pul` does not match `'--pull'`. */
const flagKnown = flag => new RegExp(`'${escapeRe(flag)}(?:'|=)`).test(cliSource);

let problems = [];
const report = (file, line, msg) => problems.push(`${file}:${line}: ${msg}`);

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of stripFences(text).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const plain = m[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .toLowerCase();
    const base = plain.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Blanks fenced code blocks, keeping line numbers. */
function stripFences(text) {
  let inFence = false;
  return text.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  }).join('\n');
}

/** Blanks inline code spans so `[x](y)` inside backticks is not read as a link. */
const stripInlineCode = line => line.replace(/`[^`]*`/g, m => ' '.repeat(m.length));

const anchorCache = new Map();
function anchorsFor(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(fs.readFileSync(file, 'utf8')));
  return anchorCache.get(file);
}

const isMedia = rel => /^docs\/images\/[^/]+\.png$/.test(rel) || /^docs\/demo\/[^/]+\.html$/.test(rel);

function checkLink(file, lineNo, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return; // http:, https:, mailto:
  const [rawPath, anchor] = target.split('#');
  const filePath = decodeURIComponent(rawPath.split('?')[0]);
  const base = filePath.startsWith('/') ? root : path.dirname(path.join(root, file));
  const abs = filePath ? path.join(base, filePath) : path.join(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return report(file, lineNo, `link leaves the repo: ${target}`);
  if (!fs.existsSync(abs)) {
    if (allowMissingMedia && isMedia(rel)) return;
    return report(file, lineNo, `missing file: ${target}${isMedia(rel) ? ' (pass --allow-missing-media until the media exist)' : ''}`);
  }
  if (anchor !== undefined) {
    if (!abs.endsWith('.md')) return report(file, lineNo, `anchor on a non-Markdown file: ${target}`);
    if (!anchorsFor(abs).has(anchor)) report(file, lineNo, `no heading for anchor #${anchor} in ${rel}`);
  }
}

function checkText(file, text) {
  const lines = text.split('\n');
  const prose = stripFences(text).split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.includes('\u2014')) report(file, n, 'em dash (U+2014)');

    for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) {
      const flag = m[1];
      if (OTHER_FLAGS.has(flag)) continue;
      if (!flagKnown(flag)) report(file, n, `flag ${flag} does not appear in src/cli.ts`);
    }

    if (/^\s*\|/.test(line)) {
      const first = line.split('|')[1] ?? '';
      if (/^\s*`--port\b/.test(first) && !line.includes(DEFAULT_PORT)) report(file, n, `--port row does not state the default ${DEFAULT_PORT}`);
      if (/^\s*`--pull\b/.test(first) && !new RegExp(`\\b${DEFAULT_PULL_SEC}\\b`).test(line)) report(file, n, `--pull row does not state the default ${DEFAULT_PULL_SEC}`);
    }
  });

  prose.forEach((line, i) => {
    const n = i + 1;
    const l = stripInlineCode(line);
    // A linked image, [![alt](img)](target): the inner image is caught below, the outer target here.
    for (const m of l.matchAll(/\[!\[[^\]]*\]\([^)]*\)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) checkLink(file, n, m[1]);
    for (const m of l.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) checkLink(file, n, m[1]);
    for (const m of l.matchAll(/<(?:img|a|source)\b[^>]*?\s(?:src|href|srcset)="([^"]+)"/gi)) checkLink(file, n, m[1].split(/\s/)[0]);
    for (const m of l.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/g)) checkLink(file, n, m[1]);
  });
}

/** Checks the checker: misspelled flags and broken outer link targets fail; real flags and repo-root links pass. */
function runSelfTest() {
  const usageFlags = [...new Set((/const USAGE = '([^']+)'/.exec(cliSource)?.[1] ?? '').match(/--[a-z][a-z-]*/g) ?? [])];
  const failures = [];
  const expect = (ok, what) => { if (!ok) failures.push(what); };
  expect(usageFlags.length >= 10, `read the USAGE flags from src/cli.ts (got ${usageFlags.length})`);
  for (const f of [...usageFlags, '--help']) expect(flagKnown(f), `real flag ${f} passes`);
  for (const f of ['--agent', '--pul', '--sum', '--no-ope', '--sessions', '--portx']) expect(!flagKnown(f), `misspelled flag ${f} fails`);

  const sample = (text) => { problems = []; checkText('docs/self-test.md', text); const out = problems; problems = []; return out; };
  expect(sample(`Run \`livemap ${usageFlags.join(' ')}\`.`).length === 0, 'a line with every real flag has no problems');
  expect(sample('Use --pul to pull.').some(p => p.includes('--pul does not appear')), 'prose with --pul is reported');
  expect(sample('[![Shot](../LICENSE)](nowhere-at-all.md)').some(p => p.includes('missing file: nowhere-at-all.md')), 'the outer target of a linked image is checked');
  expect(sample('[![Shot](nowhere.png)](../LICENSE)').some(p => p.includes('missing file: nowhere.png')), 'the inner image of a linked image is checked');
  expect(sample('[guide](/docs/guide.md#command-line) and [license](/LICENSE)').length === 0, 'repo-root links resolve from the repo root');
  expect(sample('[gone](/docs/gone.md)').some(p => p.includes('missing file: /docs/gone.md')), 'a missing repo-root link is reported');
  expect(sample('x \u2014 y').some(p => p.includes('em dash')), 'an em dash is reported');
  expect(sample('| `--port N` | 1 |').some(p => p.includes('--port row')), 'a --port row without the default is reported');

  if (failures.length) {
    process.stderr.write(`docs:check self-test failed:\n${failures.map(f => `  ${f}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`docs:check self-test passed (${usageFlags.length} USAGE flags)\n`);
  process.exit(0);
}

if (selfTest) runSelfTest();
for (const file of docFiles) checkText(file, fs.readFileSync(path.join(root, file), 'utf8'));

if (problems.length) {
  process.stderr.write(`docs:check found ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(p => `  ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`docs:check passed (${docFiles.length} files${allowMissingMedia ? ', media may be missing' : ''})\n`);
