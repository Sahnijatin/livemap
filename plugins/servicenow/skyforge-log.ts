/**
 * SkyForge's own log (`~/.skyforge/skyforge-mcp.log`) as evidence for history attribution.
 *
 * Each tool call writes a start line and, often, a completion line:
 *
 *   [2026-06-03T16:01:29.115Z] [INFO] [Tool] tool_execute | tool=sn_create_field, table=t, column_label=Label
 *   [2026-06-03T16:01:30.871Z] [INFO] [Tool] sn_create_field ✅ 1756ms
 *
 * Argument values are cut at about 100 characters, some are `<redacted>`, and there is no session id and no
 * instance. So a call is matched to a history event only by what it names: the record's sys_id (updates and
 * deletes), else its table and name (creates). A match on table and time alone is never more than `likely`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { HistoryEvent, LogRef } from './history.js';

export const DEFAULT_SKYFORGE_LOG = path.join(os.homedir(), '.skyforge', 'skyforge-mcp.log');
export const DEFAULT_LOG_WINDOW_MS = 60_000;

export interface LogCall {
  /** 1-based line number of the start line. */
  line: number;
  at: number;
  /** Set when a completion line was paired with this call. */
  end?: number;
  ms?: number;
  /** The real tool (the inner tool of a `tool_execute`). */
  tool: string;
  kind: 'create' | 'update' | 'delete';
  /** The table the call writes a record of, when the tool or its arguments say. */
  table?: string;
  /** The table that record belongs to (a field's or business rule's table), when given. */
  collection?: string;
  sysId?: string;
  /** Lowercased full names the call gives the record (id, name, title, label, ...). */
  names: string[];
}

const START = /^\[([^\]]+)\] \[(\w+)\] \[Tool\] (\S+) \| (.*)$/;
const DONE = /^\[([^\]]+)\] \[(\w+)\] \[Tool\] (\S+) (?:✅|❌|✔|✖)\s*(\d+)\s*ms\b/;
const SYS_ID = /^[0-9a-f]{32}$/i;

/** `k=v, k=v` as logged; a value can hold `, ` itself, so only `, key=` starts a new pair. */
export function parseArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/, (?=[a-z_][a-z0-9_]*=)/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** A logged value usable as a name: not redacted, not cut short, not an object. */
function full(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s || s === '<redacted>' || s.includes('...') || /^(Array|Object)\(\d+\)$/.test(s) || /^[[{]/.test(s)) return undefined;
  return s;
}

/**
 * Create tools and the record table they write. `collection` names the argument that holds the table the new
 * record belongs to (for those tools `table=` is not the record's own table).
 */
const CREATES: Record<string, { table: string; collection?: string }> = {
  sn_create_field: { table: 'sys_dictionary', collection: 'table' },
  sn_create_choice: { table: 'sys_choice', collection: 'table' },
  sn_create_table: { table: 'sys_db_object' },
  sn_create_sp_widget: { table: 'sp_widget' },
  sn_create_sp_page: { table: 'sp_page' },
  sn_create_portal: { table: 'sp_portal' },
  sn_create_portal_theme: { table: 'sp_theme' },
  sn_create_script_include: { table: 'sys_script_include' },
  sn_create_business_rule: { table: 'sys_script', collection: 'table' },
  sn_create_client_script: { table: 'sys_script_client', collection: 'table' },
  sn_create_ui_action: { table: 'sys_ui_action', collection: 'table' },
  sn_create_ui_policy: { table: 'sys_ui_policy', collection: 'table' },
  sn_create_form_section: { table: 'sys_ui_section', collection: 'table' },
  sn_create_notification: { table: 'sysevent_email_action', collection: 'table' },
  sn_create_acl: { table: 'sys_security_acl' },
};
/** Tools that update the record named by `table` and `sys_id` (push_artifact: the table is in its folder). */
const UPDATES = new Set(['sn_edit_by_sysid', 'sn_push_artifact']);

/** Turns one start line into a write call, or null for reads and anything that names no record. */
export function toCall(line: number, at: number, outer: string, args: Record<string, string>): LogCall | null {
  const tool = outer === 'tool_execute' ? args.tool ?? outer : outer;
  const sysId = SYS_ID.test(args.sys_id ?? '') ? args.sys_id.toLowerCase() : undefined;
  const names = new Set<string>();
  for (const k of ['id', 'name', 'title', 'url_suffix', 'column_label', 'label', 'api_name']) {
    const v = full(args[k]);
    if (v) names.add(v.toLowerCase());
  }
  let call: LogCall | null = null;
  const create = CREATES[tool];
  if (create) {
    call = { line, at, tool, kind: 'create', table: create.table, names: [] };
    const coll = create.collection ? full(args[create.collection]) : undefined;
    if (coll) call.collection = coll.toLowerCase();
  } else if (tool === 'sn_record_manage') {
    const kind = args.action === 'create' ? 'create' : args.action === 'update' ? 'update' : args.action === 'delete' ? 'delete' : null;
    if (kind) call = { line, at, tool, kind, table: full(args.table), names: [] };
  } else if (UPDATES.has(tool)) {
    call = { line, at, tool, kind: 'update', table: full(args.table), names: [] };
    // `.../artifacts/<app>/<table>/<Record name>`: the folder names the table and the record.
    const dir = full(args.directory)?.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    if (dir && dir.length >= 2) {
      call.table ??= /^[a-z][a-z0-9_]*$/.test(dir[dir.length - 2]) ? dir[dir.length - 2] : undefined;
      names.add(dir[dir.length - 1].toLowerCase());
    }
  } else if (/^sn_delete_/.test(tool)) {
    call = { line, at, tool, kind: 'delete', table: full(args.table), names: [] };
  }
  if (!call) return null;
  call.names = [...names];
  if (sysId) call.sysId = sysId;
  return call;
}

export interface LogScan { lines: number; parsed: number; calls: LogCall[] }

/** Reads log lines (a whole file's text, or lines one by one) into write calls, completions paired. */
export class LogReader {
  readonly calls: LogCall[] = [];
  lines = 0;
  parsed = 0;
  /** Starts per tool still waiting for a completion line. */
  private open = new Map<string, LogCall[]>();
  constructor(private readonly range?: { from: number; to: number }) {}

  add(text: string): void {
    this.lines++;
    const line = this.lines;
    let m = START.exec(text);
    if (m) {
      const at = Date.parse(m[1]);
      if (Number.isNaN(at)) return;
      this.parsed++;
      if (this.range && (at < this.range.from || at > this.range.to)) return;
      const call = toCall(line, at, m[3], parseArgs(m[4]));
      if (!call) return;
      this.calls.push(call);
      const list = this.open.get(call.tool) ?? [];
      list.push(call);
      this.open.set(call.tool, list);
      return;
    }
    m = DONE.exec(text);
    if (!m) return;
    const end = Date.parse(m[1]);
    if (Number.isNaN(end)) return;
    this.parsed++;
    const ms = Number(m[4]);
    // The start this line closes: the open call of that tool whose start plus duration is nearest its time.
    const list = this.open.get(m[3]);
    if (!list?.length) return;
    let best = -1;
    let gap = Infinity;
    list.forEach((c, i) => {
      const g = Math.abs(c.at + ms - end);
      if (g < gap) { gap = g; best = i; }
    });
    if (best < 0 || gap > 1000) return;
    const [c] = list.splice(best, 1);
    c.end = end;
    c.ms = ms;
  }

  result(): LogScan { return { lines: this.lines, parsed: this.parsed, calls: this.calls }; }
}

export function parseLog(text: string, range?: { from: number; to: number }): LogScan {
  const r = new LogReader(range);
  for (const line of text.split(/\r?\n/)) if (line) r.add(line);
  return r.result();
}

/** Reads the log file line by line (it grows for months); null when it does not exist. */
export async function readLogFile(file: string, range?: { from: number; to: number }): Promise<LogScan | null> {
  if (!fs.existsSync(file)) return null;
  const r = new LogReader(range);
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line) r.add(line);
  return r.result();
}

