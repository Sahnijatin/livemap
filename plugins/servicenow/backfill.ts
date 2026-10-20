/**
 * The initial pull of a scope (phase 1): resolve the scope, read its `sys_metadata` inventory, then fetch
 * full records for every class in pages of 200. Credential classes are never fetched (they are mirrored by
 * name), and system properties are read without their values. A class whose query fails keeps its
 * inventory fields only, marked partial, and the pull goes on.
 */
import { NexusToolError, type Deadline, type NexusClient, type SnRecord } from './nexus.js';
import { WITHHELD_CLASS, type InventoryRow, type ScopeInfo } from './mirror.js';

/** The fields read of a system property: never its value, which can be a key or token stored as plain text. */
export const PROPERTY_FIELDS = ['sys_id', 'sys_class_name', 'sys_name', 'name', 'type', 'is_private', 'description', 'sys_scope', 'sys_updated_on', 'sys_updated_by'];
export const INVENTORY_FIELDS = ['sys_id', 'sys_class_name', 'sys_name', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by'];
const SYS_ID = /^[0-9a-f]{32}$/i;

export class ScopeNotFoundError extends Error {
  constructor(arg: string) { super(`No application scope matches "${arg}". Give its namespace (x_...) or the sys_id of its sys_scope record.`); }
}

/** The scope named by a namespace (`x_snc_cc_offering`) or a `sys_scope` sys_id. */
export async function resolveScope(client: NexusClient, arg: string): Promise<ScopeInfo> {
  const query = SYS_ID.test(arg) ? `sys_id=${arg}` : `scope=${arg}`;
  const [r] = await client.query('sys_scope', { query, fields: ['sys_id', 'scope', 'name', 'version'], max: 1 });
  if (!r) throw new ScopeNotFoundError(arg);
  return { sys_id: r.sys_id, scope: r.scope, name: r.name, ...(r.version ? { version: r.version } : {}) };
}

export interface InstanceInfo { name: string; release?: string; patch?: string }

/** What `sn_get_instance_info` says about the instance; null when nexus cannot say. */
export async function instanceInfo(client: NexusClient): Promise<InstanceInfo | null> {
  try {
    const body = await client.execute('sn_get_instance_info') as { data?: Record<string, unknown> } | null;
    const d = (body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const name = s(d.instance_name) ?? s(d.name) ?? s(d.instance);
    return name ? { name, release: s(d.release) ?? s(d.build_name), patch: s(d.patch) } : null;
  } catch (e) {
    if (e instanceof NexusToolError) return null;
    throw e;
  }
}

export interface PullProgress { classesDone: number; classes: number; records: number }
export interface PullOptions {
  pageSize?: number;
  /** Classes fetched at once (default 4). */
  concurrency?: number;
  onProgress?: (p: PullProgress) => void;
}
export interface PullResult {
  inventory: InventoryRow[];
  full: Map<string, SnRecord>;
  /** Classes whose query failed: their records are inventory only. */
  failedClasses: { class: string; error: string }[];
  queries: number;
}

/** Inventory first, then full records for every class. */
export async function pullScope(client: NexusClient, scope: ScopeInfo, opts: PullOptions = {}): Promise<PullResult> {
  const pageSize = opts.pageSize ?? 200;
  let queries = 0;
  const count = async <T>(p: Promise<T>): Promise<T> => { queries++; return p; };
  const inventory = (await count(client.query('sys_metadata', { query: `sys_scope=${scope.sys_id}`, fields: INVENTORY_FIELDS, pageSize: 1000, orderBy: 'sys_id' }))) as unknown as InventoryRow[];
  const ids = new Set(inventory.map(r => r.sys_id));
  const classes = [...new Set(inventory.map(r => r.sys_class_name))].sort();
  const full = new Map<string, SnRecord>();
  const failedClasses: PullResult['failedClasses'] = [];
  let done = 0;
  const fetchClass = async (cls: string): Promise<void> => {
    if (WITHHELD_CLASS.test(cls)) return;
    const query = `sys_scope=${scope.sys_id}^sys_class_name=${cls}`;
    try {
      let recs: SnRecord[];
      if (cls === 'sys_properties') {
        // Name, type and description only: a value can be a key or token stored as a plain string.
        recs = await count(client.query(cls, { query, fields: PROPERTY_FIELDS, pageSize }));
      } else {
        recs = await count(client.query(cls, { query, pageSize }));
      }
      for (const r of recs) if (ids.has(r.sys_id)) full.set(r.sys_id, r);
    } catch (e) {
      if (!(e instanceof NexusToolError)) throw e;
      failedClasses.push({ class: cls, error: e.message });
    } finally {
      done++;
      opts.onProgress?.({ classesDone: done, classes: classes.length, records: full.size });
    }
  };
  // A few classes at a time: nexus answers one query per call, and the instance is shared.
  const queue = [...classes];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    while (queue.length) await fetchClass(queue.shift()!);
  });
  await Promise.all(workers);
  failedClasses.sort((a, b) => (a.class < b.class ? -1 : 1));
  return { inventory, full, failedClasses, queries };
}

/**
 * The ServiceNow user nexus works as, from `sn_session_context` (lowercased); null when it cannot say. Any
 * failure reads as unknown: history attribution then marks table and time matches `author not checked`.
 */
export async function sessionUser(client: NexusClient, deadline?: Deadline): Promise<string | null> {
  try {
    const body = await client.execute('sn_session_context', {}, deadline) as Record<string, unknown> | null;
    const d = (body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : body ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : undefined);
    const u = d.user && typeof d.user === 'object' ? d.user as Record<string, unknown> : {};
    return s(d.user_name) ?? s(d.username) ?? s(d.userName) ?? s(u.user_name) ?? s(u.name) ?? s(d.user) ?? null;
  } catch {
    return null;
  }
}
