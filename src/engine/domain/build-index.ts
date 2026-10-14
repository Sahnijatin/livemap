import type { ApiRoute, DomainIndex, EnvVar, Table } from '../../shared/domain.js';
import type { Dep, Entity, FileModel, Lang, Route } from '../../shared/types.js';
import { isEnvTemplate } from './env.js';
import { detectStack } from './stack.js';
import { defaultExport, filePath } from './util.js';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Mount chains followed above a router file. */
const MAX_MOUNT_DEPTH = 5;
/** Distinct mount chains kept per router file, so a hostile mount graph stays small. */
const MAX_CHAINS = 32;
/** Larger texts are not scanned for table references. */
const MAX_REF_TEXT = 1_000_000;
/** Languages never scanned for table references: docs, config, styles, markup and non-code files. */
const NO_REF_LANGS = new Set<Lang>(['markdown', 'json', 'yaml', 'toml', 'text', 'css', 'html', 'secret', 'other']);

interface Chain { prefix: string; via: string[] }

/** `prefix` + `path` for normalized route paths: the root path adds nothing. */
function join(prefix: string, path: string): string {
  if (prefix === '' || prefix === '/') return path;
  if (path === '/' || path === '') return prefix;
  return prefix + (path.startsWith('/') ? path : '/' + path);
}

/** Every mount prefix chain above `file`, outermost mount first; cycle-safe and capped at MAX_MOUNT_DEPTH mounts. */
function chainsOf(file: string, byTarget: Map<string, { from: string; prefix: string }[]>, seen: Set<string>, depth: number): Chain[] {
  const incoming = depth < MAX_MOUNT_DEPTH ? (byTarget.get(file) ?? []).filter(m => !seen.has(m.from)) : [];
  if (!incoming.length) return [{ prefix: '', via: [] }];
  const out: Chain[] = [];
  for (const m of incoming) {
    if (out.length >= MAX_CHAINS) break;
    seen.add(m.from);
    for (const c of chainsOf(m.from, byTarget, seen, depth + 1)) {
      if (out.length >= MAX_CHAINS) break;
      out.push({ prefix: join(c.prefix, m.prefix), via: [...c.via, m.from] });
    }
    seen.delete(m.from);
  }
  return out;
}

const routeId = (r: Route, fullPath: string, file: string): string => `${r.method} ${fullPath} ${file}:${r.line}`;

/** Expo Router files beside or below an `app/**\/_layout.tsx` that no analyzer gave a route become screens. */
function expoPromotions(files: FileModel[], contents: (p: string) => string | null): { file: string; route: Route }[] {
  const layouts: { dir: string; app: number }[] = [];
  for (const f of files) {
    const segs = f.path.split('/');
    const app = segs.lastIndexOf('app');
    if (segs[segs.length - 1] === '_layout.tsx' && app >= 0 && app < segs.length - 1) layouts.push({ dir: segs.slice(0, -1).join('/') + '/', app });
  }
  if (!layouts.length) return [];
  const out: { file: string; route: Route }[] = [];
  for (const f of files) {
    if (f.routes.length || !f.path.endsWith('.tsx')) continue;
    const layout = layouts.find(l => f.path.startsWith(l.dir));
    if (!layout) continue;
    const segs = f.path.split('/');
    const name = segs[segs.length - 1].slice(0, -'.tsx'.length);
    if (name.startsWith('_') || name.includes('+') || name === 'page' || /\.(test|spec|d)$/.test(name)) continue;
    const parts = [...segs.slice(layout.app + 1, -1), name];
    if (name === 'index') parts.pop();
    const text = contents(f.path);
    const d = text === null ? { line: 1 } : defaultExport(text);
    const route: Route = { method: 'SCREEN', path: filePath(parts), line: d.line, kind: 'screen', framework: 'expo-router' };
    if (d.name) route.handler = d.name;
    out.push({ file: f.path, route });
  }
  return out;
}

