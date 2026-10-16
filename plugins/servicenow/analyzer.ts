/**
 * The ServiceNow analyzer: turns mirror files (mirror.ts) into LiveMap facts.
 * - Entities: `schema/<table>.sntable.json`, reference columns as foreign keys.
 * - Routes: portal pages (`/<portal>?id=<page>`), workspace routes, Scripted REST operations.
 * - Symbols: a script include's class and methods; a business rule or client script as one symbol
 *   with signature `table.when(condition)`.
 * - Rules: business rules, client scripts, UI policies and ACLs on a table.
 * - Links: `new X()` (also `new x_scope.X()`), `gs.include('X')`, `new GlideAjax('X')` to script
 *   includes; GlideRecord tables and string literals naming a scope table to their schema; a portal to
 *   its home page; a page's meta.json to its layout and the layout to the widgets it places; a
 *   widget's meta.json to its code; a widget to embedded widgets; a rule, ACL or UI action to its
 *   table; a table to the table it extends.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Analyzer, DomainFacts } from '../../src/engine/domain/index.js';
import { hashText } from '../../src/engine/symbols/helpers.js';
import type { CodeSymbol, Entity, Field, Route, Rule } from '../../src/shared/types.js';
import { readHeader } from './mirror.js';
import { safeSegment } from './paths.js';

const KINDS = 'widget|page|portal|schema|business_rule|client_script|script_include|ui_action|ui_policy|acl|flow|rest|workspace|ai_agent|other';
const MIRROR_PATH = new RegExp(`^[^/]+/(${KINDS})/`);
const SEG = /^(.*)__([0-9a-f]{32})(\.[a-z]+)?$/i;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function parse(text: string): Obj {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}; } catch { return {}; }
}

/** Names in a scope's mirror, from the paths in its manifest: script includes, widgets and table schemas. */
interface ScopeIndex { scriptIncludes: Map<string, string>; widgets: Map<string, string>; tables: Set<string> }

const emptyIndex = (): ScopeIndex => ({ scriptIncludes: new Map(), widgets: new Map(), tables: new Set() });

/** Reads `<root>/<scope>.manifest.json` files (written by writer.ts) and indexes them by scope. */
export class MirrorIndex {
  private scopes = new Map<string, ScopeIndex>();
  private stamp = '';
  constructor(private readonly root: string) {}

  /** The index of a scope's folder name, reloaded when a manifest changed. */
  scope(ns: string): ScopeIndex {
    this.refresh();
    return this.scopes.get(ns) ?? emptyIndex();
  }

  /**
   * The script include a name in scope `ns` calls. A bare name (`Utils`) is looked up in `ns`; a qualified one
   * (`x_other.Utils`, `global.Utils`) in `ns` first, then in the mirror of the scope it names.
   */
  scriptInclude(ns: string, name: string): string | undefined {
    const own = this.scope(ns).scriptIncludes.get(name);
    const dot = name.lastIndexOf('.');
    if (own || dot < 0) return own;
    const other = this.scope(name.slice(0, name.indexOf('.')));
    return other.scriptIncludes.get(name) ?? other.scriptIncludes.get(name.slice(dot + 1));
  }

  private refresh(): void {
    let names: string[];
    try { names = fs.readdirSync(this.root).filter(n => n.endsWith('.manifest.json')).sort(); } catch { names = []; }
    const stamp = names.map(n => { try { return `${n}:${fs.statSync(path.join(this.root, n)).mtimeMs}`; } catch { return n; } }).join('|');
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    this.scopes.clear();
    for (const n of names) {
      let files: string[] = [];
      try { files = (JSON.parse(fs.readFileSync(path.join(this.root, n), 'utf8')) as { files?: string[] }).files ?? []; } catch { continue; }
      const idx = emptyIndex();
      for (const p of files) {
        const parts = p.split('/');
        const ns = parts[0];
        if (!this.scopes.has(ns)) this.scopes.set(ns, idx);
        if (parts[1] === 'schema' && parts.length === 3 && parts[2].endsWith('.sntable.json')) {
          idx.tables.add(parts[2].slice(0, -'.sntable.json'.length));
          continue;
        }
        const m = SEG.exec(parts[2] ?? '');
        if (!m) continue;
        if (parts[1] === 'script_include' && parts.length === 3) {
          // `<api_name>__<sys_id>.js`: the api name (`x_scope.Name`) and the bare class name both resolve.
          idx.scriptIncludes.set(m[1], p);
          idx.scriptIncludes.set(m[1].slice(m[1].lastIndexOf('.') + 1), p);
        } else if (parts[1] === 'widget' && parts[3] === 'meta.json') {
          idx.widgets.set(m[1], p);
        }
      }
    }
  }
}

