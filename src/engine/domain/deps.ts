import type { Dep } from '../../shared/types.js';
import type { Analyzer, DomainFacts } from './index.js';
import { lineAt } from './util.js';

type Facts = NonNullable<DomainFacts['deps']>;
type Parser = (text: string) => Facts;

const dep = (name: string, version: string, eco: string, line: number, dev = false): Dep =>
  (dev ? { name, version, eco, dev: true, line } : { name, version, eco, line });

/** Line `i` of the result is line `i + 1` of the file. */
const lines = (text: string): string[] => text.split(/\r?\n/);
const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');
/** Drops a `#` comment that starts the line or follows whitespace. */
const noHash = (s: string): string => s.replace(/(^|\s)#.*$/, '');

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Offset of `"key":` at or after `from`; -1 when absent. */
function keyOffset(text: string, key: string, from: number): number {
  const lit = JSON.stringify(key);
  for (let i = text.indexOf(lit, from); i !== -1; i = text.indexOf(lit, i + 1)) {
    let j = i + lit.length;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j++;
    if (text[j] === ':') return i;
  }
  return -1;
}

/** String-valued entries of a JSON section, with the line of each key inside that section. */
function jsonSection(text: string, json: Record<string, unknown>, section: string): [string, string, number][] {
  const obj = json[section];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const start = Math.max(0, keyOffset(text, section, 0));
  const out: [string, string, number][] = [];
  // Keys come back in source order (bar integer-like keys), so each search starts after the last hit.
  let cursor = start;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    let at = keyOffset(text, k, cursor);
    if (at === -1) at = keyOffset(text, k, start); else cursor = at + 1;
    out.push([k, v, at === -1 ? 1 : lineAt(text, at)]);
  }
  return out;
}

const packageJson: Parser = text => {
  const json = parseJson(text);
  if (!json) return { deps: [] };
  const deps = [
    ...jsonSection(text, json, 'dependencies').map(([n, v, l]) => dep(n, v, 'npm', l)),
    ...jsonSection(text, json, 'devDependencies').map(([n, v, l]) => dep(n, v, 'npm', l, true)),
  ];
  const s = json.scripts;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { deps };
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) if (typeof v === 'string') scripts[k] = v;
  return { deps, scripts };
};

const composerJson: Parser = text => {
  const json = parseJson(text);
  if (!json) return { deps: [] };
  const keep = ([n]: [string, string, number]) => n !== 'php' && !n.startsWith('ext-');
  return {
    deps: [
      ...jsonSection(text, json, 'require').filter(keep).map(([n, v, l]) => dep(n, v, 'composer', l)),
      ...jsonSection(text, json, 'require-dev').filter(keep).map(([n, v, l]) => dep(n, v, 'composer', l, true)),
    ],
  };
};

/** A PEP 508 requirement: name, optional extras, version specifiers; markers and URLs dropped. `==x` is stored as `x`. */
function pep508(req: string): { name: string; version: string } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?([^;@]*)/.exec(req);
  if (!m) return null;
  const spec = m[3].replace(/\s+/g, '');
  return { name: m[1], version: /^==[^,]+$/.test(spec) ? spec.slice(2) : spec };
}

const requirements: Parser = text => {
  const deps: Dep[] = [];
  lines(text).forEach((raw, i) => {
    const line = noHash(raw).trim();
    if (!line || line.startsWith('-') || /^[\w+.-]*:\/\//.test(line)) return;
    const r = pep508(line);
    if (r) deps.push(dep(r.name, r.version, 'pypi', i + 1));
  });
  return { deps };
};

/** `[table]` header name, or null for a non-header line. */
const tomlHeader = (line: string): string | null => /^\s*\[\[?([^\]=]*)\]/.exec(line)?.[1].trim() ?? null;
const TOML_KEY = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/;
/** Version from a TOML value: `"1.0"` or `{ version = "1.0", ... }`; '' otherwise. */
function tomlVersion(value: string): string {
  const v = value.trim();
  const m = /^(?:"([^"]*)"|'([^']*)')/.exec(v) ?? /\bversion\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(v);
  return m ? m[1] ?? m[2] : '';
}

/** A basic (`"..."`) or literal (`'...'`) TOML string on one line. */
const TOML_STR = /"([^"]*)"|'([^']*)'/g;
/** True when a `]` appears outside quoted strings, so PEP 508 extras (`x[all]`) do not end the array. */
const closesArray = (line: string): boolean => line.replace(TOML_STR, '').includes(']');

/** Contents of each TOML string on a line; the other quote type is plain content inside a string. */
function tomlStrings(line: string): string[] {
  return [...line.matchAll(TOML_STR)].map(m => m[1] ?? m[2]);
}

const pyproject: Parser = text => {
  const deps: Dep[] = [];
  const ls = lines(text);
  let table = '';
  let inArray = false;
  ls.forEach((raw, i) => {
    const line = noHash(raw);
    if (inArray) {
      for (const str of tomlStrings(line)) {
        const r = pep508(str);
        if (r) deps.push(dep(r.name, r.version, 'pypi', i + 1));
      }
      if (closesArray(line)) inArray = false;
      return;
    }
    const h = tomlHeader(line);
    if (h !== null) { table = h; return; }
    const kv = TOML_KEY.exec(line);
    if (!kv) return;
    if (table === 'project' && kv[1] === 'dependencies' && kv[2].trimStart().startsWith('[')) {
      const rest = kv[2].trimStart().slice(1);
      for (const str of tomlStrings(rest)) {
        const r = pep508(str);
        if (r) deps.push(dep(r.name, r.version, 'pypi', i + 1));
      }
      inArray = !closesArray(rest);
    } else if (table === 'tool.poetry.dependencies') {
      const name = unquote(kv[1]);
      if (name !== 'python') deps.push(dep(name, tomlVersion(kv[2]), 'pypi', i + 1));
    }
  });
  return { deps };
};