function buildRoutes(files: FileModel[], contents: (p: string) => string | null): ApiRoute[] {
  const hasNext = files.some(f => f.deps?.deps.some(d => d.eco === 'npm' && d.name === 'next'));
  const byTarget = new Map<string, { from: string; prefix: string }[]>();
  for (const f of files) {
    for (const m of f.mounts ?? []) {
      if (!m.target) continue;
      const list = byTarget.get(m.target);
      if (list) list.push({ from: f.path, prefix: m.prefix }); else byTarget.set(m.target, [{ from: f.path, prefix: m.prefix }]);
    }
  }
  const out: ApiRoute[] = [];
  const byId = new Map<string, ApiRoute>();
  const chains = new Map<string, Chain[]>();
  const add = (file: string, r: Route): void => {
    if (r.kind !== 'api') {
      // Page and screen paths are used as written: React Navigation screen names have no leading slash.
      out.push({ ...r, id: routeId(r, r.path, file), file, fullPath: r.path });
      return;
    }
    let list = chains.get(file);
    if (!list) chains.set(file, list = chainsOf(file, byTarget, new Set([file]), 0));
    for (const c of list) {
      const fullPath = join(c.prefix, r.path);
      const id = routeId(r, fullPath, file);
      const prev = byId.get(id);
      // Two mounting files reaching one router at the same prefix chain give one route mounted via both.
      if (prev) { prev.mountedVia = [...new Set([...(prev.mountedVia ?? []), ...c.via])].sort(cmp); continue; }
      const route: ApiRoute = { ...r, id, file, fullPath, ...(c.via.length ? { mountedVia: c.via } : {}) };
      byId.set(id, route);
      out.push(route);
    }
  };
  for (const f of files) {
    for (const r of f.routes) if (hasNext || r.framework !== 'next') add(f.path, r);
  }
  for (const p of expoPromotions(files, contents)) add(p.file, p.route);
  return out.sort((a, b) => cmp(a.fullPath, b.fullPath) || cmp(a.method, b.method) || cmp(a.file, b.file) || a.line - b.line);
}

function buildTables(files: FileModel[]): Table[] {
  const groups = new Map<string, { e: Entity; file: string }[]>();
  const modelTable = new Map<string, string>();
  for (const f of files) {
    for (const e of f.entities) {
      const key = e.table.toLowerCase();
      const g = groups.get(key);
      if (g) g.push({ e, file: f.path }); else groups.set(key, [{ e, file: f.path }]);
      if (!e.partial && !modelTable.has(e.name)) modelTable.set(e.name, e.table);
    }
  }
  // Head first: an ORM entity over SQL migrations (whatever the path order), then other full entities, then fragments.
  const rank = (e: Entity): number => (e.partial ? 2 : e.orm === 'sql' ? 1 : 0);
  for (const g of groups.values()) g.sort((a, b) => rank(a.e) - rank(b.e));
  // A relation target is reported as the merged table's own `table`; a model name (Room `User::class`, Drizzle
  // `usersTable`) maps through its table; the raw name only when neither matches.
  const keyTable = new Map([...groups].map(([k, g]) => [k, g[0].e.table]));
  const canonical = (name: string): string => {
    const model = modelTable.get(name);
    return keyTable.get(name.toLowerCase()) ?? (model === undefined ? undefined : keyTable.get(model.toLowerCase())) ?? name;
  };
  const tables: Table[] = [];
  for (const g of groups.values()) {
    const head = g[0].e;
    const fields: Table['fields'] = [];
    const seen = new Set<string>();
    const relations: Table['relations'] = [];
    for (const { e, file } of g) {
      for (const fd of e.fields) {
        const k = fd.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        fields.push({ ...fd, file });
        if (fd.fk) relations.push({ field: fd.name, to: canonical(fd.fk.table), many: false, via: 'fk' });
        if (fd.relation) relations.push({ field: fd.name, to: canonical(modelTable.get(fd.relation.model) ?? fd.relation.model), many: fd.relation.many, via: 'relation' });
      }
    }
    const sources = g.map(({ e, file }) => ({ file, line: e.line })).sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
    tables.push({ name: head.name, table: head.table, orm: head.orm, sources, fields, relations });
  }
  return tables.sort((a, b) => cmp(a.table.toLowerCase(), b.table.toLowerCase()));
}

