/**
 * History import (phase 1): the scope's change history as dated events, read only through nexus.
 *
 * - `sys_update_version` is the source when it has rows for a record: one row per save, timed by its
 *   `sys_created_on`. It is read by `application` first; when the instance has no such rows (or the field), by
 *   every update name the scope uses.
 * - Update names with no version rows fall back to their `sys_update_xml` rows. A row's own `sys_updated_on` is
 *   when the row was last written, which can be a later recapture or bulk rewrite, so non-delete rows take the
 *   record's own `sys_updated_on` and `sys_updated_by` from the payload; a row written well after that save
 *   also gives a `captured` event at the row's time. Delete rows keep the row's time.
 *
 * Only metadata is kept: payloads are parsed for times, authors and names, then dropped, so no field value (a
 * password2, a script, a property value) is stored. Credential classes are skipped entirely, and payloads are
 * never requested for `sys_properties` (they hold the values) or for classes with password fields.
 *
 * The import has a time budget: when it runs out, it stops with a warning and returns what it read.
 */
import { NexusDeadlineError, NexusToolError, type NexusClient, type SnRecord } from './nexus.js';
import { WITHHELD_CLASS, type InventoryRow, type ScopeInfo } from './mirror.js';

/** How an event was attributed: `history` (no agent match), `log` (a SkyForge log line names it), `likely`. */
export type HistoryConfidence = 'history' | 'log' | 'likely';

/** A tool call from the SkyForge log that an event was matched to (see skyforge-log.ts). */
export interface LogRef { line: number; at: number; tool: string; ms?: number }

export interface HistoryEvent {
  /** Epoch ms of the save, from the version row (or the payload's `sys_updated_on`). */
  at: number;
  /** `captured`: the record was written into its update set again (a recapture), not saved. */
  kind: 'created' | 'modified' | 'deleted' | 'captured';
  table: string;
  /** The record's sys_id, when the row or its payload names it. */
  sysId?: string;
  /** The update name (`<table>_<sys_id>`, or `sys_dictionary_<table>_<element>` and the like). */
  update: string;
  /** Display name: the row's target_name or record_name. */
  name: string;
  /** Lowercased names the record goes by (name, id, title, label, ...), for matching log lines. */
  keys: string[];
  /** The table a dictionary entry, business rule or the like belongs to, when known. */
  collection?: string;
  author: string;
  source: 'version' | 'update_xml';
  confidence: HistoryConfidence;
  /** The matched call (`log`), or every candidate (`likely`). */
  log?: LogRef[];
  /** Why a `likely` match is no stronger, when that is not plain from its candidates (`author not checked`). */
  reason?: string;
}

export interface HistoryResult {
  events: HistoryEvent[];
  /** Rows read from each source (after skipping credential classes). */
  versions: number;
  updateXml: number;
  /** Events from each source (recaptures not counted), and recaptures. */
  versionEvents: number;
  xmlEvents: number;
  captured: number;
  /** Records (update names) whose history came from each source. */
  fromVersions: number;
  fromUpdateXml: number;
  /** How versions were found: by `application`, by update name, or not at all. */
  versionsBy: 'application' | 'name' | null;
  queries: number;
  /** The time budget ran out: the result holds only what was read before. */
  partial: boolean;
  /** Sources that could not be read (the import goes on without them). */
  warnings: string[];
}

export interface HistoryOptions {
  /** Rows per page for metadata queries (no payloads). */
  pageSize?: number;
  /** Rows per page when reading payloads, which can be large (widget templates and scripts). */
  payloadPageSize?: number;
  /** Ids or update names per `IN` query. */
  chunk?: number;
  /** Full records from the pull, by sys_id: they name dictionary entries' update names. */
  full?: Map<string, SnRecord>;
  /** The scope's update_xml rows, when the caller already read them (readChangeRows): saves a query. */
  updateXml?: SnRecord[];
  /** Time budget in ms (default DEFAULT_HISTORY_BUDGET_MS). */
  budgetMs?: number;
  /** Clock for the budget (tests). */
  now?: () => number;
}

