/**
 * History import (phase 1): the scope's change history as dated events, read only through nexus.
 *
 * - `sys_update_version` is the source when it has rows for a record: one row per save, timed by its
 *   `sys_created_on`.
 * - Records with no version rows fall back to their `sys_update_xml` rows. A row's own `sys_updated_on` is when
 *   the row was last written, which can be a later bulk rewrite, so non-delete rows take the record's own
 *   `sys_updated_on` from the payload; delete rows keep the row's time.
 *
 * Only metadata is kept: payloads are parsed for times and names, then dropped, so no field value (a password2,
 * a script, a property value) is stored. Credential classes are skipped entirely, and `sys_properties` payloads
 * are never requested, since they hold the property values.
 */
import { NexusToolError, type NexusClient, type SnRecord } from './nexus.js';
import { WITHHELD_CLASS, type InventoryRow, type ScopeInfo } from './mirror.js';

/** How an event was attributed: `history` (no agent match), `log` (a SkyForge log line names it), `likely`. */
export type HistoryConfidence = 'history' | 'log' | 'likely';

/** A tool call from the SkyForge log that an event was matched to (see skyforge-log.ts). */
export interface LogRef { line: number; at: number; tool: string; ms?: number }

export interface HistoryEvent {
  /** Epoch ms of the save, from the version row (or the payload's `sys_updated_on`). */
  at: number;
  kind: 'created' | 'modified' | 'deleted';
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
}

export interface HistoryResult {
  events: HistoryEvent[];
  /** Rows read from each source (after skipping credential classes). */
  versions: number;
  updateXml: number;
  /** Records (update names) whose history came from each source. */
  fromVersions: number;
  fromUpdateXml: number;
  queries: number;
  /** Sources that could not be read (the import goes on without them). */
  warnings: string[];
}

export interface HistoryOptions {
  pageSize?: number;
  /** Rows per page when reading payloads, which can be large (widget templates and scripts). */
  payloadPageSize?: number;
  /** Ids or update names per `IN` query. */
  chunk?: number;
}

/** ServiceNow's `YYYY-MM-DD HH:MM:SS` (UTC through the API) as epoch ms; NaN when it is not one. */
export function snTime(s: string | undefined): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s ?? '');
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e]);

/** Payload fields kept for timing and matching. Everything else in a payload is ignored. */
const NAME_FIELDS = ['name', 'id', 'title', 'url_suffix', 'column_label', 'element', 'api_name', 'label', 'sys_name'];
const KEEP_FIELDS = new Set([...NAME_FIELDS, 'sys_id', 'sys_updated_on', 'sys_created_on', 'collection']);

export interface PayloadInfo { table?: string; fields: Record<string, string> }

/**
 * The few top-level fields of a `<record_update>` payload that history needs (ids, times, names). Field
 * values outside KEEP_FIELDS are never read into memory as strings of their own.
 */