/** Receivers whose `.model` member is read as a database model accessor (`prisma.order`, `ctx.db.order`). */
const DB_RECEIVERS = new Set(['prisma', 'db', 'tx', 'client', 'orm', 'knex', 'drizzle', 'sql', 'this.prisma', 'this.db', 'ctx.db', 'ctx.prisma']);
/** One or two identifier segments ending the text, not preceded by another member access. */
const RECEIVER = /(?<![\w$.])(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*$/;
/** True when the expression just before the `.` at `dot` is a database client receiver. */
const dbReceiver = (text: string, dot: number): boolean => {
  const m = RECEIVER.exec(text.slice(Math.max(0, dot - 64), dot));
  return !!m && DB_RECEIVERS.has(m[0]);
};
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lowerCamel = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const addTo = (m: Map<string, Set<string>>, k: string, v: string): void => {
  const s = m.get(k);
  if (s) s.add(v); else m.set(k, new Set([v]));
};

/**
 * Files that mention a table: its model names (case-sensitive), its table name (as written, lowercase or
 * uppercase; quoted names included) as whole words, or a lowerCamel model accessor on a database client (`prisma.order`).
 * One regex pass per file.
 */
function buildDataRefs(files: FileModel[], tables: Table[], contents: (p: string) => string | null): DomainIndex['dataRefs'] {
  if (!tables.length) return [];
  const words = new Map<string, Set<string>>();
  const accessors = new Map<string, Set<string>>();
  const byKey = new Map(tables.map(t => [t.table.toLowerCase(), t.table]));
  for (const f of files) {
    for (const e of f.entities) {
      const table = byKey.get(e.table.toLowerCase())!;
      addTo(words, e.name, table);
      addTo(accessors, lowerCamel(e.name), table);
    }
  }
  for (const t of tables) for (const w of [t.table, t.table.toLowerCase(), t.table.toUpperCase()]) addTo(words, w, t.table);
  const names = [...new Set([...words.keys(), ...accessors.keys()])].filter(Boolean).sort((x, y) => y.length - x.length || cmp(x, y));
  // One alternation of literal names, built once per rebuild; `$` and `_` count as identifier characters.
  const re = new RegExp(`(?<![\\w$])(?:${names.map(escape).join('|')})(?![\\w$])`, 'g');
  const out: DomainIndex['dataRefs'] = [];
  for (const f of files) {
    if (f.entities.length || NO_REF_LANGS.has(f.lang)) continue;
    const text = contents(f.path);
    if (text === null || text.length > MAX_REF_TEXT) continue;
    const hit = new Set<string>();
    for (const m of text.matchAll(re)) {
      const w = words.get(m[0]);
      if (w) for (const t of w) hit.add(t);
      const a = m.index > 0 && text.charCodeAt(m.index - 1) === 46 && dbReceiver(text, m.index - 1) ? accessors.get(m[0]) : undefined;
      if (a) for (const t of a) hit.add(t);
    }
    if (hit.size) out.push({ file: f.path, tables: [...hit].sort(cmp) });
  }
  return out;
}

function buildEnv(files: FileModel[]): EnvVar[] {
  const vars = new Map<string, EnvVar>();
  for (const f of files) {
    if (!f.env.length) continue;
    const example = isEnvTemplate(f.path);
    for (const name of f.env) {
      let v = vars.get(name);
      if (!v) vars.set(name, v = { name, files: [], inExample: false, definedInEnvFile: false });
      if (!v.files.includes(f.path)) v.files.push(f.path);
      if (example) v.inExample = true;
      if (f.flags.secret) v.definedInEnvFile = true;
    }
  }
  return [...vars.values()].sort((a, b) => cmp(a.name, b.name));
}

/** The project-wide domain index: mounted routes, merged tables, table references, stack, deps, scripts and env. */
export function buildDomainIndex(input: FileModel[], contents: (p: string) => string | null): DomainIndex {
  const files = [...input].sort((a, b) => cmp(a.path, b.path));
  const routes = buildRoutes(files, contents);
  const tables = buildTables(files);
  const deps: (Dep & { file: string })[] = [];
  const scripts: DomainIndex['scripts'] = [];
  for (const f of files) {
    if (!f.deps) continue;
    for (const d of f.deps.deps) deps.push({ ...d, file: f.path });
    for (const [name, command] of Object.entries(f.deps.scripts ?? {})) scripts.push({ file: f.path, name, command });
  }
  const env = buildEnv(files);
  const kinds = { api: 0, page: 0, screen: 0 };
  for (const r of routes) kinds[r.kind]++;
  return {
    routes, tables,
    dataRefs: buildDataRefs(files, tables, contents),
    stack: detectStack(deps, files),
    deps, scripts, env,
    counts: { routes: kinds.api, pages: kinds.page, screens: kinds.screen, tables: tables.length, deps: deps.length, env: env.length },
  };
}
