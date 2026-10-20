/**
 * The scope's dated timeline: history import (history.ts) plus SkyForge log attribution (skyforge-log.ts),
 * stored next to the mirror as `<scope>.history.json`.
 */
import os from 'node:os';
import path from 'node:path';
import type { NexusClient, SnRecord } from './nexus.js';
import type { InventoryRow, Manifest, ScopeInfo } from './mirror.js';
import { importHistory, type HistoryEvent, type HistoryOptions, type HistoryResult } from './history.js';
import { DEFAULT_LOG_WINDOW_MS, instanceName, matchHistory, readLogFile, type LogScan, type MatchCounts } from './skyforge-log.js';

export interface TimelineOptions {
  /** The SkyForge log to read; null skips log attribution. */
  logFile: string | null;
  windowMs?: number;
  /** Full records from the pull, by sys_id. */
  full?: Map<string, SnRecord>;
  history?: Omit<HistoryOptions, 'full'>;
  /** The ServiceNow user SkyForge works as, when known (see `sessionUser`). */
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
    agentUser: string | null; agentUserFrom: 'log' | 'session' | null } | null;
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
  const history = await importHistory(client, scope, inventory, { ...opts.history, full: opts.full });
  const windowMs = opts.windowMs ?? DEFAULT_LOG_WINDOW_MS;
  const events: TimelineEvent[] = history.events.map(e => {
    const path = e.sysId ? manifest.records[e.sysId]?.path : undefined;
    return path ? { ...e, path } : { ...e };
  });
  let log: LogScan | null = null;
  if (opts.logFile && events.length) {
    // Only lines that can match: the history's span plus the window, with an hour to spare on each side.
    const from = events[0].at - windowMs - 60 * 60_000;
    const to = events[events.length - 1].at + windowMs + 60 * 60_000;
    log = await readLogFile(opts.logFile, { from, to });
  }
  const instance = manifest.instance ? instanceName(manifest.instance) : null;
  const calls = log?.calls ?? [];
  const otherInstance = calls.filter(c => c.host && instance && c.host !== instance).length;
  const unknownInstance = calls.filter(c => !c.host || !instance).length;
  const agentUser = opts.agentUser ?? null;
  const fromLog = calls.find(c => c.user)?.user ?? null;
  const counts = matchHistory(events, calls, { windowMs, instance: manifest.instance || null, agentUser });
  const doc: TimelineDoc = {
    instance: manifest.instance,
    scope: { sys_id: scope.sys_id, scope: scope.scope, name: scope.name },
    sources: {
      versions: history.versions, updateXml: history.updateXml, fromVersions: history.fromVersions, fromUpdateXml: history.fromUpdateXml,
      captured: history.captured, versionsBy: history.versionsBy, partial: history.partial,
    },
    log: opts.logFile
      ? { file: homeRelative(opts.logFile), found: log !== null, lines: log?.lines ?? 0, parsed: log?.parsed ?? 0, calls: calls.length, windowMs, otherInstance, unknownInstance,
        agentUser: fromLog ?? agentUser, agentUserFrom: fromLog ? 'log' : agentUser ? 'session' : null }
      : null,
    counts,
    events,
  };
  return { doc, history, log };
}