export function parsePayload(xml: string): PayloadInfo {
  const table = /<record_update\b[^>]*\btable="([^"]+)"/.exec(xml)?.[1];
  const fields: Record<string, string> = {};
  for (const m of xml.matchAll(/<([a-z_][a-z0-9_]*)\b[^>/]*>([^<]*)<\/\1>/g)) {
    if (KEEP_FIELDS.has(m[1]) && !(m[1] in fields)) fields[m[1]] = unxml(m[2]);
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

const XML_FIELDS = ['sys_id', 'name', 'type', 'target_name', 'action', 'sys_created_by', 'sys_updated_on'];
const VERSION_FIELDS = ['sys_id', 'name', 'type', 'record_name', 'action', 'sys_created_by', 'sys_created_on', 'state'];

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Reads the scope's history. `inventory` is the pull's `sys_metadata` inventory; it names every record, so a
 * record's versions are found by its update name `<class>_<sys_id>` as well as by the names its update_xml rows
 * use (a dictionary entry's is `sys_dictionary_<table>_<element>`).
 */
export async function importHistory(client: NexusClient, scope: ScopeInfo, inventory: InventoryRow[], opts: HistoryOptions = {}): Promise<HistoryResult> {
  const pageSize = opts.pageSize ?? 200;
  const chunk = opts.chunk ?? 80;
  let queries = 0;
  const warnings: string[] = [];
  const q = async (table: string, query: string, fields: string[], size = pageSize): Promise<SnRecord[]> => {
    queries++;
    return client.query(table, { query, fields, pageSize: size, orderBy: 'sys_id' });
  };
  /** A source the instance refuses (an ACL, a missing table) is skipped with a warning, not fatal. */
  const tolerant = async (what: string, read: () => Promise<void>): Promise<void> => {
    try { await read(); } catch (e) {
      if (!(e instanceof NexusToolError)) throw e;
      warnings.push(`${what}: ${e.message}`);
    }
  };

  const byUpdate = new Map<string, InventoryRow>();
  for (const r of inventory) byUpdate.set(`${r.sys_class_name}_${r.sys_id}`, r);

  // 1. Every update_xml row of the scope, without payloads.
  let xml: SnRecord[] = [];
  await tolerant('sys_update_xml', async () => {
    xml = (await q('sys_update_xml', `application=${scope.sys_id}`, XML_FIELDS)).filter(r => !withheld(tableOfUpdate(r.name, byUpdate), r.name));
  });

  // 2. Payloads, only for times and names, and never for system properties.
  const payloads = new Map<string, PayloadInfo>();
  const wanted = xml.filter(r => !isProperty(tableOfUpdate(r.name, byUpdate), r.name)).map(r => r.sys_id);
  await tolerant('sys_update_xml payloads', async () => {
    for (const ids of chunks(wanted, chunk)) {
      for (const r of await q('sys_update_xml', `sys_idIN${ids.join(',')}`, ['sys_id', 'payload'], opts.payloadPageSize ?? 50)) {
        payloads.set(r.sys_id, parsePayload(r.payload ?? ''));
      }
    }
  });

  // 3. Versions, by every update name the scope uses.
  const names = new Set<string>(xml.map(r => r.name));
  for (const [u, r] of byUpdate) if (!WITHHELD_CLASS.test(r.sys_class_name)) names.add(u);
  const versions: SnRecord[] = [];
  await tolerant('sys_update_version', async () => {
    for (const part of chunks([...names].sort(), chunk)) {
      for (const r of await q('sys_update_version', `nameIN${part.join(',')}`, VERSION_FIELDS)) {
        if (!withheld(tableOfUpdate(r.name, byUpdate), r.name)) versions.push(r);
      }
    }
  });

  // An update name's record: the inventory (`<class>_<sys_id>`), else the sys_id in one of its payloads.
  const sysIdOf = new Map<string, string>();
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
    const f = { ...facts.get(update)?.fields, ...payload?.fields };
    const table = rec?.sys_class_name ?? payload?.table ?? facts.get(update)?.table ?? tableOfUpdate(update, byUpdate) ?? 'unknown';
    const dictionary = table === 'sys_dictionary';
    // A dictionary entry's `name` is its table; its own names are the label and element.
    const collection = dictionary ? f.name : f.collection;
    const label = display.includes('.') && dictionary ? display.slice(display.lastIndexOf('.') + 1) : display;
    const keys = keysOf([label, rec?.sys_name, ...NAME_FIELDS.filter(k => !(dictionary && k === 'name')).map(k => f[k])]);
    const ev: Omit<HistoryEvent, 'at' | 'kind' | 'author' | 'source'> = { table, update, name: display || rec?.sys_name || update, keys, confidence: 'history' };
    const sysId = rec?.sys_id ?? f.sys_id ?? /_([0-9a-f]{32})$/.exec(update)?.[1];
    if (sysId) ev.sysId = sysId;
    if (collection) ev.collection = collection;
    return ev;
  };

  const events: HistoryEvent[] = [];
  const versionNames = new Set(versions.map(v => v.name));
  for (const v of versions) {
    const at = snTime(v.sys_created_on);
    if (Number.isNaN(at)) continue;
    events.push({ ...base(v.name, v.record_name || ''), at, kind: v.action === 'DELETE' ? 'deleted' : 'modified', author: v.sys_created_by || 'unknown', source: 'version' });
  }
  const xmlNames = new Set<string>();
  for (const r of xml) {
    if (versionNames.has(r.name)) continue;
    xmlNames.add(r.name);
    const p = payloads.get(r.sys_id);
    const del = r.action === 'DELETE';
    const at = del ? snTime(r.sys_updated_on) : snTime(p?.fields.sys_updated_on) || snTime(r.sys_updated_on);
    if (Number.isNaN(at)) continue;
    events.push({ ...base(r.name, r.target_name || '', p), at, kind: del ? 'deleted' : 'modified', author: r.sys_created_by || 'unknown', source: 'update_xml' });
  }

  // The first save of a record that was created at that moment is its creation.
  events.sort((a, b) => a.at - b.at || a.update.localeCompare(b.update));
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.update)) continue;
    seen.add(e.update);
    if (e.kind === 'deleted') continue;
    const rec = recordOf(e.update);
    const created = snTime(rec?.sys_created_on ?? facts.get(e.update)?.fields.sys_created_on);
    if (!Number.isNaN(created) && Math.abs(created - e.at) <= 2000) e.kind = 'created';
  }

  return { events, versions: versions.length, updateXml: xml.length, fromVersions: versionNames.size, fromUpdateXml: xmlNames.size, queries, warnings };
}
