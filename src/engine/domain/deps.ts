import type { Dep } from '../../shared/types.js';
import type { Analyzer, DomainFacts } from './index.js';
import { lineAt } from './util.js';
import { baseName } from '../paths.js';

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
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    // A trailing `\` continues the requirement on the next line; it is reported at its first line.
    const first = i;
    let line = noHash(ls[i]).trim();
    while (line.endsWith('\\') && i + 1 < ls.length) line = line.slice(0, -1) + ' ' + noHash(ls[++i]).trim();
    if (!line || line.startsWith('-') || /^[\w+.-]*:\/\//.test(line)) continue;
    // Per-requirement options (`--hash=sha256:...`, `--hash sha256:...`) follow the requirement.
    const opts = line.search(/\s--/);
    const r = pep508((opts < 0 ? line : line.slice(0, opts)).replace(/\\$/, ''));
    if (r) deps.push(dep(r.name, r.version, 'pypi', first + 1));
  }
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

/** Extras and dependency groups named for development rather than an optional runtime feature. */
const DEV_GROUP = /^(?:dev|develop|development|test|tests|testing|lint|linting|docs?|typing|types|check|qa|ci)$/i;

const pyproject: Parser = text => {
  const deps: Dep[] = [];
  const ls = lines(text);
  let table = '';
  let inArray = false;
  let arrayDev = false;
  const pep = (strs: string[], line: number, dev: boolean): void => {
    for (const str of strs) {
      const r = pep508(str);
      if (r) deps.push(dep(r.name, r.version, 'pypi', line, dev));
    }
  };
  ls.forEach((raw, i) => {
    const line = noHash(raw);
    if (inArray) {
      pep(tomlStrings(line), i + 1, arrayDev);
      if (closesArray(line)) inArray = false;
      return;
    }
    const h = tomlHeader(line);
    if (h !== null) { table = h; return; }
    const kv = TOML_KEY.exec(line);
    if (!kv) return;
    // PEP 621 arrays: `[project] dependencies` and each `[project.optional-dependencies]` extra.
    const extra = table === 'project.optional-dependencies';
    if (((table === 'project' && kv[1] === 'dependencies') || extra) && kv[2].trimStart().startsWith('[')) {
      const rest = kv[2].trimStart().slice(1);
      arrayDev = extra && DEV_GROUP.test(unquote(kv[1]));
      pep(tomlStrings(rest), i + 1, arrayDev);
      inArray = !closesArray(rest);
      return;
    }
    // Poetry: main dependencies, legacy `dev-dependencies`, and `group.<name>.dependencies` (any group but main is dev).
    const group = /^tool\.poetry\.group\.("[^"]+"|[\w-]+)\.dependencies$/.exec(table);
    if (table === 'tool.poetry.dependencies' || table === 'tool.poetry.dev-dependencies' || group) {
      const name = unquote(kv[1]);
      const dev = table === 'tool.poetry.dev-dependencies' || (!!group && unquote(group[1]) !== 'main');
      if (name !== 'python') deps.push(dep(name, tomlVersion(kv[2]), 'pypi', i + 1, dev));
    }
  });
  return { deps };
};

/**
 * A Cargo dependency table: `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`, each optionally under
 * `target.<triple or 'cfg(...)'>.`, and the one-crate form `[dependencies.tokio]` (group 2).
 */
