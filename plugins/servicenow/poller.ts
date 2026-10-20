/**
 * Live changes (phase 2): polls the instance through nexus, read-only, and keeps the mirror current.
 *
 * - Two cursors, on instance time: `sys_update_xml` by `application` (every tracked change, with its update set
 *   and user) and `sys_metadata` by `sys_scope` (changes made outside update sets). An idle poll is those two
 *   queries. Changed records are then read in full by class and `sys_id`, and the mirror is laid out again;
 *   only files that changed are written, so the watcher reports just those.
 * - Deletes: update_xml rows with `action=DELETE`, and `sys_metadata_delete` every few polls.
 * - Each poll reads from a minute before its cursors (a row can commit after a later one, or come from a node
 *   whose clock runs behind), and skips rows it already applied, known by sys_id, time and mod count (an
 *   update_xml row is rewritten in place when its record is saved again). Cursors and those keys live in
 *   `.livemap/sn/<scope>.state.json`.
 * - Only records sys_metadata names in the scope, or already in the inventory, are read in full. A table the
 *   instance refuses is warned about once and skipped; the poll goes on.
 * - Clock skew: each exact record match gives a gap (instance time minus call time); the median of the last
 *   few sets the attribution's skew margin (never below the 5 s default), and is kept in the state file.
 * - Offline: when nexus does not answer, the mirror stays as it was, the status says offline, and polls back
 *   off up to a minute. The next answer catches up from the cursors.
 */
import type { SourceStatus } from '../../src/shared/protocol.js';
import { PROPERTY_FIELDS, INVENTORY_FIELDS } from './backfill.js';
import { CHANGE_FIELDS, changeFacts, refreshFacts, updateNameIndex, updateSetNames } from './changes.js';
import { snTime } from './history.js';
import { layoutMirror, WITHHELD_CLASS, type ChangeFacts, type InventoryRow, type Manifest, type ScopeInfo } from './mirror.js';
import { NexusOfflineError, NexusToolError, type NexusClient, type SnRecord } from './nexus.js';
import { readManifest, writeMirror, writePollState, type PollState, type WriteResult } from './writer.js';

export const DEFAULT_POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
/** Deleted records are read every this many polls (they are rare, and an idle poll should stay at two queries). */
const DELETES_EVERY = 6;
const SKEW_SAMPLES = 21;
/**
 * Each poll reads again from this long before its cursor: a row can commit after a later one (a slow
 * transaction), or come from a node whose clock runs behind. Rows already applied are known by their key.
 */
export const DEFAULT_OVERLAP_MS = 60_000;
/** The learned skew never goes below the attribution's default margin. */
const MIN_SKEW_MS = 5000;
/** Margin added to the measured skew. */
const SKEW_MARGIN_MS = 2000;
const MAX_SKEW_MS = 10 * 60_000;

/** What the pull left: the scope's records, their last changes and the update set names seen so far. */
export interface PollContext {
  instance: string;
  scope: ScopeInfo;
  inventory: InventoryRow[];
  full: Map<string, SnRecord>;
  facts: Map<string, ChangeFacts>;
  setNames: Map<string, string>;
  pulledAt?: string;
}

export interface PollerOptions {
  intervalMs?: number;
  /** Absolute mirror root (`.livemap/sn`). */
  root: string;
  onStatus?: (s: SourceStatus) => void;
  onSkew?: (ms: number) => void;
  onApplied?: (r: PollResult) => void;
  /** The poll's new update_xml rows, after the mirror is written (the history file adds them as saves). */
  onSaves?: (rows: SnRecord[], ctx: PollContext, manifest: Manifest) => Promise<unknown> | void;
  warn?: (message: string) => void;
  now?: () => number;
  /** How far before each cursor a poll reads again (default DEFAULT_OVERLAP_MS). */
  overlapMs?: number;
  /** The first poll's queries and how many rows each returned, for checking the cursors on a live instance. */
  onFirstPoll?: (lines: string[]) => void;
}

export interface PollResult { changed: string[]; deleted: string[]; queries: number; written: WriteResult | null }

const SYS_ID = /^[0-9a-f]{32}$/;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const maxTime = (times: (string | undefined)[]): string | undefined => times.reduce<string | undefined>((m, t) => (t && (!m || t > m) ? t : m), undefined);

/** ServiceNow's `YYYY-MM-DD HH:MM:SS` (UTC) for an epoch ms. */
const snStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
/** A row's identity at one save: an update_xml row is rewritten in place when its record is saved again. */
const rowKey = (r: SnRecord): string => `${r.sys_id}|${r.sys_updated_on ?? ''}|${r.sys_mod_count ?? ''}`;
const keyTime = (key: string): number => snTime(key.split('|')[1]);

