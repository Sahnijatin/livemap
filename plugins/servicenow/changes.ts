/**
 * Each record's last change, from the scope's `sys_update_xml` rows: the update set it went into (sys_id and
 * name), who made it and when. The mirror writes these into every record's files and the manifest, so the
 * inspector, filters and record attribution can use them. Read only through nexus.
 */
import type { Deadline, NexusClient, SnRecord } from './nexus.js';
import type { ChangeFacts, ScopeInfo } from './mirror.js';

/** The update_xml fields the mirror and the history import need (no payload). */
export const CHANGE_FIELDS = ['sys_id', 'name', 'type', 'target_name', 'action', 'update_set', 'sys_created_by', 'sys_updated_by', 'sys_updated_on', 'sys_mod_count'];

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

/** The record's own last save (from the record or its sys_metadata row), when known. */
export type RecordTime = (sysId: string) => { on?: string; by?: string } | undefined;

/** A record time this far past the newest update_xml row is a save made outside update sets. */
const OUTSIDE_SET_MS = 2000;
const snMs = (s: string | undefined): number => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s ?? '');
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
};

/**
 * Each record's last change, by sys_id: the update set from its latest update_xml row (by `sys_updated_on`,
 * later rows winning a tie), the user and time from the record itself when `recordTime` knows them. A row can be
 * rewritten long after the save (an update set moved or merged, a capture), so its own time is only a fallback.
 * `into` is updated in place and returned, so a poll can add new rows to what the pull found.
 */
export function changeFacts(rows: SnRecord[], recordOf: (update: string) => string | undefined, names: Map<string, string>, into: Map<string, ChangeFacts> = new Map(), recordTime?: RecordTime): Map<string, ChangeFacts> {
  const latest = new Map<string, SnRecord>();
  for (const r of rows) {
    const id = recordOf(r.name ?? '');
    if (!id || r.action === 'DELETE') continue;
    const prev = latest.get(id);
    if (!prev || (r.sys_updated_on ?? '') >= (prev.sys_updated_on ?? '')) latest.set(id, r);
  }
  for (const [id, r] of latest) {
    const prev = into.get(id);
    if (prev?.updateSet !== undefined && prev.rowOn && r.sys_updated_on && r.sys_updated_on < prev.rowOn) continue;
    const set = SYS_ID.test(r.update_set ?? '') ? r.update_set : undefined;
    const f: ChangeFacts = {};
    if (set) f.updateSet = set;
    if (set && names.get(set)) f.updateSetName = names.get(set);
    const by = r.sys_updated_by || r.sys_created_by;
    if (by) f.updatedBy = by;
    if (r.sys_updated_on) { f.updatedOn = r.sys_updated_on; f.rowOn = r.sys_updated_on; }
    into.set(id, f);
    refreshFacts(into, id, recordTime?.(id));
  }
  return into;
}

/**
 * Takes the time and user from the record's own last save. A save well after the newest update_xml row was
 * made outside update sets: it has no update set.
 */
export function refreshFacts(into: Map<string, ChangeFacts>, id: string, rec: { on?: string; by?: string } | undefined): void {
  if (!rec?.on) return;
  const f = into.get(id);
  const row = snMs(f?.rowOn);
  if (!f || (!Number.isNaN(row) && snMs(rec.on) - row > OUTSIDE_SET_MS) || f.rowOn === undefined) {
    into.set(id, { ...(rec.by ? { updatedBy: rec.by } : {}), updatedOn: rec.on });
    return;
  }
  into.set(id, { ...f, updatedOn: rec.on, ...(rec.by ? { updatedBy: rec.by } : {}) });
}