const CARGO_TABLE = /^(?:target\.(?:'[^']*'|"[^"]*"|[^.'"]+)\.)?(dev-|build-)?dependencies(?:\.(.+))?$/;

const cargo: Parser = text => {
  const deps: Dep[] = [];
  let table: { dev: boolean } | null = null;
  let crate: Dep | null = null;
  lines(text).forEach((raw, i) => {
    const line = noHash(raw);
    // Not tomlHeader: a `cfg(target_os = "linux")` target holds `=`.
    const h = /^\s*\[\[?(.*?)\]\]?\s*$/.exec(line);
    if (h) {
      const t = CARGO_TABLE.exec(h[1].trim());
      table = t && !t[2] ? { dev: t[1] === 'dev-' } : null;
      crate = t?.[2] ? dep(unquote(t[2]), '', 'cargo', i + 1, t[1] === 'dev-') : null;
      if (crate) deps.push(crate);
      return;
    }
    const kv = TOML_KEY.exec(line);
    if (!kv) return;
    if (crate) {
      if (kv[1] === 'version') crate.version = tomlVersion(kv[2]);
      return;
    }
    if (!table) return;
    // `serde.workspace = true` inherits the workspace's version: the crate is `serde`, with no version here.
    const inherited = /^(.+)\.workspace$/.exec(kv[1]);
    deps.push(dep(unquote(inherited ? inherited[1] : kv[1]), inherited ? '' : tomlVersion(kv[2]), 'cargo', i + 1, table.dev));
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

/**
 * A dependency configuration: Gradle's own and their source-set or variant forms (`implementation`, `api`,
 * `compileOnly`, `runtimeOnly`, `testImplementation`, `debugImplementation`, `annotationProcessor`), the
 * annotation processors (`kapt`, `ksp` and their variants) and a few common others. A word such as
 * `println` or `mainClassName` before a `"a:b"` string is not one.
 */
const GRADLE_CONF = '((?:[a-z][A-Za-z0-9]*)?(?:[Ii]mplementation|[Aa]pi|[Cc]ompileOnly(?:Api)?|[Rr]untimeOnly|[Aa]nnotationProcessor|[Cc]ompile|[Rr]untime)|kapt[A-Za-z0-9]*|ksp[A-Za-z0-9]*|classpath|coreLibraryDesugaring|developmentOnly|lintChecks|detektPlugins|shadow|antlr|errorprone|jmh|provided(?:Compile|Runtime)?|agent|spotbugsPlugins)';
/** Words that start a dependency-shaped line without being a configuration. */
const NOT_CONF = new Set(['id', 'platform', 'enforcedPlatform', 'project', 'files', 'fileTree', 'kotlin', 'alias']);
/** Test and debug-only configurations (`testImplementation`, `androidTestImplementation`, `kaptTest`, `debugImplementation`). */
const devConf = (conf: string): boolean => /^(?:test|androidTest|debug)|Test/.test(conf);
const gradle: Parser = text => {
  const deps: Dep[] = [];
  // No `/` in group or artifact, so `url "https://..."` is not a coordinate.
  const coord = new RegExp(`^\\s*${GRADLE_CONF}\\s*(?:\\(\\s*)?(['"])([^'"\\s:/]+):([^'"\\s:/]+)(?::([^'"\\s]+))?\\2`);
  const named = new RegExp(`^\\s*${GRADLE_CONF}\\s*(?:\\(\\s*)?group\\s*[:=]\\s*(['"])([^'"]+)\\2\\s*,\\s*name\\s*[:=]\\s*(['"])([^'"]+)\\4(?:\\s*,\\s*version\\s*[:=]\\s*(['"])([^'"]+)\\6)?`);
  // A version catalog accessor: `implementation(libs.androidx.core.ktx)`, resolved against the catalog by the domain index.
  const catalog = new RegExp(`^\\s*${GRADLE_CONF}\\s*(?:\\(\\s*|\\s)(libs\\.[\\w.]+?)(?:\\.get\\(\\))?\\s*(?:\\)|$|\\{)`);
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    const c = coord.exec(line);
    if (c && !NOT_CONF.has(c[1])) { deps.push(dep(`${c[3]}:${c[4]}`, c[5] ?? '', 'maven', i + 1, devConf(c[1]))); return; }
    const n = named.exec(line);
    if (n && !NOT_CONF.has(n[1])) { deps.push(dep(`${n[3]}:${n[5]}`, n[7] ?? '', 'maven', i + 1, devConf(n[1]))); return; }
    const v = catalog.exec(line);
    if (v && !NOT_CONF.has(v[1]) && !/^libs\.(?:plugins|versions)\./.test(v[2])) deps.push(dep(v[2], '', 'maven', i + 1, devConf(v[1])));
  });
  return { deps };
};

/** A catalog alias or accessor path in one form: `-`, `_` and `.` all separate the same segments. */
const catalogKey = (alias: string): string => alias.replace(/[-_.]+/g, '.');

/**
 * `gradle/libs.versions.toml`: library accessor (`androidx.core.ktx`, normalized by catalogKey) to its
 * modules, one per library or several for a `bundles.<name>` accessor, with versions where given.
 */
export function parseVersionCatalog(text: string): Map<string, { name: string; version: string }[]> {
  const versions = new Map<string, string>();
  const libs = new Map<string, { name: string; version: string; ref?: string }>();
  const bundles: [string, string[]][] = [];
  let table = '';
  let open: { key: string; items: string[] } | null = null;
  for (const raw of lines(text)) {
    const line = noHash(raw);
    if (open) {
      open.items.push(...tomlStrings(line));
      if (closesArray(line)) open = null;
      continue;
    }
    const h = tomlHeader(line);
    if (h !== null) { table = h; continue; }
    const kv = TOML_KEY.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]);
    const value = kv[2].trim();
    if (table === 'versions') {
      versions.set(key, tomlVersion(value));
    } else if (table === 'libraries') {
      const str = /^(?:"([^"]*)"|'([^']*)')/.exec(value);
      const field = (f: string): string | undefined => {
        const m = new RegExp(`\\b${f.replace('.', '\\.')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(value);
        return m ? m[1] ?? m[2] : undefined;
      };
      let name: string | undefined, version = '', ref: string | undefined;
      if (str) {
        const parts = (str[1] ?? str[2]).split(':');
        name = parts.slice(0, 2).join(':');
        version = parts[2] ?? '';
      } else {
        const group = field('group');
        name = field('module') ?? (group && field('name') ? `${group}:${field('name')}` : undefined);
        ref = field('version.ref');
        version = field('version') ?? '';
      }
      if (name?.includes(':')) libs.set(catalogKey(key), ref === undefined ? { name, version } : { name, version, ref });
    } else if (table === 'bundles' && value.startsWith('[')) {
      const rest = value.slice(1);
      const b = { key, items: tomlStrings(rest) };
      bundles.push([b.key, b.items]);
      if (!closesArray(rest)) open = b;
    }
  }
  // `version.ref` resolves after the whole file is read: `[versions]` may come after `[libraries]`.
  const out = new Map<string, { name: string; version: string }[]>();
  const resolved = new Map<string, { name: string; version: string }>();
  for (const [k, { name, version, ref }] of libs) resolved.set(k, { name, version: ref === undefined ? version : versions.get(ref) ?? '' });
  for (const [k, lib] of resolved) out.set(k, [lib]);
  for (const [k, items] of bundles) {
    out.set(catalogKey(`bundles.${k}`), items.map(a => resolved.get(catalogKey(a))).filter((l): l is { name: string; version: string } => !!l));
  }
  return out;
}

/**
 * Gradle deps with catalog accessors (`libs.x.y`) replaced by the modules the catalog names; an accessor
 * the catalog lacks, or any accessor without a catalog, stays as recorded.
 */
export function resolveCatalogDeps(deps: Dep[], catalog: ReturnType<typeof parseVersionCatalog> | null): Dep[] {
  if (!catalog) return deps;
  return deps.flatMap(d => {
    const libs = d.eco === 'maven' && d.name.startsWith('libs.') ? catalog.get(catalogKey(d.name.slice(5))) : undefined;
    return libs?.length ? libs.map(l => ({ ...d, name: l.name, version: l.version })) : [d];
  });
}

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
