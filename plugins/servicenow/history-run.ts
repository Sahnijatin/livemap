/**
 * The scope's version history (`<scope>.history.json`, see timeline.ts) as a back-dated run in LiveMap's history
 * store, written before the live run starts, so rewind shows the scope growing from its first saves.
 *
 * Each history event of a mirrored record becomes one `change` with the record's files as they are now: the
 * history says when a record was created, changed or deleted, and by whom, but not what it held then. The run
 * starts from the files no history event creates (records older than the history, and files of no record), and
 * ends with the files as they are now.
 *
 * Imported once per scope: the store keeps the import's id apart from its runs, so neither a restart nor the
 * cap brings it back. Saves after it reach the live runs through live polling. A build whose import format is
 * newer (`HISTORY_IMPORT_FORMAT`) rebuilds the run once: the project's recorded timeline is reset, and the whole
 * history is imported again as its first run.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ServerMessage } from '../../src/shared/protocol.js';
import type { ProjectState } from '../../src/shared/state.js';
import { emptyState } from '../../src/shared/state.js';
import type { Attribution, ChangeSummary, FileModel } from '../../src/shared/types.js';
import type { DomainIndex } from '../../src/shared/domain.js';
import type { HistoryStore } from '../../src/history/store.js';
import type { TimelineDoc, TimelineEvent } from './timeline.js';
import { historyPath } from './writer.js';

/**
 * The version of what an import writes. Bump it when the run's content changes (its attributions, say): a start
 * on a newer format resets the project's recorded timeline and imports the history again.
 */
export const HISTORY_IMPORT_FORMAT = 1;

/** The run id of a scope's import: `sn-history-<scope>`. */
export const historyRunId = (scope: string): string => `sn-history-${scope.replace(/[^\w.-]/g, '_')}`;

export interface HistoryRunInput {
  root: string;
  name: string;
  /** The mirror's files now, from the model. */
  files: FileModel[];
  events: TimelineEvent[];
  /** The domain index of a set of files (the server's builder). */
  domainOf?: (files: FileModel[]) => DomainIndex;
}

export interface HistoryRun {
  start: ProjectState;
  records: { at: number; msg: ServerMessage }[];
  /** Events used, and events left out: a recapture, or no mirrored file (a deleted record, a record not mirrored). */
  used: number;
  skipped: number;
}

const short = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

/**
 * The attribution a SkyForge log line supports (`log`, `likely`), or none: a save known only from the version
 * history is not agent work.
 */
export function attributionOf(e: TimelineEvent): Attribution | undefined {
  if ((e.confidence !== 'log' && e.confidence !== 'likely') || !e.log?.length) return undefined;
  const first = e.log[0];
  const more = e.log.length > 1 ? ` (${e.log.length} candidate calls)` : '';
  const why = e.reason ? `; ${e.reason}` : '';
  return {
    agent: 'skyforge', sessionId: 'skyforge-log', confidence: e.confidence, rule: 'log',
    reason: `${first.tool} at ${short(first.at)}, SkyForge log line ${first.line}${more}${why}`,
  };
}

/** Files by every folder and file path that holds them, so a folder record (a widget) finds all its files. */
function filesByPath(files: FileModel[]): Map<string, FileModel[]> {
  const out = new Map<string, FileModel[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = parts.length; i > 0; i--) {
      const key = parts.slice(0, i).join('/');
      const list = out.get(key);
      if (list) list.push(f);
      else out.set(key, [f]);
    }
  }
  return out;
}

function emptyChange(id: number, path: string, kind: ChangeSummary['kind'], at: number, lang: ChangeSummary['lang']): ChangeSummary {
  return {
    id, path, kind, at, lang,
    symbols: { added: [], removed: [], modified: [] }, routes: { added: [], removed: [] },
    entities: { added: [], removed: [], changed: [] }, imports: { added: [], removed: [], externalAdded: [] },
    env: { added: [], removed: [] }, lines: { added: 0, removed: 0 }, hunks: [], truncated: false,
  };
}

/**
 * The back-dated run for these events. A file whose first event creates it starts absent and appears at that
 * event; every other file is there from the start. Several records can share a file (a table and its columns),
 * so a create of a file already there is a change to it, and a delete removes a file only when a later event
 * creates it again; otherwise it is a change, since the file is there now. The run ends with today's files.
 */