/** The import's share of the 120 s first-run budget. */
export const DEFAULT_HISTORY_BUDGET_MS = 90_000;
/** A row written this long after its payload's save is a recapture. */
export const CAPTURE_GAP_MS = 5 * 60_000;

/** ServiceNow's `YYYY-MM-DD HH:MM:SS` (UTC through the API) as epoch ms; NaN when it is not one. */
export function snTime(s: string | undefined): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s ?? '');
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);

/** Payload fields kept for timing and matching. Everything else in a payload is ignored. */
const NAME_FIELDS = ['name', 'id', 'title', 'url_suffix', 'column_label', 'element', 'api_name', 'label', 'sys_name'];
const KEEP_FIELDS = new Set([...NAME_FIELDS, 'sys_id', 'sys_updated_on', 'sys_updated_by', 'sys_created_on', 'collection']);

export interface PayloadInfo { table?: string; fields: Record<string, string> }

/**
 * The few fields of a `<record_update>` payload that history needs (ids, times, author, names). Only direct
 * children of the record element (the first `<table action="...">`) are read, after CDATA is removed, so text
 * inside a script or template (`<label>`, `<id>`) and sibling records (`<sys_documentation>`) are never taken
 * for the record's own fields.
 */
export function parsePayload(xml: string): PayloadInfo {
  const text = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const table = /<record_update\b[^>]*\btable="([^"]+)"/.exec(text)?.[1];
  const fields: Record<string, string> = {};
  const open = /<([a-z_][a-z0-9_]*)\b[^>]*\baction="[^"]*"[^>]*>/i.exec(text);
  if (!open || open[0].endsWith('/>')) return { table, fields };
  const tags = /<(\/?)([a-z_][a-z0-9_]*)\b[^>]*?(\/?)>/gi;
  tags.lastIndex = open.index + open[0].length;
  let depth = 0;
  let child: { name: string; start: number; nested: boolean } | null = null;
  for (let m = tags.exec(text); m; m = tags.exec(text)) {
    const [all, close, name, empty] = m;
    if (close) {
      if (depth === 0) break; // the record element ends
      depth--;
      if (depth === 0 && child && child.name === name) {
        if (!child.nested && KEEP_FIELDS.has(name) && !(name in fields)) fields[name] = unxml(text.slice(child.start, m.index));
        child = null;
      }
    } else if (!empty) {
      if (depth === 0) child = { name, start: m.index + all.length, nested: false };
      else if (child) child.nested = true;
      depth++;
    }
  }
  return { table, fields };
}

/** Lowercased, de-duplicated, non-empty names. */
function keysOf(values: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const s = v?.trim().toLowerCase();
    if (s) out.add(s);
  }
  return [...out];
}

/** The table an update name belongs to, from the inventory or the row's payload. */
const tableOfUpdate = (update: string, byUpdate: Map<string, InventoryRow>, payloadTable?: string): string | undefined =>
  byUpdate.get(update)?.sys_class_name ?? payloadTable ?? /^(.+)_[0-9a-f]{32}$/.exec(update)?.[1];

/** Never read anything from a credential class, and never a property's value. */
const withheld = (table: string | undefined, update: string): boolean =>
  (table !== undefined && WITHHELD_CLASS.test(table)) || /^(sys_auth_profile|oauth_entity|discovery_credentials)/.test(update);
