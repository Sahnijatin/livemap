/**
 * The scope's dated timeline: history import (history.ts) plus SkyForge log attribution (skyforge-log.ts),
 * stored next to the mirror as `<scope>.history.json`.
 */
import os from 'node:os';
import path from 'node:path';
import type { NexusClient, SnRecord } from './nexus.js';
import type { InventoryRow, Manifest, ScopeInfo } from './mirror.js';
import { sessionUser } from './backfill.js';
import { collectionOf, DEFAULT_HISTORY_BUDGET_MS, importHistory, markBulkRewrites, updateTable, type HistoryEvent, type HistoryOptions, type HistoryResult } from './history.js';
import { updateNameIndex } from './changes.js';
import { writeHistory } from './writer.js';
import { DEFAULT_LOG_WINDOW_MS, instanceName, LogTail, matchHistory, readLogFile, type LogScan, type MatchCounts } from './skyforge-log.js';

export interface TimelineOptions {
  /** The SkyForge log to read; null skips log attribution. */
  logFile: string | null;
  windowMs?: number;
  /** Full records from the pull, by sys_id. */
  full?: Map<string, SnRecord>;
  history?: Omit<HistoryOptions, 'full'>;
  /**
   * The ServiceNow user nexus works as. Left out, it is asked of nexus (`sn_session_context`) when there is a
   * log to match, within the history's time budget.
   */
  agentUser?: string | null;
}

export interface TimelineEvent extends HistoryEvent {
  /** The record's mirror file, when the record is in the mirror. */
  path?: string;
}

export interface TimelineDoc {
  instance: string;
  scope: { sys_id: string; scope: string; name: string };
  sources: { versions: number; updateXml: number; fromVersions: number; fromUpdateXml: number; captured: number; versionsBy: HistoryResult['versionsBy']; partial: boolean };
  /** `file` is relative to the home folder (`~/...`) when it lies under it. */
  log: { file: string; found: boolean; lines: number; parsed: number; calls: number; windowMs: number;
    /** Write calls made while the log was connected to another instance, or to none it named. */
    otherInstance: number; unknownInstance: number;
    /** The agent's ServiceNow user, and where it came from. */
    /** The agent's ServiceNow user the matching used, and where it came from. */
    agentUser: string | null; agentUserFrom: 'log' | 'session' | null;
    /** Every agent user seen on this instance: nexus's first, then the log's. */
    agentUsers: string[] } | null;
  counts: MatchCounts;
  events: TimelineEvent[];
}

export interface TimelineResult { doc: TimelineDoc; history: HistoryResult; log: LogScan | null }

