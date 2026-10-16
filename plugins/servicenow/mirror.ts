/**
 * The ServiceNow mirror: every record of a scope as files under `<mirror root>/<scope>/`, laid out by
 * class (docs/design/servicenow.md, "Mirror layout"). Each record's file or folder is `<name>__<sys_id>`
 * (paths.ts). Records that live inside another record's file (widget instances in a page's layout,
 * dictionary entries in a table's schema, roles in an ACL) map to that file. A manifest lists every
 * record with its class and path, so counts can be checked and a path maps back to its records.
 */
import { fitPath, recordSegment, safeSegment } from './paths.js';
import type { SnRecord } from './nexus.js';

export interface InventoryRow {
  sys_id: string; sys_class_name: string; sys_name: string;
  sys_created_on?: string; sys_updated_on?: string; sys_updated_by?: string;
}
export interface ScopeInfo { sys_id: string; scope: string; name: string; version?: string }

export interface ManifestEntry {
  class: string; name: string; path: string;
  /** Only the inventory fields were available (the class query failed or skipped this record). */
  partial?: true;
  /** A credential class: mirrored by name only. */
  withheld?: true;
}
export interface Manifest {
  version: 1;
  instance: string;
  scope: ScopeInfo;
  pulledAt: string;
  /** Every record of the scope, by sys_id. */
  records: Record<string, ManifestEntry>;
  /** Records per class: the same counts as the scope's sys_metadata inventory. */
  byClass: Record<string, number>;
}

export interface MirrorInput {
  instance: string;
  scope: ScopeInfo;
  inventory: InventoryRow[];
  /** Full records by sys_id (whatever the class queries returned). */
  full: Map<string, SnRecord>;
  pulledAt?: string;
  /** Absolute mirror root, so paths can be fitted under the Windows path limit. */
  rootAbs?: string;
}

/** Credential classes: their records are never fetched or written, only named. */
export const WITHHELD_CLASS = /^(sys_auth_profile|oauth_entity)|^discovery_credentials$/;
/** Fields never written, whatever the class: passwords, secrets, tokens, keys and credentials. */
export const SECRET_FIELD = /(password|passwd|secret|token|private_?key|api_?key|credential)/i;

/** A record without secret fields (and without a system property's value), keys sorted so a re-pull writes the same bytes. */
export function clean(r: SnRecord): SnRecord {
  const out: SnRecord = {};
  const property = r.sys_class_name === 'sys_properties';
  for (const k of Object.keys(r).sort()) if (!SECRET_FIELD.test(k) && !(property && k === 'value')) out[k] = r[k];
  return out;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const truthy = (v: string | undefined): boolean => v === 'true' || v === '1';

/** The first line of every mirrored script: `// @livemap-sn {json}`, which the analyzer reads. */
export const HEADER_PREFIX = '// @livemap-sn ';
export function scriptFile(header: Record<string, unknown>, script: string | undefined): string {
  const h = Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined && v !== ''));
  return `${HEADER_PREFIX}${JSON.stringify(h)}\n${script ?? ''}${script && !script.endsWith('\n') ? '\n' : ''}`;
}
export function readHeader(text: string): Record<string, unknown> | null {
  if (!text.startsWith(HEADER_PREFIX)) return null;
  const nl = text.indexOf('\n');
  try { return JSON.parse(text.slice(HEADER_PREFIX.length, nl < 0 ? undefined : nl)) as Record<string, unknown>; } catch { return null; }
}

/** The fields a record carries in a meta.json: everything but bulky script and markup fields. */
const BULKY = new Set(['script', 'client_script', 'template', 'css', 'link', 'option_schema', 'demo_data', 'instructions']);
function meta(r: SnRecord, partial: boolean, extra: Record<string, unknown> = {}): string {
  const base = Object.fromEntries(Object.entries(clean(r)).filter(([k]) => !BULKY.has(k)));
  return json({ ...base, ...extra, ...(partial ? { partial: true } : {}) });
}

interface Out { files: Map<string, string>; records: Record<string, ManifestEntry> }

