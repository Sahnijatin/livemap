/**
 * The scope's dated timeline: history import (history.ts) plus SkyForge log attribution (skyforge-log.ts),
 * stored next to the mirror as `<scope>.history.json`.
 */
import type { NexusClient } from './nexus.js';
import type { InventoryRow, Manifest, ScopeInfo } from './mirror.js';
import { importHistory, type HistoryEvent, type HistoryResult } from './history.js';
import { DEFAULT_LOG_WINDOW_MS, matchHistory, readLogFile, type LogScan, type MatchCounts } from './skyforge-log.js';

export interface TimelineOptions {
  /** The SkyForge log to read; null skips log attribution. */
  logFile: string | null;
  windowMs?: number;
}

export interface TimelineEvent extends HistoryEvent {
  /** The record's mirror file, when the record is in the mirror. */
  path?: string;
}

export interface TimelineDoc {
  instance: string;
  scope: { sys_id: string; scope: string; name: string };
  sources: { versions: number; updateXml: number; fromVersions: number; fromUpdateXml: number };
  log: { file: string; found: boolean; lines: number; parsed: number; calls: number; windowMs: number } | null;
  counts: MatchCounts;
  events: TimelineEvent[];
}

export interface TimelineResult { doc: TimelineDoc; history: HistoryResult; log: LogScan | null }

export async function buildTimeline(client: NexusClient, scope: ScopeInfo, inventory: InventoryRow[], manifest: Manifest, opts: TimelineOptions): Promise<TimelineResult> {
  const history = await importHistory(client, scope, inventory);
  const windowMs = opts.windowMs ?? DEFAULT_LOG_WINDOW_MS;
  const events: TimelineEvent[] = history.events.map(e => {
    const path = e.sysId ? manifest.records[e.sysId]?.path : undefined;
    return path ? { ...e, path } : { ...e };
  });
  let log: LogScan | null = null;
  if (opts.logFile && events.length) {
    // Only lines that can match: the history's span plus the window on each side.
    const from = events[0].at - windowMs - 60 * 60_000;
    const to = events[events.length - 1].at + windowMs + 60 * 60_000;
    log = await readLogFile(opts.logFile, { from, to });
  }
  const counts = matchHistory(events, log?.calls ?? [], windowMs);
  const doc: TimelineDoc = {
    instance: manifest.instance,
    scope: { sys_id: scope.sys_id, scope: scope.scope, name: scope.name },
    sources: { versions: history.versions, updateXml: history.updateXml, fromVersions: history.fromVersions, fromUpdateXml: history.fromUpdateXml },
    log: opts.logFile ? { file: opts.logFile, found: log !== null, lines: log?.lines ?? 0, parsed: log?.parsed ?? 0, calls: log?.calls.length ?? 0, windowMs } : null,
    counts,
    events,
  };
  return { doc, history, log };
}