/** Cursors for a first run: the latest time the pull saw, in each source, and every row it saw near it. */
export function initialState(scope: string, updateXml: SnRecord[], inventory: InventoryRow[], overlapMs = DEFAULT_OVERLAP_MS, full?: Map<string, SnRecord>): PollState {
  const xml = maxTime(updateXml.map(r => r.sys_updated_on));
  const meta = maxTime(inventory.map(r => r.sys_updated_on));
  const all = maxTime([xml, meta]);
  const near = (rows: SnRecord[], cursor: string | undefined) =>
    cursor ? rows.filter(r => snTime(r.sys_updated_on) >= snTime(cursor) - overlapMs).map(rowKey) : [];
  return {
    version: 1, scope,
    cursors: { ...(xml ? { updateXml: xml } : {}), ...(meta ? { metadata: meta } : {}), ...(all ? { deleted: all } : {}) },
    // Inventory rows carry no mod count; the pulled record (the same row, by its own class) does.
    seen: {
      updateXml: near(updateXml, xml),
      metadata: near(inventory.map(r => ({ ...r, sys_mod_count: full?.get(r.sys_id)?.sys_mod_count ?? '' })) as unknown as SnRecord[], meta),
      deleted: [],
    },
  };
}

type Source = keyof PollState['cursors'];