/** Builds the mirror's files (scope-relative POSIX paths) and its manifest. */
export function layoutMirror(input: MirrorInput): { files: Map<string, string>; manifest: Manifest } {
  const ns = safeSegment(input.scope.scope);
  const out: Out = { files: new Map(), records: {} };
  const inv = new Map(input.inventory.map(r => [r.sys_id, r]));
  /** The full record, or the inventory row standing in for it. */
  const rec = (row: InventoryRow): { r: SnRecord; partial: boolean } => {
    const full = input.full.get(row.sys_id);
    return full ? { r: full, partial: false } : { r: { ...row } as unknown as SnRecord, partial: true };
  };
  const fit = (rel: string): string => (input.rootAbs ? fitPath(input.rootAbs, `${ns}/${rel}`).slice(ns.length + 1) : rel);
  const put = (rel: string, text: string): string => {
    const p = `${ns}/${fit(rel)}`;
    out.files.set(p, text);
    return p;
  };
  const note = (row: InventoryRow, path: string, partial: boolean, extra: Partial<ManifestEntry> = {}) => {
    out.records[row.sys_id] = { class: row.sys_class_name, name: row.sys_name ?? '', path, ...(partial ? { partial: true as const } : {}), ...extra };
  };
  const byClass = new Map<string, InventoryRow[]>();
  for (const row of input.inventory) {
    const list = byClass.get(row.sys_class_name) ?? [];
    list.push(row);
    byClass.set(row.sys_class_name, list);
  }
  const rows = (cls: string): InventoryRow[] => byClass.get(cls) ?? [];
  const nameOf = (r: SnRecord, ...keys: string[]): string => {
    for (const k of keys) if (r[k]?.trim()) return r[k];
    return r.name || r.sys_name || '';
  };
  const done = new Set<string>();
  const mark = (id: string) => done.add(id);

  // Widgets first: pages and other widgets point at them.
  const widgetPath = new Map<string, string>();
  const widgetById = new Map<string, string>();
  for (const row of rows('sp_widget')) {
    const { r, partial } = rec(row);
    const dir = `widget/${recordSegment(nameOf(r, 'id'), row.sys_id)}`;
    const m = put(`${dir}/meta.json`, meta(r, partial));
    if (!partial) {
      if (r.template) put(`${dir}/template.html`, r.template.endsWith('\n') ? r.template : `${r.template}\n`);
      if (r.client_script) put(`${dir}/client.js`, `${r.client_script}\n`);
      if (r.script) put(`${dir}/server.js`, `${r.script}\n`);
      if (r.link) put(`${dir}/link.js`, `${r.link}\n`);
      if (r.css) put(`${dir}/style.scss`, `${r.css}\n`);
      if (r.option_schema) put(`${dir}/option_schema.json`, json(parseJson(r.option_schema)));
    }
    widgetPath.set(row.sys_id, m);
    if (r.id) widgetById.set(r.id, m);
    note(row, m, partial);
    mark(row.sys_id);
  }

  // Pages, with their containers, rows, columns and widget instances in layout.json.
  const portals = rows('sp_portal').map(row => rec(row).r.url_suffix).filter(Boolean);
  const pagePath = new Map<string, string>();
  const children = (cls: string, field: string): Map<string, InventoryRow[]> => {
    const m = new Map<string, InventoryRow[]>();
    for (const row of rows(cls)) {
      const parent = rec(row).r[field];
      if (!parent) continue;
      const list = m.get(parent) ?? [];
      list.push(row);
      m.set(parent, list);
    }
    for (const list of m.values()) list.sort((a, b) => Number(rec(a).r.order ?? 0) - Number(rec(b).r.order ?? 0) || cmpStr(a.sys_id, b.sys_id));
    return m;
  };
  const containersOf = children('sp_container', 'sp_page');
  const rowsOfContainer = children('sp_row', 'sp_container');
  const rowsOfColumn = children('sp_row', 'sp_column');
  const columnsOf = children('sp_column', 'sp_row');
  const instancesOf = children('sp_instance', 'sp_column');
  for (const row of rows('sp_page')) {
    const { r, partial } = rec(row);
    const dir = `page/${recordSegment(nameOf(r, 'id'), row.sys_id)}`;
    const m = put(`${dir}/meta.json`, meta(r, partial, { portals }));
    pagePath.set(row.sys_id, m);
    note(row, m, partial);
    mark(row.sys_id);
  }
  for (const [pageId, m] of pagePath) {
    const lay = m.replace(/meta\.json$/, 'layout.json');
    const placed: InventoryRow[] = [];
    const instance = (row: InventoryRow) => {
      placed.push(row);
      const { r } = rec(row);
      const w = r.sp_widget;
      return {
        sys_id: row.sys_id, order: Number(r.order ?? 0), title: r.title || undefined, id: r.id || undefined,
        widget: w ? { sys_id: w, ...(widgetPath.has(w) ? { path: widgetPath.get(w) } : {}) } : undefined,
        options: parseJson(r.widget_parameters ?? ''),
      };
    };
    const column = (row: InventoryRow): unknown => {
      placed.push(row);
      const { r } = rec(row);
      return {
        sys_id: row.sys_id, order: Number(r.order ?? 0), size: r.size || undefined,
        instances: (instancesOf.get(row.sys_id) ?? []).map(instance),
        rows: (rowsOfColumn.get(row.sys_id) ?? []).map(rowOf),
      };
    };
    const rowOf = (row: InventoryRow): unknown => {
      placed.push(row);
      return { sys_id: row.sys_id, order: Number(rec(row).r.order ?? 0), columns: (columnsOf.get(row.sys_id) ?? []).map(column) };
    };
    const containers = (containersOf.get(pageId) ?? []).map(row => {
      placed.push(row);
      const { r } = rec(row);
      return { sys_id: row.sys_id, name: r.name || undefined, order: Number(r.order ?? 0), width: r.width || undefined, rows: (rowsOfContainer.get(row.sys_id) ?? []).map(rowOf) };
    });
    const layPath = put(lay.slice(ns.length + 1), json({ page: pageId, containers }));
    for (const p of placed) if (!done.has(p.sys_id)) { note(p, layPath, rec(p).partial); mark(p.sys_id); }
  }

  // Portals.
  for (const row of rows('sp_portal')) {
    const { r, partial } = rec(row);
    const dir = `portal/${recordSegment(nameOf(r, 'url_suffix'), row.sys_id)}`;
    const home = r.homepage && pagePath.has(r.homepage) ? pagePath.get(r.homepage) : undefined;
    const m = put(`${dir}/meta.json`, meta(r, partial, home ? { homepage_path: home } : {}));
    put(`${dir}/theme.json`, json({ theme: r.theme || null }));
    note(row, m, partial);
    mark(row.sys_id);
  }

  // Tables: sys_db_object and the dictionary entries (columns) of every table, defined here or extended.
  const tables = new Map<string, { obj?: SnRecord; objRow?: InventoryRow; columns: { row: InventoryRow; r: SnRecord; partial: boolean }[] }>();
  const table = (name: string) => {
    let t = tables.get(name);
    if (!t) { t = { columns: [] }; tables.set(name, t); }
    return t;
  };
  const objById = new Map<string, string>();
  for (const row of rows('sys_db_object')) {
    const { r } = rec(row);
    const name = r.name || row.sys_name;
    objById.set(row.sys_id, name);
    Object.assign(table(name), { obj: r, objRow: row });
  }
  for (const row of rows('sys_dictionary')) {
    const { r, partial } = rec(row);
    if (!r.name) continue; // inventory only: the table is unknown, so it goes to other/
    table(r.name).columns.push({ row, r, partial });
  }
  for (const [name, t] of tables) {
    const o = t.obj ?? {};
    const superName = o.super_class ? objById.get(o.super_class) ?? o.super_class : '';
    const columns = t.columns
      .filter(c => c.r.element)
      .sort((a, b) => cmpStr(a.r.element, b.r.element))
      .map(({ row, r }) => ({
        sys_id: row.sys_id, element: r.element, label: r.column_label || undefined, type: r.internal_type || undefined,
        reference: r.reference || undefined, max_length: r.max_length ? Number(r.max_length) : undefined,
        mandatory: truthy(r.mandatory) || undefined, read_only: truthy(r.read_only) || undefined,
        display: truthy(r.display) || undefined, active: r.active ? truthy(r.active) : undefined,
      }));
    const p = put(`schema/${safeSegment(name)}.sntable.json`, json({
      table: name, label: o.label?.trim() || undefined, sys_id: t.objRow?.sys_id, extends: superName || undefined,
      defined_here: !!t.obj, partial: t.objRow ? (rec(t.objRow).partial || undefined) : undefined, columns,
      collection: t.columns.filter(c => !c.r.element).map(c => c.row.sys_id),
    }));
    if (t.objRow) { note(t.objRow, p, rec(t.objRow).partial); mark(t.objRow.sys_id); }
    for (const c of t.columns) { note(c.row, p, c.partial); mark(c.row.sys_id); }
  }

  // Scripts that run on a table.
  for (const row of rows('sys_script')) {
    const { r, partial } = rec(row);
    const actions = (['insert', 'update', 'delete', 'query'] as const).filter(a => truthy(r[`action_${a}`]));
    const p = put(`business_rule/${safeSegment(r.collection || 'unknown')}/${recordSegment(nameOf(r), row.sys_id, '.js')}`, scriptFile({
      class: 'sys_script', sys_id: row.sys_id, name: nameOf(r), table: r.collection, when: r.when, order: num(r.order),
      condition: r.condition || r.filter_condition, actions: actions.length ? actions : undefined, active: bool(r.active), advanced: bool(r.advanced), partial: partial || undefined,
    }, r.script));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const row of rows('sys_script_client')) {
    const { r, partial } = rec(row);
    const p = put(`client_script/${safeSegment(r.table || 'unknown')}/${recordSegment(nameOf(r), row.sys_id, '.js')}`, scriptFile({
      class: 'sys_script_client', sys_id: row.sys_id, name: nameOf(r), table: r.table, when: r.type, field: r.field_name || undefined,
      order: num(r.order), condition: r.condition, active: bool(r.active), ui_type: r.ui_type, partial: partial || undefined,
    }, r.script));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const row of rows('sys_script_include')) {
    const { r, partial } = rec(row);
    const p = put(`script_include/${recordSegment(nameOf(r, 'api_name'), row.sys_id, '.js')}`, scriptFile({
      class: 'sys_script_include', sys_id: row.sys_id, name: r.name || row.sys_name, api_name: r.api_name,
      client_callable: bool(r.client_callable), access: r.access, active: bool(r.active), partial: partial || undefined,
    }, r.script));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const row of rows('sys_ui_action')) {
    const { r, partial } = rec(row);
    const p = put(`ui_action/${safeSegment(r.table || 'global')}/${recordSegment(nameOf(r), row.sys_id, '.js')}`, scriptFile({
      class: 'sys_ui_action', sys_id: row.sys_id, name: nameOf(r), table: r.table, action_name: r.action_name, order: num(r.order),
      condition: r.condition, client: bool(r.client), onclick: r.onclick, form_button: bool(r.form_button), list_button: bool(r.list_button),
      active: bool(r.active), partial: partial || undefined,
    }, r.script));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const row of rows('sys_ui_policy')) {
    const { r, partial } = rec(row);
    const p = put(`ui_policy/${safeSegment(r.table || 'unknown')}/${recordSegment(nameOf(r, 'short_description'), row.sys_id, '.json')}`, meta(r, partial));
    note(row, p, partial);
    mark(row.sys_id);
  }

  // ACLs, with their roles.
  const rolesOf = children('sys_security_acl_role', 'sys_security_acl');
  for (const row of rows('sys_security_acl')) {
    const { r, partial } = rec(row);
    const roles = (rolesOf.get(row.sys_id) ?? []).map(x => rec(x).r.sys_user_role).filter(Boolean);
    const p = put(`acl/${safeSegment(r.operation || 'unknown')}/${recordSegment(nameOf(r), row.sys_id, '.json')}`, meta(r, partial, { script: r.script || undefined, roles }));
    note(row, p, partial);
    mark(row.sys_id);
    for (const x of rolesOf.get(row.sys_id) ?? []) { note(x, p, rec(x).partial); mark(x.sys_id); }
  }

  // Flows, Scripted REST, workspaces and AI agents.
  for (const row of rows('sys_hub_flow')) {
    const { r, partial } = rec(row);
    const p = put(`flow/${recordSegment(nameOf(r), row.sys_id)}/meta.json`, meta(r, partial));
    note(row, p, partial);
    mark(row.sys_id);
  }
  const apiName = new Map<string, string>();
  for (const row of rows('sys_ws_definition')) {
    const { r, partial } = rec(row);
    apiName.set(row.sys_id, nameOf(r, 'service_id'));
    const p = put(`rest/${recordSegment(nameOf(r, 'service_id'), row.sys_id)}/meta.json`, meta(r, partial));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const row of rows('sys_ws_operation')) {
    const { r, partial } = rec(row);
    const api = safeSegment(apiName.get(r.web_service_definition) ?? 'unknown');
    const seg = `${r.http_method || 'GET'}_${(r.relative_path || '').replace(/^\/+/, '') || 'root'}`;
    const p = put(`rest/${api}/${recordSegment(seg, row.sys_id, '.js')}`, scriptFile({
      class: 'sys_ws_operation', sys_id: row.sys_id, name: nameOf(r), method: r.http_method, path: r.operation_uri || r.relative_path,
      api: apiName.get(r.web_service_definition), partial: partial || undefined,
    }, r.operation_script));
    note(row, p, partial);
    mark(row.sys_id);
  }
  for (const [cls, list] of byClass) {
    if (!/^sys_(ux|uib)_/.test(cls)) continue;
    for (const row of list) {
      if (done.has(row.sys_id)) continue;
      const { r, partial } = rec(row);
      const script = r.script?.trim() ? r.script : undefined;
      const p = script
        ? put(`workspace/${cls}/${recordSegment(nameOf(r), row.sys_id, '.js')}`, scriptFile({ class: cls, sys_id: row.sys_id, name: nameOf(r), partial: partial || undefined }, script))
        : put(`workspace/${cls}/${recordSegment(nameOf(r), row.sys_id, '.json')}`, meta(r, partial));
      note(row, p, partial);
      mark(row.sys_id);
    }
  }
  for (const [cls, list] of byClass) {
    if (!/^sn_aia_/.test(cls)) continue;
    for (const row of list) {
      const { r, partial } = rec(row);
      const p = cls === 'sn_aia_agent'
        ? put(`ai_agent/${recordSegment(nameOf(r), row.sys_id)}/meta.json`, meta(r, partial))
        : put(`ai_agent/${cls}/${recordSegment(nameOf(r), row.sys_id, '.json')}`, meta(r, partial));
      if (cls === 'sn_aia_agent' && r.instructions) put(p.slice(ns.length + 1).replace(/meta\.json$/, 'instructions.md'), `${r.instructions}\n`);
      note(row, p, partial);
      mark(row.sys_id);
    }
  }

  // Everything else, and credential classes by name only.
  for (const row of input.inventory) {
    if (done.has(row.sys_id)) continue;
    const cls = safeSegment(row.sys_class_name);
    if (WITHHELD_CLASS.test(row.sys_class_name)) {
      const p = put(`other/${cls}/${recordSegment(row.sys_name, row.sys_id, '.json')}`, json({ sys_id: row.sys_id, sys_class_name: row.sys_class_name, sys_name: row.sys_name, withheld: true }));
      note(row, p, false, { withheld: true });
    } else {
      const { r, partial } = rec(row);
      const p = put(`other/${cls}/${recordSegment(nameOf(r), row.sys_id, '.json')}`, json({ ...clean(r), ...(partial ? { partial: true } : {}) }));
      note(row, p, partial);
    }
    mark(row.sys_id);
  }

  const counts: Record<string, number> = {};
  for (const e of Object.values(out.records)) counts[e.class] = (counts[e.class] ?? 0) + 1;
  const records = Object.fromEntries(Object.entries(out.records).filter(([id]) => inv.has(id)));
  return {
    files: out.files,
    manifest: {
      version: 1, instance: input.instance, scope: input.scope, pulledAt: input.pulledAt ?? new Date().toISOString(),
      records, byClass: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => cmpStr(a, b))),
    },
  };
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const num = (v: string | undefined): number | undefined => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
const bool = (v: string | undefined): boolean | undefined => (v === undefined || v === '' ? undefined : truthy(v));
function parseJson(s: string): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return s; }
}