export function buildHistoryRun(input: HistoryRunInput): HistoryRun {
  const byPath = filesByPath(input.files);
  const events = input.events.filter(e => e.kind !== 'captured').sort((a, b) => a.at - b.at);
  const usable = events.filter(e => e.path && byPath.has(e.path));
  const filesOf = (e: TimelineEvent) => byPath.get(e.path as string) as FileModel[];
  const firstKind = new Map<string, TimelineEvent['kind']>();
  const lastCreate = new Map<string, number>();
  usable.forEach((e, i) => {
    for (const f of filesOf(e)) {
      if (!firstKind.has(f.path)) firstKind.set(f.path, e.kind);
      if (e.kind === 'created') lastCreate.set(f.path, i);
    }
  });
  const baseline = input.files.filter(f => firstKind.get(f.path) !== 'created');
  const present = new Set(baseline.map(f => f.path));
  const start: ProjectState = { ...emptyState(input.root, input.name), files: baseline };
  if (input.domainOf) start.domain = input.domainOf(baseline);
  const records: HistoryRun['records'] = [];
  usable.forEach((e, i) => {
    const files = filesOf(e);
    const main = files.find(f => f.path === e.path) ?? files[0];
    let kind: ChangeSummary['kind'];
    let msg: Extract<ServerMessage, { type: 'change' }>;
    const change = emptyChange(i + 1, main.path, 'modified', e.at, main.lang);
    if (e.kind === 'deleted') {
      const gone = files.filter(f => present.has(f.path) && (lastCreate.get(f.path) ?? -1) > i);
      for (const f of gone) present.delete(f.path);
      kind = gone.includes(main) ? 'deleted' : 'modified';
      change.lines.removed = gone.reduce((n, f) => n + f.lines, 0);
      msg = { type: 'change', change, files: files.filter(f => present.has(f.path)), removed: gone.map(f => f.path) };
    } else {
      const added = files.filter(f => !present.has(f.path));
      for (const f of added) present.add(f.path);
      kind = added.includes(main) ? 'created' : 'modified';
      change.lines.added = added.reduce((n, f) => n + f.lines, 0);
      msg = { type: 'change', change, files, removed: [] };
    }
    change.kind = kind;
    const attribution = attributionOf(e);
    if (attribution) change.attribution = attribution;
    if (e.author) change.savedBy = e.author;
    records.push({ at: e.at, msg });
  });
  if (records.length) {
    // The scope as it is now, once the history has run, so the last state matches the live one.
    const at = records[records.length - 1].at;
    records.push({ at, msg: { type: 'files', files: input.files, removed: [] } });
    if (input.domainOf) records.push({ at, msg: { type: 'domain', domain: input.domainOf(input.files) } });
  }
  return { start, records, used: usable.length, skipped: input.events.length - usable.length };
}

export interface ImportResult {
  /**
   * `imported`: written now (`rebuilt` when it replaced an older format's run). `already`: imported on an earlier
   * start. `partial`: the history stopped early, so not imported (or not rebuilt) yet. `none`: no history, or
   * nothing in it to show.
   */
  status: 'imported' | 'already' | 'partial' | 'none';
  imported: number;
  skipped: number;
  runId: string;
  rebuilt: boolean;
  /** With `partial`: an older format's run is still in place, waiting for a rebuild. */
  stale?: true;
}

/**
 * Imports the scope's history into `store` as a back-dated run, once per scope and import format. A partial
 * history (its read stopped at the time budget) is left for a later start that reads all of it.
 *
 * A rebuild for a newer format deletes every recorded run, live ones included, so it imports the whole history:
 * saves polled since the old import are in no run any more.
 */
export async function importScopeHistory(store: HistoryStore, opts: { root: string; name: string; scope: string; files: FileModel[]; domainOf?: (files: FileModel[]) => DomainIndex; format?: number }): Promise<ImportResult> {
  const format = opts.format ?? HISTORY_IMPORT_FORMAT;
  const runId = historyRunId(opts.scope);
  const before = store.importInfo(runId);
  const rebuild = !!before && before.format < format;
  const none: ImportResult = { status: 'none', imported: 0, skipped: 0, runId, rebuilt: false };
  if (before && !rebuild) return { ...none, status: 'already' };
  let text: string;
  let doc: TimelineDoc;
  try {
    text = fs.readFileSync(historyPath(opts.root, opts.scope), 'utf8');
    doc = JSON.parse(text) as TimelineDoc;
  } catch {
    return none;
  }
  if (!doc || !Array.isArray(doc.events) || !doc.events.length) return none;
  if (doc.sources?.partial) return { ...none, status: 'partial', ...(rebuild ? { stale: true as const } : {}) };
  const events = doc.events.filter(e => typeof e.at === 'number');
  const run = buildHistoryRun({ root: opts.root, name: opts.name, files: opts.files, events, ...(opts.domainOf ? { domainOf: opts.domainOf } : {}) });
  if (!run.records.length) return { ...none, skipped: run.skipped };
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const newest = events.reduce((m, e) => Math.max(m, e.at), -Infinity);
  const written = await store.importRun(runId, run.start, run.records, { format, hash, until: newest });
  return written ? { status: 'imported', imported: run.used, skipped: run.skipped, runId, rebuilt: rebuild } : none;
}