export class ScopePoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private polls = 0;
  private failures = 0;
  private status: SourceStatus['state'] | null = null;
  private deletesOff = false;
  /** Tables the instance refused to read; warned about once. */
  private readonly unreadable = new Set<string>();
  private readonly gaps: number[] = [];
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly client: NexusClient, private readonly ctx: PollContext, private state: PollState, private readonly opts: PollerOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
    this.now = opts.now ?? Date.now;
    if (state.skewMs !== undefined) opts.onSkew?.(state.skewMs);
  }

  start(): void {
    this.stopped = false;
    this.schedule(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get skewMs(): number | undefined { return this.state.skewMs; }
  get cursors(): PollState['cursors'] { return { ...this.state.cursors }; }

  /** One exact record match's gap (instance time minus call time): the median of recent gaps sets the skew. */
  learnGap(gapMs: number): void {
    if (!Number.isFinite(gapMs)) return;
    this.gaps.push(gapMs);
    if (this.gaps.length > SKEW_SAMPLES) this.gaps.shift();
    if (this.gaps.length < 3) return;
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const skew = Math.min(MAX_SKEW_MS, Math.max(MIN_SKEW_MS, Math.abs(median) + SKEW_MARGIN_MS));
    if (skew === this.state.skewMs) return;
    this.state = { ...this.state, skewMs: skew };
    writePollState(this.opts.root, this.state);
    this.opts.onSkew?.(skew);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.run(); }, ms);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    try {
      const r = await this.tick();
      this.failures = 0;
      this.setStatus('online');
      if (r.changed.length || r.deleted.length) this.opts.onApplied?.(r);
      this.schedule(this.intervalMs);
    } catch (e) {
      this.failures++;
      if (e instanceof NexusOfflineError) this.setStatus('offline', e.message);
      else this.opts.warn?.(`poll failed: ${(e as Error)?.message ?? String(e)}`);
      this.schedule(Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.failures, 6)));
    }
  }

  private setStatus(state: SourceStatus['state'], detail?: string): void {
    if (this.status === state) return;
    this.status = state;
    this.opts.onStatus?.({ name: `${this.ctx.scope.scope} on ${this.ctx.instance}`, state, since: this.now(), ...(detail ? { detail } : {}) });
  }

  /**
   * The query's lower bound: the cursor minus the overlap, or nothing on a first run. Once the instance's
   * clock (this machine's, less the learned skew) is past the cursor plus the overlap, no late row can still
   * land below the cursor, so the floor moves up to it and idle polls stop reading the last minute again.
   */
  private floor(source: Source): number {
    const c = this.state.cursors[source];
    if (!c) return -Infinity;
    const at = snTime(c);
    const overlap = this.opts.overlapMs ?? DEFAULT_OVERLAP_MS;
    const instanceNow = this.now() - (this.state.skewMs ?? MIN_SKEW_MS);
    return instanceNow > at + overlap ? at : at - overlap;
  }

  /**
   * Rows not applied yet. The instance is asked for rows from the floor up; rows below it are dropped here too,
   * so a time the instance reads in another timezone cannot bring old rows back.
   */
  private fresh(source: Source, rows: SnRecord[]): SnRecord[] {
    const floor = this.floor(source);
    const seen = new Set(this.state.seen?.[source] ?? []);
    return rows.filter(r => snTime(r.sys_updated_on) >= floor && !seen.has(rowKey(r)));
  }

  /** Moves the cursor to the newest row, and keeps the keys of every row inside the new overlap window. */
  private advance(source: Source, rows: SnRecord[]): void {
    const latest = maxTime([this.state.cursors[source], ...rows.map(r => r.sys_updated_on)]);
    if (!latest) return;
    this.state = { ...this.state, cursors: { ...this.state.cursors, [source]: latest } };
    const floor = this.floor(source);
    const keys = [...new Set([...(this.state.seen?.[source] ?? []), ...rows.map(rowKey)])].filter(k => keyTime(k) >= floor);
    this.state = { ...this.state, seen: { ...this.state.seen, [source]: keys } };
  }

  /** One poll. Throws NexusOfflineError when nexus does not answer; the mirror is then left as it was. */
  async tick(): Promise<PollResult> {
    const { client, ctx } = this;
    const scopeId = ctx.scope.sys_id;
    let queries = 0;
    const log: string[] = [];
    const q = async (table: string, query: string, fields?: string[]): Promise<SnRecord[]> => {
      queries++;
      const rows = await client.query(table, { query, ...(fields ? { fields } : {}), pageSize: 200 });
      log.push(`${table}: ${query} -> ${rows.length} rows`);
      return rows;
    };
    // Ordered by time, then sys_id, so pages stay stable while rows arrive.
    const since = (source: Source) => {
      const f = this.floor(source);
      return `${Number.isFinite(f) ? `^sys_updated_on>=${snStamp(f)}` : ''}^ORDERBYsys_updated_on^ORDERBYsys_id`;
    };
    this.polls++;

    // sys_metadata first: one transaction commits a record and its update_xml row, so a save seen here has its
    // row in the read that follows. Read the other way round, a save committing in between would look like a
    // change made outside update sets.
    const meta = this.fresh('metadata', await q('sys_metadata', `sys_scope=${scopeId}${since('metadata')}`, [...INVENTORY_FIELDS, 'sys_mod_count']));
    const xml = this.fresh('updateXml', await q('sys_update_xml', `application=${scopeId}${since('updateXml')}`, CHANGE_FIELDS));
    let deletedRows: SnRecord[] = [];
    if (!this.deletesOff && this.polls % DELETES_EVERY === 1) {
      try {
        deletedRows = this.fresh('deleted', await q('sys_metadata_delete', `sys_scope=${scopeId}${since('deleted')}`, ['sys_id', 'sys_update_name', 'sys_class_name', 'sys_updated_on', 'sys_mod_count']));
      } catch (e) {
        if (!(e instanceof NexusToolError)) throw e;
        // The table is not readable here: deletes still come from update_xml rows.
        this.deletesOff = true;
        this.opts.warn?.(`sys_metadata_delete cannot be read (${e.message}); deletes come from update sets only`);
      }
    }
    if (this.polls === 1) this.opts.onFirstPoll?.(log);

    const recordOf = updateNameIndex(ctx.full);
    const inv = new Map(ctx.inventory.map(r => [r.sys_id, r]));
    // The latest save and the latest delete seen per record: whichever came last wins.
    const lastSave = new Map<string, number>();
    const lastDelete = new Map<string, number>();
    const note = (m: Map<string, number>, id: string | undefined, on: string | undefined) => {
      if (!id || !SYS_ID.test(id)) return;
      const t = snTime(on);
      m.set(id, Math.max(m.get(id) ?? -Infinity, Number.isNaN(t) ? -Infinity : t));
    };
    for (const r of xml) note(r.action === 'DELETE' ? lastDelete : lastSave, recordOf(r.name ?? ''), r.sys_updated_on);
    // A delete row is a record of its own (it is in the scope's inventory); the deleted record is the one its
    // update name names (a dictionary entry's `sys_dictionary_<table>_<element>` included).
    for (const r of deletedRows) note(lastDelete, recordOf(r.sys_update_name ?? ''), r.sys_updated_on);
    for (const r of meta) note(lastSave, r.sys_id, r.sys_updated_on);
    const deleted = new Set([...lastDelete].filter(([id, t]) => !(lastSave.get(id)! > t)).map(([id]) => id));

    // Records read in full: only those sys_metadata names in this scope, or already in the inventory. An update
    // name alone can name any table (a user, a credential record), so it never starts a read.
    const metaById = new Map(meta.map(r => [r.sys_id, r]));
    const changed = new Map<string, string>(); // sys_id -> class
    for (const [id] of lastSave) {
      if (deleted.has(id)) continue;
      const cls = metaById.get(id)?.sys_class_name ?? inv.get(id)?.sys_class_name;
      if (cls) changed.set(id, cls);
    }
    const byClass = new Map<string, string[]>();
    for (const [id, cls] of changed) byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
    for (const [cls, ids] of byClass) {
      if (WITHHELD_CLASS.test(cls)) continue; // names only; properties never carry a value
      try {
        for (const part of chunks(ids, 80)) {
          const recs = await q(cls, `sys_idIN${part.join(',')}`, cls === 'sys_properties' ? PROPERTY_FIELDS : undefined);
          for (const r of recs) if (r.sys_scope === scopeId) ctx.full.set(r.sys_id, r);
        }
      } catch (e) {
        // One table the instance will not read (an ACL, an inactive plugin) must not stall the poll: its records
        // keep their names, dates and facts, and the cursors move on.
        if (!(e instanceof NexusToolError)) throw e;
        if (!this.unreadable.has(cls)) this.opts.warn?.(`${cls} cannot be read (${e.message}); its changes show names and dates only`);
        this.unreadable.add(cls);
      }
    }
    for (const [id, cls] of changed) {
      const m = metaById.get(id);
      const f = ctx.full.get(id);
      const row: InventoryRow = { ...inv.get(id), sys_id: id, sys_class_name: cls, sys_name: m?.sys_name ?? f?.sys_name ?? inv.get(id)?.sys_name ?? f?.name ?? '' };
      for (const k of ['sys_created_on', 'sys_updated_on', 'sys_updated_by'] as const) { const v = m?.[k] ?? f?.[k]; if (v) row[k] = v; }
      inv.set(id, row);
    }
    for (const id of deleted) { inv.delete(id); ctx.full.delete(id); ctx.facts.delete(id); }

    // Each changed record's last change: the update set from its newest update_xml row, the time and user from
    // the record itself (a row can be rewritten later, when an update set is moved or merged). A change made
    // outside update sets has no row and no update set.
    if (xml.length) {
      const unnamed = new Set(xml.map(r => r.update_set).filter(id => SYS_ID.test(id ?? '') && !ctx.setNames.has(id)));
      if (unnamed.size) {
        await updateSetNames(client, xml, ctx.setNames);
        queries += Math.ceil(unnamed.size / 80);
      }
    }
    const recordTime = (id: string) => { const r = metaById.get(id) ?? inv.get(id) ?? ctx.full.get(id); return r ? { on: r.sys_updated_on, by: r.sys_updated_by } : undefined; };
    changeFacts(xml, updateNameIndex(ctx.full), ctx.setNames, ctx.facts, recordTime);
    for (const r of meta) if (!deleted.has(r.sys_id)) refreshFacts(ctx.facts, r.sys_id, recordTime(r.sys_id));

    let written: WriteResult | null = null;
    let manifest: Manifest | null = null;
    // Stopped while this poll waited on nexus: write nothing. The cursors stay, so the next run reads it again.
    if (this.stopped) return { changed: [], deleted: [], queries, written };
    if (changed.size || deleted.size) {
      ctx.inventory = [...inv.values()];
      const laid = layoutMirror({ instance: ctx.instance, scope: ctx.scope, inventory: ctx.inventory, full: ctx.full, facts: ctx.facts, rootAbs: this.opts.root, ...(ctx.pulledAt ? { pulledAt: ctx.pulledAt } : {}) });
      manifest = laid.manifest;
      written = writeMirror(this.opts.root, laid.files, laid.manifest);
    }
    if (xml.length && this.opts.onSaves) {
      // The history file is extra: a failure there never stops polling, but the saves it held are lost to it.
      try {
        const m = manifest ?? readManifest(this.opts.root, ctx.scope.scope);
        if (m) await this.opts.onSaves(xml, ctx, m);
      } catch (e) {
        this.opts.warn?.(`history: ${xml.length} new saves were dropped from the history file (${(e as Error)?.message ?? String(e)})`);
      }
    }
    this.advance('updateXml', xml);
    this.advance('metadata', meta);
    this.advance('deleted', deletedRows);
    writePollState(this.opts.root, this.state);
    return { changed: [...changed.keys()], deleted: [...deleted], queries, written };
  }
}