export interface MatchCounts { events: number; matched: number; ambiguous: number; timeOnly: number; unmatched: number }

const ref = (c: LogCall): LogRef => (c.ms === undefined ? { line: c.line, at: c.at, tool: c.tool } : { line: c.line, at: c.at, tool: c.tool, ms: c.ms });

/** Distance in ms from an instant to a call's start..end span (0 inside it). */
const distance = (at: number, c: LogCall): number => (at < c.at ? c.at - at : at > (c.end ?? c.at) ? at - (c.end ?? c.at) : 0);

/**
 * Attributes events to log calls, in place, and counts the outcome.
 *
 * - A candidate writes the event's table (a delete only for a delete) within `windowMs` of its time, and is not
 *   for another collection.
 * - It names the event's record when its sys_id matches, or one of its names does.
 * - One naming candidate: `log`. Several: `likely`, with all of them. Candidates that name nothing (table and
 *   time only): `likely`, with all of them, never `log`. None: the event stays `history`.
 */
export function matchHistory(events: HistoryEvent[], calls: LogCall[], windowMs = DEFAULT_LOG_WINDOW_MS): MatchCounts {
  const sorted = [...calls].sort((a, b) => a.at - b.at);
  const counts: MatchCounts = { events: events.length, matched: 0, ambiguous: 0, timeOnly: 0, unmatched: 0 };
  for (const e of events) {
    // Calls whose start can be within the window (a call's span can run past its start).
    let lo = 0;
    let hi = sorted.length;
    const from = e.at - windowMs - 10 * 60_000;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].at < from) lo = mid + 1; else hi = mid; }
    const near: LogCall[] = [];
    for (let i = lo; i < sorted.length && sorted[i].at <= e.at + windowMs; i++) {
      const c = sorted[i];
      if (c.table !== e.table || distance(e.at, c) > windowMs) continue;
      if ((e.kind === 'deleted') !== (c.kind === 'delete')) continue;
      if (c.collection && e.collection && c.collection !== e.collection.toLowerCase()) continue;
      near.push(c);
    }
    const named = near.filter(c => (c.sysId !== undefined && c.sysId === e.sysId?.toLowerCase()) || c.names.some(n => e.keys.includes(n)));
    delete e.log;
    if (named.length === 1) {
      e.confidence = 'log';
      e.log = [ref(named[0])];
      counts.matched++;
    } else if (named.length > 1) {
      e.confidence = 'likely';
      e.log = named.map(ref);
      counts.ambiguous++;
    } else if (near.length) {
      e.confidence = 'likely';
      e.log = near.map(ref);
      counts.timeOnly++;
    } else {
      e.confidence = 'history';
      counts.unmatched++;
    }
  }
  return counts;
}
