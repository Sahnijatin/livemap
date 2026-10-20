/**
 * Each record's last change, from the scope's `sys_update_xml` rows: the update set it went into (sys_id and
 * name), who made it and when. The mirror writes these into every record's files and the manifest, so the
 * inspector, filters and record attribution can use them. Read only through nexus.
 */
import type { Deadline, NexusClient, SnRecord } from './nexus.js';
import type { ChangeFacts, ScopeInfo } from './mirror.js';

/** The update_xml fields the mirror and the history import need (no payload). */
export const CHANGE_FIELDS = ['sys_id', 'name', 'type', 'target_name', 'action', 'update_set', 'sys_created_by', 'sys_updated_by', 'sys_updated_on'];

const SYS_ID = /^[0-9a-f]{32}$/;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Every update_xml row of the scope, without payloads. */
export async function readChangeRows(client: NexusClient, scope: ScopeInfo, opts: { query?: string; deadline?: Deadline } = {}): Promise<SnRecord[]> {
  const query = `application=${scope.sys_id}${opts.query ? `^${opts.query}` : ''}`;
  return client.query('sys_update_xml', { query, fields: CHANGE_FIELDS, pageSize: 1000, orderBy: 'sys_updated_on', ...(opts.deadline ? { deadline: opts.deadline } : {}) });
}

/** Names of the update sets these rows went into, added to `known` (sys_id to name). */
export async function updateSetNames(client: NexusClient, rows: SnRecord[], known: Map<string, string> = new Map()): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(r => r.update_set).filter(id => SYS_ID.test(id ?? '') && !known.has(id)))];
  for (const part of chunks(ids, 80)) {
    for (const r of await client.query('sys_update_set', { query: `sys_idIN${part.join(',')}`, fields: ['sys_id', 'name'], pageSize: 100 })) {
      if (r.sys_id && r.name) known.set(r.sys_id, r.name);
    }
  }
  return known;
}

/**
 * The record an update name belongs to: `<class>_<sys_id>`, or a dictionary entry's
 * `sys_dictionary_<table>_<element>` through the pulled records.
 */
export function updateNameIndex(full: Map<string, SnRecord>): (update: string) => string | undefined {
  const alias = new Map<string, string>();
  for (const [id, r] of full) if (r.sys_class_name === 'sys_dictionary' && r.name && r.element) alias.set(`sys_dictionary_${r.name}_${r.element}`, id);
  return update => /_([0-9a-f]{32})$/.exec(update)?.[1] ?? alias.get(update);
}

/**
 * Each record's last change, by sys_id, from its latest update_xml row (by `sys_updated_on`, later rows winning
 * a tie). `into` is updated in place and returned, so a poll can add new rows to what the pull found.
 */
export function changeFacts(rows: SnRecord[], recordOf: (update: string) => string | undefined, names: Map<string, string>, into: Map<string, ChangeFacts> = new Map()): Map<string, ChangeFacts> {
  const sorted = [...rows].sort((a, b) => (a.sys_updated_on ?? '').localeCompare(b.sys_updated_on ?? ''));
  for (const r of sorted) {
    const id = recordOf(r.name ?? '');
    if (!id || r.action === 'DELETE') continue;
    const prev = into.get(id);
    if (prev?.updatedOn && r.sys_updated_on && r.sys_updated_on < prev.updatedOn) continue;
    const set = SYS_ID.test(r.update_set ?? '') ? r.update_set : undefined;
    const f: ChangeFacts = {};
    if (set) f.updateSet = set;
    if (set && names.get(set)) f.updateSetName = names.get(set);
    const by = r.sys_updated_by || r.sys_created_by;
    if (by) f.updatedBy = by;
    if (r.sys_updated_on) f.updatedOn = r.sys_updated_on;
    into.set(id, f);
  }
  return into;
}