/** The code files a widget folder can hold, next to its meta.json. */
const WIDGET_CODE = ['template.html', 'client.js', 'server.js', 'link.js'];

/** A table name's schema file in a scope's mirror. */
const schemaPath = (ns: string, table: string): string => `${ns}/schema/${safeSegment(table)}.sntable.json`;

function symbol(name: string, kind: CodeSymbol['kind'], signature: string, line: number, endLine: number, body: string, children: CodeSymbol[] = [], parent?: string): CodeSymbol {
  return { name, qname: parent ? `${parent}.${name}` : name, kind, signature, line, endLine, exported: true, hash: hashText(body), children };
}

/** `var X = Class.create();` and the methods of `X.prototype = { m: function () {...} }`. */
function scriptIncludeSymbols(text: string, header: Obj): CodeSymbol[] {
  const lines = text.split('\n');
  const name = str(header.name) ?? /var\s+(\w+)\s*=\s*Class\.create\(/.exec(text)?.[1];
  if (!name) return [];
  const decl = lines.findIndex(l => new RegExp(`\\b${name}\\s*=\\s*Class\\.create\\(`).test(l));
  const proto = lines.findIndex(l => new RegExp(`\\b${name}\\.prototype\\s*=`).test(l));
  const start = (decl >= 0 ? decl : proto >= 0 ? proto : 0) + 1;
  const methods: CodeSymbol[] = [];
  const re = /^(\s*)(\w+)\s*:\s*function\s*\(([^)]*)\)/;
  const found: { name: string; line: number; params: string; indent: number }[] = [];
  lines.forEach((l, i) => {
    if (proto < 0 || i <= proto) return;
    const m = re.exec(l);
    if (m) found.push({ name: m[2], line: i + 1, params: m[3].trim(), indent: m[1].length });
  });
  const minIndent = Math.min(...found.map(f => f.indent));
  const top = found.filter(f => f.indent === minIndent);
  top.forEach((f, k) => {
    const end = k + 1 < top.length ? top[k + 1].line - 1 : lines.length;
    methods.push(symbol(f.name, 'method', `${f.name}(${f.params})`, f.line, end, lines.slice(f.line - 1, end).join('\n'), [], name));
  });
  const parent = /Object\.extendsObject\(\s*([\w.]+)/.exec(text)?.[1];
  return [symbol(name, 'class', parent ? `class ${name} extends ${parent}` : `class ${name}`, start, lines.length, text, methods)];
}

/**
 * The one symbol of a portal, page, layout, widget or table record file. These are JSON, and the Map draws a
 * JSON file only when it has symbols, so this puts the records on the Map next to the scripts they use.
 */
function recordSymbol(name: string, kind: CodeSymbol['kind'], signature: string, text: string): CodeSymbol {
  return symbol(name, kind, signature, 1, text.split('\n').length, text);
}

/** The one symbol of a business rule or client script: `table.when(condition)`. */
function ruleSymbol(text: string, header: Obj): CodeSymbol[] {
  const name = str(header.name);
  if (!name) return [];
  const sig = `${str(header.table) ?? '?'}.${str(header.when) ?? 'run'}(${str(header.condition) ?? ''})`;
  return [symbol(name, 'function', sig, 1, text.split('\n').length, text)];
}

function ruleOf(kind: Rule['kind'], h: Obj, table: string | undefined, extra: Partial<Rule> = {}): Rule[] {
  if (!table) return [];
  const actions = Array.isArray(h.actions) ? h.actions.filter((a): a is string => typeof a === 'string') : undefined;
  const r: Rule = { kind, name: str(h.name) ?? '', table, line: 1 };
  const when = str(h.when);
  const order = num(h.order);
  const condition = str(h.condition);
  if (when) r.when = when;
  if (order !== undefined) r.order = order;
  if (condition) r.condition = condition;
  if (actions?.length) r.actions = actions;
  if (typeof h.active === 'boolean') r.active = h.active;
  return [{ ...r, ...extra }];
}

/** The analyzer for one mirror root (`.livemap/sn`). */
export function serviceNowAnalyzer(root: string): Analyzer & { index: MirrorIndex } {
  const index = new MirrorIndex(root);
  const kindOf = (rel: string) => MIRROR_PATH.exec(rel)?.[1];

  const run = (rel: string, text: string): Partial<DomainFacts> => {
    const kind = kindOf(rel);
    const base = path.posix.basename(rel);
    if (kind === 'schema' && base.endsWith('.sntable.json')) {
      const t = parse(text);
      const table = str(t.table);
      if (!table) return {};
      const columns = Array.isArray(t.columns) ? t.columns as Obj[] : [];
      const fields: Field[] = [{ name: 'sys_id', type: 'GUID', pk: true }];
      columns.forEach((c) => {
        const name = str(c.element);
        if (!name || name === 'sys_id') return;
        const f: Field = { name, type: str(c.type) ?? 'string' };
        if (c.mandatory === true) f.required = true;
        const ref = str(c.reference);
        if (ref) f.fk = { table: ref, field: 'sys_id' };
        fields.push(f);
      });
      // The label ("Credit Card Application") names the card; the table name stays the key.
      const entity: Entity = { name: str(t.label)?.trim() || table, table, orm: 'servicenow', file: rel, line: 1, fields };
      // A dictionary-only file adds columns to a table defined elsewhere (another scope or the platform).
      if (t.defined_here === false) entity.partial = true;
      return { entities: [entity], symbols: [recordSymbol(table, 'struct', `table ${table}`, text)] };
    }
    if (kind === 'page' && base === 'meta.json') {
      const p = parse(text);
      const id = str(p.id);
      if (!id) return {};
      const portals = Array.isArray(p.portals) ? (p.portals as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const routes: Route[] = (portals.length ? portals : ['sp']).map(s => ({ method: 'GET', path: `/${s}?id=${id}`, kind: 'page', framework: 'servicenow', line: 1 }));
      return { routes, symbols: [recordSymbol(id, 'component', `page ${routes[0].path}`, text)] };
    }
    if (kind === 'page' && base === 'layout.json') {
      const placed = links(rel, text, () => true).length;
      return { symbols: [recordSymbol('layout', 'module', `layout (${placed} widget${placed === 1 ? '' : 's'})`, text)] };
    }
    if (kind === 'widget' && base === 'meta.json') {
      const w = parse(text);
      const id = str(w.id) ?? str(w.name);
      return id ? { symbols: [recordSymbol(id, 'component', `widget ${str(w.name) ?? id}`, text)] } : {};
    }
    if (kind === 'portal' && base === 'meta.json') {
      const p = parse(text);
      const suffix = str(p.url_suffix) ?? str(p.title);
      return suffix ? { symbols: [recordSymbol(suffix, 'component', `portal /${suffix}`, text)] } : {};
    }
    if (kind === 'workspace' && rel.includes('/sys_ux_app_route/')) {
      const r = parse(text);
      const name = str(r.route_type) ?? str(r.name);
      return name ? { routes: [{ method: 'GET', path: `/${name}`, kind: 'screen', framework: 'servicenow', line: 1 }] } : {};
    }
    if (kind === 'acl' && base.endsWith('.json')) {
      const a = parse(text);
      const name = str(a.name) ?? '';
      const [table, field] = name.split('.');
      const r = ruleOf('acl', { ...a, when: a.operation }, table || undefined, field && field !== '*' ? { field } : {});
      return { rules: r.map(x => ({ ...x, active: a.active === 'true' })) };
    }
    if (kind === 'ui_policy' && base.endsWith('.json')) {
      const u = parse(text);
      return { rules: ruleOf('ui_policy', { name: u.short_description, condition: u.conditions, order: Number(u.order) || undefined, active: u.active === 'true' }, str(u.table)) };
    }
    const h = readHeader(text);
    if (!h) return {};
    if (kind === 'script_include') return { symbols: scriptIncludeSymbols(text, h) };
    if (kind === 'business_rule') return { symbols: ruleSymbol(text, h), rules: ruleOf('business_rule', h, str(h.table)) };
    if (kind === 'client_script') return { symbols: ruleSymbol(text, h), rules: ruleOf('client_script', h, str(h.table), str(h.field) ? { field: str(h.field) } : {}) };
    if (kind === 'rest') {
      const m = str(h.method) ?? 'GET';
      const p = str(h.path);
      return p ? { routes: [{ method: m.toUpperCase(), path: p, kind: 'api', framework: 'servicenow', line: 1 }] } : {};
    }
    return {};
  };

  const links = (rel: string, text: string, has: (p: string) => boolean): string[] => {
    const kind = kindOf(rel);
    const ns = rel.slice(0, rel.indexOf('/'));
    const base = path.posix.basename(rel);
    const out = new Set<string>();
    const add = (p: string | undefined) => { if (p && has(p)) out.add(p); };
    const idx = () => index.scope(ns);
    const table = (t: string | undefined) => { if (t) add(schemaPath(ns, t)); };
    if (kind === 'portal' && base === 'meta.json') add(str(parse(text).homepage_path));
    if (kind === 'page' && base === 'layout.json') {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (!v || typeof v !== 'object') return;
        const o = v as Obj;
        if (o.widget && typeof o.widget === 'object') add(str((o.widget as Obj).path));
        for (const k of ['containers', 'rows', 'columns', 'instances']) if (k in o) walk(o[k]);
      };
      walk(parse(text));
    }
    // A widget's or page's meta.json uses the files of its own record, so portal -> page -> widget -> script
    // include stays one chain on the Map.
    if (kind === 'widget' && base === 'meta.json') {
      for (const f of WIDGET_CODE) add(path.posix.join(path.posix.dirname(rel), f));
    }
    if (kind === 'page' && base === 'meta.json') add(path.posix.join(path.posix.dirname(rel), 'layout.json'));
    if (kind === 'schema') table(str(parse(text).extends));
    if (kind === 'acl') table((str(parse(text).name) ?? '').split('.')[0] || undefined);
    if (kind === 'ui_policy') table(str(parse(text).table));
    if (/\.(js|html)$/.test(base)) {
      const h = readHeader(text);
      if (h) table(str(h.table));
      const si = (name: string) => add(index.scriptInclude(ns, name));
      // `new Utils()`, and scope-qualified `new x_scope.Utils()` or `new global.Utils()`.
      for (const m of text.matchAll(/new\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) si(m[1]);
      for (const m of text.matchAll(/gs\.include\(\s*['"]([\w.]+)['"]/g)) si(m[1]);
      for (const m of text.matchAll(/new\s+GlideAjax\(\s*['"]([\w.]+)['"]/g)) si(m[1]);
      for (const m of text.matchAll(/new\s+Glide(?:Record|RecordSecure|Aggregate)\(\s*['"](\w+)['"]/g)) table(m[1]);
      // A string that names one of the scope's tables: `options.table_name || 'x_scope_table'` feeding a GlideRecord.
      const tables = idx().tables;
      for (const m of text.matchAll(/(['"])([a-z][\w]*)\1/g)) if (tables.has(m[2])) table(m[2]);
      for (const m of text.matchAll(/\$sp\.getWidget\(\s*['"]([\w-]+)['"]/g)) add(idx().widgets.get(m[1]));
      for (const m of text.matchAll(/<sp-widget\b[^>]*\bwidget=["']'?([\w-]+)'?["']/g)) add(idx().widgets.get(m[1]));
    }
    out.delete(rel);
    return [...out].sort();
  };

  return {
    name: 'servicenow',
    index,
    applies: (rel) => MIRROR_PATH.test(rel),
    run: (rel, _lang, text) => run(rel, text),
    links: (rel, _lang, text, has) => links(rel, text, has),
  };
}