const cargo: Parser = text => {
  const deps: Dep[] = [];
  let table = '';
  lines(text).forEach((raw, i) => {
    const line = noHash(raw);
    const h = tomlHeader(line);
    if (h !== null) { table = h; return; }
    if (table !== 'dependencies' && table !== 'dev-dependencies') return;
    const kv = TOML_KEY.exec(line);
    // `serde.workspace = true` inherits the workspace's version: the crate is `serde`, with no version here.
    const inherited = kv ? /^(.+)\.workspace$/.exec(kv[1]) : null;
    if (kv) deps.push(dep(unquote(inherited ? inherited[1] : kv[1]), inherited ? '' : tomlVersion(kv[2]), 'cargo', i + 1, table === 'dev-dependencies'));
  });
  return { deps };
};

const goMod: Parser = text => {
  const deps: Dep[] = [];
  let block = false;
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (block) {
      if (line.startsWith(')')) { block = false; return; }
      const m = /^(\S+)\s+(\S+)/.exec(line);
      if (m) deps.push(dep(m[1], m[2], 'go', i + 1));
      return;
    }
    if (/^require\s*\($/.test(line)) { block = true; return; }
    const m = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (m) deps.push(dep(m[1], m[2], 'go', i + 1));
  });
  return { deps };
};

/** `gem 'x', '~> 1'` and `pod 'X', '~> 1'`: name, then any further plain string arguments joined as the version. */
const rubyDsl = (word: string, eco: string): Parser => text => {
  const deps: Dep[] = [];
  const head = new RegExp(`^\\s*${word}\\s*(?:\\(\\s*)?(['"])([^'"]+)\\1(.*)$`);
  lines(text).forEach((raw, i) => {
    const m = head.exec(noHash(raw));
    if (!m) return;
    const versions: string[] = [];
    let prev = 0;
    for (const v of m[3].matchAll(/,\s*(['"])([^'"]*)\1/g)) {
      // Stop at the first option (`:git => ...`, `require: false`); only leading strings are versions.
      if (m[3].slice(prev, v.index).includes(':')) break;
      prev = v.index + v[0].length;
      versions.push(v[2]);
    }
    deps.push(dep(m[2], versions.join(', '), eco, i + 1));
  });
  return { deps };
};

const GRADLE_CONF = '(implementation|api|testImplementation)';
const gradle: Parser = text => {
  const deps: Dep[] = [];
  const coord = new RegExp(`^\\s*${GRADLE_CONF}\\s*(?:\\(\\s*)?(['"])([^'"\\s:]+):([^'"\\s:]+)(?::([^'"\\s]+))?\\2`);
  const named = new RegExp(`^\\s*${GRADLE_CONF}\\s*(?:\\(\\s*)?group\\s*[:=]\\s*(['"])([^'"]+)\\2\\s*,\\s*name\\s*[:=]\\s*(['"])([^'"]+)\\4(?:\\s*,\\s*version\\s*[:=]\\s*(['"])([^'"]+)\\6)?`);
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    const c = coord.exec(line);
    if (c) { deps.push(dep(`${c[3]}:${c[4]}`, c[5] ?? '', 'maven', i + 1, c[1] === 'testImplementation')); return; }
    const n = named.exec(line);
    if (n) deps.push(dep(`${n[3]}:${n[5]}`, n[7] ?? '', 'maven', i + 1, n[1] === 'testImplementation'));
  });
  return { deps };
};

const pubspec: Parser = text => {
  const deps: Dep[] = [];
  const ls = lines(text);
  let section: 'dependencies' | 'dev_dependencies' | null = null;
  let indent = -1;
  let open: Dep | null = null;
  ls.forEach((raw, i) => {
    const line = noHash(raw).replace(/\s+$/, '');
    if (!line.trim()) return;
    const depth = line.length - line.trimStart().length;
    if (depth === 0) {
      open = null;
      indent = -1;
      const top = /^(dependencies|dev_dependencies)\s*:\s*$/.exec(line);
      section = top ? top[1] as typeof section : null;
      return;
    }
    if (!section) return;
    if (indent === -1) indent = depth;
    if (depth === indent) {
      const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
      open = null;
      if (!m) return;
      const d = dep(m[1], unquote(m[2]), 'pub', i + 1, section === 'dev_dependencies');
      deps.push(d);
      if (!m[2].trim()) open = d;
    } else if (open && depth > indent) {
      const sub = /^\s*(sdk|version)\s*:\s*(.*)$/.exec(line);
      if (sub && !open.version) open.version = sub[1] === 'sdk' ? 'sdk' : unquote(sub[2]);
    }
  });
  return { deps };
};

const BY_NAME = new Map<string, Parser>([
  ['package.json', packageJson],
  ['pyproject.toml', pyproject],
  ['go.mod', goMod],
  ['Cargo.toml', cargo],
  ['Gemfile', rubyDsl('gem', 'gem')],
  ['composer.json', composerJson],
  ['build.gradle', gradle],
  ['build.gradle.kts', gradle],
  ['pubspec.yaml', pubspec],
  ['Podfile', rubyDsl('pod', 'cocoapods')],
]);

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const parserFor = (rel: string): Parser | null => {
  const b = baseName(rel);
  return BY_NAME.get(b) ?? (/^requirements[\w.-]*\.txt$/.test(b) ? requirements : null);
};

/** Package manifests: declared dependencies (with the line of each) and npm scripts. */
export const deps: Analyzer = {
  name: 'deps',
  applies: rel => parserFor(rel) !== null,
  run(rel, _lang, text) {
    const p = parserFor(rel);
    return p ? { deps: p(text) } : {};
  },
};
