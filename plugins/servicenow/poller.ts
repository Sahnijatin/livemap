/**
 * Live changes (phase 2): polls the instance through nexus, read-only, and keeps the mirror current.
 *
 * - Two cursors, on instance time: `sys_update_xml` by `application` (every tracked change, with its update set
 *   and user) and `sys_metadata` by `sys_scope` (changes made outside update sets). An idle poll is those two
 *   queries. Changed records are then read in full by class and `sys_id`, and the mirror is laid out again;
 *   only files that changed are written, so the watcher reports just those.
 * - Deletes: update_xml rows with `action=DELETE`, and `sys_metadata_delete` every few polls.
 * - Cursors are `>=` the last second seen, with the sys_ids already applied at that second skipped, so two
 *   changes in one second are both applied and none twice. They live in `.livemap/sn/state.json`.
 * - Clock skew: each exact record match gives a gap (instance time minus call time); the median of the last
 *   few sets the attribution's skew margin, and is kept in state.json.
 * - Offline: when nexus does not answer, the mirror stays as it was, the status says offline, and polls back
 *   off up to a minute. The next answer catches up from the cursors.
 */
import type { SourceStatus } from '../../src/shared/protocol.js';
import { PROPERTY_FIELDS, INVENTORY_FIELDS } from './backfill.js';
import { CHANGE_FIELDS, changeFacts, updateNameIndex, updateSetNames } from './changes.js';
import { layoutMirror, WITHHELD_CLASS, type ChangeFacts, type InventoryRow, type Manifest, type ScopeInfo } from './mirror.js';
import { NexusOfflineError, NexusToolError, type NexusClient, type SnRecord } from './nexus.js';
import { readManifest, writeMirror, writePollState, type PollState, type WriteResult } from './writer.js';

export const DEFAULT_POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
/** Deleted records are read every this many polls (they are rare, and an idle poll should stay at two queries). */
const DELETES_EVERY = 6;
const SKEW_SAMPLES = 21;
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
}

export interface PollResult { changed: string[]; deleted: string[]; queries: number; written: WriteResult | null }

const SYS_ID = /^[0-9a-f]{32}$/;
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const maxTime = (times: (string | undefined)[]): string | undefined => times.reduce<string | undefined>((m, t) => (t && (!m || t > m) ? t : m), undefined);