/** A path under the home folder as `~/...`, so the stored file names no user folder. */
export function homeRelative(file: string): string {
  const rel = path.relative(os.homedir(), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : file;
}

export async function buildTimeline(client: NexusClient, scope: ScopeInfo, inventory: InventoryRow[], manifest: Manifest, opts: TimelineOptions): Promise<TimelineResult> {
  // One budget for the whole step: the nexus user lookup and the import share it.
  const now = opts.history?.now ?? Date.now;
  const budget = opts.history?.budgetMs ?? DEFAULT_HISTORY_BUDGET_MS;
  const start = now();
  const agentUser = opts.agentUser !== undefined ? opts.agentUser : opts.logFile ? await sessionUser(client, { at: start + budget, now }) : null;
  const history = await importHistory(client, scope, inventory, { ...opts.history, full: opts.full, budgetMs: Math.max(0, budget - (now() - start)) });
  const windowMs = opts.windowMs ?? DEFAULT_LOG_WINDOW_MS;
  let log: LogScan | null = null;
  if (opts.logFile && history.events.length) {
    // Only lines that can match: the history's span plus the window, with an hour to spare on each side.
    const from = history.events[0].at - windowMs - 60 * 60_000;
    const to = history.events[history.events.length - 1].at + windowMs + 60 * 60_000;
    log = await readLogFile(opts.logFile, { from, to });
  }
  const instance = manifest.instance ? instanceName(manifest.instance) : null;
  const calls = log?.calls ?? [];
  // Versions rewritten in bulk while SkyForge did nothing here are an update set commit, not saves.
  markBulkRewrites(history, calls.filter(c => !c.host || !instance || c.host === instance).map(c => c.at));
  const events: TimelineEvent[] = history.events.map(e => {
    const path = e.sysId ? manifest.records[e.sysId]?.path : undefined;
    return path ? { ...e, path } : { ...e };
  });
  const otherInstance = calls.filter(c => c.host && instance && c.host !== instance).length;
  const unknownInstance = calls.filter(c => !c.host || !instance).length;
  const logUsers = (instance && log?.agentUsers[instance]) || [];
  const fromLog = logUsers[0] ?? null;
  const counts = matchHistory(events, calls, { windowMs, instance: manifest.instance || null, agentUser: agentUser ?? fromLog, scope: scope.scope });
  const doc: TimelineDoc = {
    instance: manifest.instance,
    scope: { sys_id: scope.sys_id, scope: scope.scope, name: scope.name },
    sources: {
      versions: history.versions, updateXml: history.updateXml, fromVersions: history.fromVersions, fromUpdateXml: history.fromUpdateXml,
      captured: history.captured, versionsBy: history.versionsBy, partial: history.partial,
    },
    log: opts.logFile
      ? { file: homeRelative(opts.logFile), found: log !== null, lines: log?.lines ?? 0, parsed: log?.parsed ?? 0, calls: calls.length, windowMs, otherInstance, unknownInstance,
        agentUser: agentUser ?? fromLog, agentUserFrom: agentUser ? 'session' : fromLog ? 'log' : null,
        agentUsers: [...new Set([...(agentUser ? [agentUser] : []), ...logUsers])] }
      : null,
    counts,
    events,
  };
  return { doc, history, log };
}

const NAME_KEYS = ['name', 'id', 'title', 'url_suffix', 'column_label', 'element', 'api_name', 'label', 'sys_name'];

export interface LiveTimelineOptions {
  root: string;
  logFile: string | null;
  windowMs?: number;
  agentUser?: string | null;
}

/**
 * Keeps `<scope>.history.json` growing while LiveMap polls: each new update_xml row becomes a dated save,
 * matched to SkyForge's log like the imported history, and the file is written again.
 */
export class LiveTimeline {
  /** Times of the saves already in the file, by update name. */
  private readonly seen = new Map<string, number[]>();
  private readonly tail: LogTail | null;

  constructor(private readonly doc: TimelineDoc, private readonly opts: LiveTimelineOptions) {
    for (const e of doc.events) if (e.kind !== 'captured') this.remember(e.update, e.at);
    this.tail = opts.logFile ? new LogTail(opts.logFile) : null;
  }

  private remember(update: string, at: number): void {
    const list = this.seen.get(update) ?? [];
    list.push(at);
    this.seen.set(update, list);
  }

  /** A save already in the file: the same update name within 2 s (the import and a poll can both see it). */
  private known(update: string, at: number): boolean {
    return (this.seen.get(update) ?? []).some(t => Math.abs(t - at) <= 2000);
  }

  /** Adds the saves in `rows` (the poll's new update_xml rows) and returns them; the file is rewritten when any. */
  async addSaves(rows: SnRecord[], full: Map<string, SnRecord>, manifest: Manifest, inventory: InventoryRow[]): Promise<TimelineEvent[]> {
    const inv = new Map(inventory.map(r => [r.sys_id, r]));
    const recordOf = updateNameIndex(full);
    const added: TimelineEvent[] = [];
    for (const r of rows) {
      const at = Date.parse(`${(r.sys_updated_on ?? '').replace(' ', 'T')}Z`);
      if (Number.isNaN(at) || !r.name) continue;
      const sysId = recordOf(r.name);
      const rec = sysId ? full.get(sysId) : undefined;
      const table = (sysId && inv.get(sysId)?.sys_class_name) ?? rec?.sys_class_name ?? updateTable(r.name) ?? 'unknown';
      const del = r.action === 'DELETE';
      const created = !del && rec?.sys_created_on && Math.abs(Date.parse(`${rec.sys_created_on.replace(' ', 'T')}Z`) - at) <= 2000;
      const kind: TimelineEvent['kind'] = del ? 'deleted' : created ? 'created' : 'modified';
      if (this.known(r.name, at)) continue;
      this.remember(r.name, at);
      const dictionary = table === 'sys_dictionary';
      const display = r.target_name || rec?.sys_name || r.name;
      const label = dictionary && display.includes('.') ? display.slice(display.lastIndexOf('.') + 1) : display;
      const keys = [...new Set([label, ...NAME_KEYS.filter(k => !(dictionary && k === 'name')).map(k => rec?.[k])].map(v => v?.trim().toLowerCase()).filter((v): v is string => !!v))];
      const e: TimelineEvent = {
        at, kind, table, update: r.name, name: display, keys, author: r.sys_updated_by || r.sys_created_by || 'unknown', source: 'update_xml', confidence: 'history',
      };
      if (sysId) e.sysId = sysId;
      const collection = collectionOf(table, rec);
      if (collection) e.collection = collection;
      const p = sysId ? manifest.records[sysId]?.path : undefined;
      if (p) e.path = p;
      added.push(e);
    }
    if (!added.length) return added;
    const windowMs = this.opts.windowMs ?? DEFAULT_LOG_WINDOW_MS;
    // Only the lines added since the last read; the reader keeps the rest.
    const calls = (await this.tail?.update())?.calls ?? [];
    const counts = matchHistory(added, calls, { windowMs, instance: this.doc.instance || null, agentUser: this.opts.agentUser ?? this.doc.log?.agentUser ?? null, scope: this.doc.scope.scope });
    for (const k of Object.keys(counts) as (keyof MatchCounts)[]) this.doc.counts[k] += counts[k];
    this.doc.events.push(...added);
    this.doc.events.sort((a, b) => a.at - b.at || a.update.localeCompare(b.update));
    writeHistory(this.opts.root, this.doc.scope.scope, this.doc);
    return added;
  }
}