const isProperty = (table: string | undefined, update: string): boolean => table === 'sys_properties' || update.startsWith('sys_properties_');
/** Classes with password (password2) fields: their payloads are never requested. */
const PASSWORD_CLASS = /^(sys_email_account|sys_data_source|ldap_server_config|sys_rest_message(_fn)?|sys_soap_message(_function)?|http_connection|jdbc_connection|sys_connection|sys_user|sys_certificate|ecc_agent|cmdb_ci_mid_server|sys_alias|sys_hub_connection.*|sn_cc_.*credential.*)$/;
const noPayload = (table: string | undefined, update: string): boolean =>
  isProperty(table, update) || (table !== undefined && PASSWORD_CLASS.test(table)) || PASSWORD_CLASS.test(/^(.+)_[0-9a-f]{32}$/.exec(update)?.[1] ?? '');

const XML_FIELDS = ['sys_id', 'name', 'type', 'target_name', 'action', 'sys_created_by', 'sys_updated_by', 'sys_updated_on'];
const VERSION_FIELDS = ['sys_id', 'name', 'type', 'record_name', 'action', 'sys_created_by', 'sys_created_on', 'state'];

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

class BudgetSpent extends Error {}

/**
 * Reads the scope's history. `inventory` is the pull's `sys_metadata` inventory; it names every record, so a
 * record's versions are found by its update name `<class>_<sys_id>` as well as by the names its update_xml rows
 * use (a dictionary entry's is `sys_dictionary_<table>_<element>`).
 */