/** Cursors for a first run: the latest time the pull saw, in each source. */
export function initialState(scope: string, updateXml: SnRecord[], inventory: InventoryRow[]): PollState {
  const xml = maxTime(updateXml.map(r => r.sys_updated_on));
  const meta = maxTime(inventory.map(r => r.sys_updated_on));
  const all = maxTime([xml, meta]);
  return {
    version: 1, scope,
    cursors: { ...(xml ? { updateXml: xml } : {}), ...(meta ? { metadata: meta } : {}), ...(all ? { deleted: all } : {}) },
    seen: {
      updateXml: updateXml.filter(r => r.sys_updated_on === xml).map(r => r.sys_id),
      metadata: inventory.filter(r => r.sys_updated_on === meta).map(r => r.sys_id),
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
    const skew = Math.min(MAX_SKEW_MS, Math.abs(median) + SKEW_MARGIN_MS);
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

  /** New rows of one source since its cursor, without those already applied at the cursor's second. */
  private fresh(source: Source, rows: SnRecord[], id: (r: SnRecord) => string = r => r.sys_id): SnRecord[] {
    const cursor = this.state.cursors[source];
    const seen = new Set(this.state.seen?.[source] ?? []);
    return rows.filter(r => !(cursor && r.sys_updated_on === cursor && seen.has(id(r))));
  }

  private advance(source: Source, rows: SnRecord[], id: (r: SnRecord) => string = r => r.sys_id): void {
    const latest = maxTime(rows.map(r => r.sys_updated_on));
    if (!latest) return;
    const prev = this.state.cursors[source];
    const keep = prev === latest ? this.state.seen?.[source] ?? [] : [];
    const ids = [...new Set([...keep, ...rows.filter(r => r.sys_updated_on === latest).map(id)])];
    this.state = { ...this.state, cursors: { ...this.state.cursors, [source]: latest }, seen: { ...this.state.seen, [source]: ids } };
  }

  /** One poll. Throws NexusOfflineError when nexus does not answer; the mirror is then left as it was. */
  async tick(): Promise<PollResult> {
    const { client, ctx } = this;
    const scopeId = ctx.scope.sys_id;
    let queries = 0;
    const q = async (table: string, query: string, fields?: string[]): Promise<SnRecord[]> => {
      queries++;
      return client.query(table, { query, ...(fields ? { fields } : {}), pageSize: 200, orderBy: 'sys_updated_on' });
    };
    const since = (source: Source) => (this.state.cursors[source] ? `^sys_updated_on>=${this.state.cursors[source]}` : '');
    this.polls++;

    const xml = this.fresh('updateXml', await q('sys_update_xml', `application=${scopeId}${since('updateXml')}`, CHANGE_FIELDS));
    const meta = this.fresh('metadata', await q('sys_metadata', `sys_scope=${scopeId}${since('metadata')}`, INVENTORY_FIELDS));
    let deletedRows: SnRecord[] = [];
    // A delete row is a record of its own (it is in the scope's inventory); the deleted record is the one its
    // update name names. A row without one names nothing.
    const deleteId = (r: SnRecord) => /_([0-9a-f]{32})$/.exec(r.sys_update_name ?? '')?.[1] ?? '';
    if (!this.deletesOff && this.polls % DELETES_EVERY === 1) {
      try {
        deletedRows = this.fresh('deleted', await q('sys_metadata_delete', `sys_scope=${scopeId}${since('deleted')}`, ['sys_id', 'sys_update_name', 'sys_class_name', 'sys_updated_on']), deleteId);
      } catch (e) {
        if (!(e instanceof NexusToolError)) throw e;
        // The table is not readable here: deletes still come from update_xml rows.
        this.deletesOff = true;
        this.opts.warn?.(`sys_metadata_delete cannot be read (${e.message}); deletes come from update sets only`);
      }
    }

    const recordOf = updateNameIndex(ctx.full);
    const inv = new Map(ctx.inventory.map(r => [r.sys_id, r]));
    const deleted = new Set<string>();
    for (const r of xml) if (r.action === 'DELETE') { const id = recordOf(r.name ?? ''); if (id) deleted.add(id); }
    for (const r of deletedRows) { const id = deleteId(r); if (SYS_ID.test(id ?? '')) deleted.add(id); }
    const changed = new Map<string, string>(); // sys_id -> class
    for (const r of meta) if (r.sys_id && r.sys_class_name) changed.set(r.sys_id, r.sys_class_name);
    for (const r of xml) {
      if (r.action === 'DELETE') continue;
      const id = recordOf(r.name ?? '');
      const cls = (id && inv.get(id)?.sys_class_name) ?? /^(.+)_[0-9a-f]{32}$/.exec(r.name ?? '')?.[1];
      if (id && cls && !changed.has(id)) changed.set(id, cls);
    }
    // A record saved again after it was deleted is back; one deleted after it was saved is gone.
    for (const id of deleted) changed.delete(id);

    // Read the changed records in full, by class. Credential classes stay names only; properties never carry a value.
    const metaById = new Map(meta.map(r => [r.sys_id, r]));
    const byClass = new Map<string, string[]>();
    for (const [id, cls] of changed) byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
    for (const [cls, ids] of byClass) {
      if (WITHHELD_CLASS.test(cls)) continue;
      for (const part of chunks(ids, 80)) {
        const recs = await q(cls, `sys_idIN${part.join(',')}`, cls === 'sys_properties' ? PROPERTY_FIELDS : undefined);
        for (const r of recs) if (r.sys_scope === undefined || r.sys_scope === scopeId) ctx.full.set(r.sys_id, r);
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

    // Each changed record's last change: its newest update_xml row, with the update set's name. A change made
    // outside update sets has no row: its time and user come from sys_metadata, with no update set.
    for (const r of meta) {
      const f = ctx.facts.get(r.sys_id);
      if (!deleted.has(r.sys_id) && r.sys_updated_on && (!f?.updatedOn || r.sys_updated_on > f.updatedOn)) {
        ctx.facts.set(r.sys_id, { ...(r.sys_updated_by ? { updatedBy: r.sys_updated_by } : {}), updatedOn: r.sys_updated_on });
      }
    }
    if (xml.length) {
      const unnamed = new Set(xml.map(r => r.update_set).filter(id => SYS_ID.test(id ?? '') && !ctx.setNames.has(id)));
      if (unnamed.size) {
        await updateSetNames(client, xml, ctx.setNames);
        queries += Math.ceil(unnamed.size / 80);
      }
      changeFacts(xml, updateNameIndex(ctx.full), ctx.setNames, ctx.facts);
    }

    let written: WriteResult | null = null;
    let manifest: Manifest | null = null;
    if (changed.size || deleted.size) {
      ctx.inventory = [...inv.values()];
      const laid = layoutMirror({ instance: ctx.instance, scope: ctx.scope, inventory: ctx.inventory, full: ctx.full, facts: ctx.facts, rootAbs: this.opts.root, ...(ctx.pulledAt ? { pulledAt: ctx.pulledAt } : {}) });
      manifest = laid.manifest;
      written = writeMirror(this.opts.root, laid.files, laid.manifest);
    }
    if (xml.length && this.opts.onSaves) {
      // The history file is extra: a failure there never stops polling.
      try {
        const m = manifest ?? readManifest(this.opts.root, ctx.scope.scope);
        if (m) await this.opts.onSaves(xml, ctx, m);
      } catch (e) {
        this.opts.warn?.(`history: could not add new saves (${(e as Error)?.message ?? String(e)})`);
      }
    }
    this.advance('updateXml', xml);
    this.advance('metadata', meta);
    this.advance('deleted', deletedRows, deleteId);
    writePollState(this.opts.root, this.state);
    return { changed: [...changed.keys()], deleted: [...deleted], queries, written };
  }
}