export async function importHistory(client: NexusClient, scope: ScopeInfo, inventory: InventoryRow[], opts: HistoryOptions = {}): Promise<HistoryResult> {
  const pageSize = opts.pageSize ?? 1000;
  const chunk = opts.chunk ?? 80;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? DEFAULT_HISTORY_BUDGET_MS);
  let queries = 0;
  let partial = false;
  const warnings: string[] = [];
  const q = async (table: string, query: string, fields: string[], size = pageSize, max?: number): Promise<SnRecord[]> => {
    if (now() > deadline) throw new BudgetSpent();
    queries++;
    // The deadline is checked between pages too, and caps each page's wait.
    return client.query(table, { query, fields, pageSize: size, orderBy: 'sys_id', deadline: { at: deadline, now }, ...(max === undefined ? {} : { max }) });
  };
  /** A source the instance refuses (an ACL, a missing table) is skipped with a warning, not fatal. */
  const tolerant = async (what: string, read: () => Promise<void>): Promise<void> => {
    try { await read(); } catch (e) {
      if (e instanceof BudgetSpent || e instanceof NexusDeadlineError) {
        if (!partial) warnings.push(`stopped after ${Math.round((opts.budgetMs ?? DEFAULT_HISTORY_BUDGET_MS) / 1000)} s while reading ${what}; the history is partial`);
        partial = true;
        return;
      }
      if (!(e instanceof NexusToolError)) throw e;
      warnings.push(`${what}: ${e.message}`);
    }
  };

  const byUpdate = new Map<string, InventoryRow>();
  for (const r of inventory) byUpdate.set(`${r.sys_class_name}_${r.sys_id}`, r);
  // Dictionary entries' update names are `sys_dictionary_<table>_<element>`; the pulled records name them.
  const alias = new Map<string, string>();
  for (const [id, r] of opts.full ?? []) {
    if (r.sys_class_name === 'sys_dictionary' && r.name && r.element) alias.set(`sys_dictionary_${r.name}_${r.element}`, id);
  }

  // 1. Versions by application. A query on a field the table lacks would match every row, so one row is read
  //    first, and the source is used only when it carries the scope.
  const versions: SnRecord[] = [];
  let versionsBy: HistoryResult['versionsBy'] = null;
  await tolerant('sys_update_version', async () => {
    const probe = await q('sys_update_version', `application=${scope.sys_id}`, [...VERSION_FIELDS, 'application'], 1, 1);
    if (probe.length && probe[0].application === scope.sys_id) {
      // Set first, so a budget stop mid-read still says where the partial versions came from.
      versionsBy = 'application';
      for (const r of await q('sys_update_version', `application=${scope.sys_id}`, [...VERSION_FIELDS, 'application'])) {
        if (r.application === scope.sys_id && !withheld(tableOfUpdate(r.name, byUpdate), r.name)) versions.push(r);
      }
    }
  });

  // 2. Every update_xml row of the scope, without payloads.
  let xml: SnRecord[] = [];
  await tolerant('sys_update_xml', async () => {
    const rows = opts.updateXml ?? await q('sys_update_xml', `application=${scope.sys_id}`, XML_FIELDS);
    xml = rows.filter(r => !withheld(tableOfUpdate(r.name, byUpdate), r.name));
  });

  // 3. Versions by update name: every name the scope uses when none came by application, else only the
  //    update_xml names the application read missed (versions written before the record joined the scope).
  if (!partial) {
    const names = new Set<string>(xml.map(r => r.name));
    if (versionsBy) for (const v of versions) names.delete(v.name);
    else for (const [u, r] of byUpdate) if (!WITHHELD_CLASS.test(r.sys_class_name)) names.add(u);
    const before = versions.length;
    await tolerant('sys_update_version', async () => {
      for (const part of chunks([...names].sort(), chunk)) {
        for (const r of await q('sys_update_version', `nameIN${part.join(',')}`, VERSION_FIELDS)) {
          if (!withheld(tableOfUpdate(r.name, byUpdate), r.name)) versions.push(r);
        }
        if (versions.length && !versionsBy) versionsBy = 'name';
      }
    });
    if (versionsBy === 'application' && versions.length > before) {
      warnings.push(`${versions.length - before} version rows carry no application and were found by update name`);
    }
  }
  const versionNames = new Set(versions.map(v => v.name));

  // 4. Payloads, only for update names with no versions, and never for properties or password classes.
  const payloads = new Map<string, PayloadInfo>();
  const wanted = xml.filter(r => !versionNames.has(r.name) && !noPayload(tableOfUpdate(r.name, byUpdate), r.name)).map(r => r.sys_id);
  await tolerant('sys_update_xml payloads', async () => {
    for (const ids of chunks(wanted, chunk)) {
      for (const r of await q('sys_update_xml', `sys_idIN${ids.join(',')}`, ['sys_id', 'payload'], opts.payloadPageSize ?? 50)) {
        payloads.set(r.sys_id, parsePayload(r.payload ?? ''));
      }
    }
  });
  const wantedSet = new Set(wanted);

  // An update name's record: the inventory (`<class>_<sys_id>`), a pulled dictionary entry, or a payload's sys_id.
  const sysIdOf = new Map<string, string>(alias);
  const facts = new Map<string, PayloadInfo>();
  for (const r of xml) {
    const p = payloads.get(r.sys_id);
    if (!p) continue;
    if (p.fields.sys_id && !sysIdOf.has(r.name)) sysIdOf.set(r.name, p.fields.sys_id);
    facts.set(r.name, { table: p.table ?? facts.get(r.name)?.table, fields: { ...facts.get(r.name)?.fields, ...p.fields } });
  }
  const inventoryById = new Map(inventory.map(r => [r.sys_id, r]));
  const recordOf = (update: string): InventoryRow | undefined => {
    const direct = byUpdate.get(update);
    if (direct) return direct;
    const id = sysIdOf.get(update);
    return id ? inventoryById.get(id) : undefined;
  };

  const base = (update: string, display: string, payload?: PayloadInfo): Omit<HistoryEvent, 'at' | 'kind' | 'author' | 'source'> => {
    const rec = recordOf(update);
    const full = rec ? opts.full?.get(rec.sys_id) : undefined;
    const f = { ...facts.get(update)?.fields, ...payload?.fields };
    const table = rec?.sys_class_name ?? payload?.table ?? facts.get(update)?.table ?? tableOfUpdate(update, byUpdate) ?? 'unknown';
    const dictionary = table === 'sys_dictionary';
    // A dictionary entry's `name` is its table; its own names are the label and element.
    const collection = dictionary ? f.name ?? full?.name : f.collection ?? full?.collection;
    const label = display.includes('.') && dictionary ? display.slice(display.lastIndexOf('.') + 1) : display;
    const names = NAME_FIELDS.filter(k => !(dictionary && k === 'name')).flatMap(k => [f[k], full?.[k]]);
    const keys = keysOf([label, rec?.sys_name, ...names]);
    const ev: Omit<HistoryEvent, 'at' | 'kind' | 'author' | 'source'> = { table, update, name: display || rec?.sys_name || update, keys, confidence: 'history' };
    const sysId = rec?.sys_id ?? f.sys_id ?? /_([0-9a-f]{32})$/.exec(update)?.[1];
    if (sysId) ev.sysId = sysId;
    if (collection) ev.collection = collection;
    return ev;
  };

  const events: HistoryEvent[] = [];
  const seen = new Set<string>();
  /** One event per update name, kind and time (and version row): recaptures can write the same save several times. */
  const add = (e: HistoryEvent, row = ''): void => {
    const key = `${e.update}|${e.kind}|${e.at}|${row}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push(e);
  };
  for (const v of versions) {
    const at = snTime(v.sys_created_on);
    if (Number.isNaN(at)) continue;
    // Each version row is its own save, even two in the same second.
    add({ ...base(v.name, v.record_name || ''), at, kind: v.action === 'DELETE' ? 'deleted' : 'modified', author: v.sys_created_by || 'unknown', source: 'version' }, v.sys_id);
  }
  const xmlNames = new Set<string>();
  let unread = 0;
  for (const r of xml) {
    if (versionNames.has(r.name)) continue;
    const p = payloads.get(r.sys_id);
    const del = r.action === 'DELETE';
    // A payload the budget left unread: its save time is unknown, and the row's own time may be a rewrite.
    if (!del && !p && wantedSet.has(r.sys_id)) { unread++; continue; }
    xmlNames.add(r.name);
    const rowAt = snTime(r.sys_updated_on);
    const saved = del ? NaN : snTime(p?.fields.sys_updated_on);
    const at = Number.isNaN(saved) ? rowAt : saved;
    if (Number.isNaN(at)) continue;
    const rowAuthor = r.sys_updated_by || r.sys_created_by || 'unknown';
    const ev = base(r.name, r.target_name || '', p);
    add({ ...ev, at, kind: del ? 'deleted' : 'modified', author: del ? rowAuthor : p?.fields.sys_updated_by || r.sys_created_by || 'unknown', source: 'update_xml' });
    if (!del && !Number.isNaN(rowAt) && rowAt - at > CAPTURE_GAP_MS) {
      add({ ...ev, keys: [...ev.keys], at: rowAt, kind: 'captured', author: rowAuthor, source: 'update_xml' });
    }
  }
  if (unread) warnings.push(`${unread} update_xml rows left out: their payloads were not read in time`);

  // The first save of a record that was created at that moment is its creation.
  events.sort((a, b) => a.at - b.at || a.update.localeCompare(b.update));
  const first = new Set<string>();
  for (const e of events) {
    if (e.kind === 'captured' || first.has(e.update)) continue;
    first.add(e.update);
    if (e.kind === 'deleted') continue;
    const rec = recordOf(e.update);
    const created = snTime(rec?.sys_created_on ?? facts.get(e.update)?.fields.sys_created_on);
    if (!Number.isNaN(created) && Math.abs(created - e.at) <= 2000) e.kind = 'created';
  }

  const saves = (source: HistoryEvent['source']) => events.filter(e => e.source === source && e.kind !== 'captured').length;
  return {
    events, versions: versions.length, updateXml: xml.length,
    versionEvents: saves('version'), xmlEvents: saves('update_xml'), captured: events.filter(e => e.kind === 'captured').length,
    fromVersions: versionNames.size, fromUpdateXml: xmlNames.size, versionsBy, queries, partial, warnings,
  };
}
