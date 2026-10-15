import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { SECRET_LABEL, toolFamily } from '../agents/labels.js';
import { readForModel } from '../engine/files.js';
import { HistoryStore } from '../history/store.js';
import { projectDir } from '../history/paths.js';
import { EXPORT_DATA_ID, type ExportPayload } from '../shared/export.js';
import type { ServerMessage } from '../shared/protocol.js';
import { emptyState, type ProjectState } from '../shared/state.js';
import type { SummariesState } from '../shared/summaries.js';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary, ControlState } from '../shared/types.js';

const gzip = promisify(zlib.gzip);

export const NO_HISTORY = 'No history recorded for this project yet. Run livemap here first.';
export const codeWarning = (n: number): string =>
  `This export contains source code for ${n} files. Share it only with people who may see this code.`;

export interface ExportOptions { home?: string; session?: string; code: boolean; uiHtml: string }
export interface ExportResult { html: string; files: number; events: number }

type Rec = [number, number, ServerMessage];
type Hello = Extract<ServerMessage, { type: 'hello' }>;

const READ_CONCURRENCY = 16;

/**
 * One self-contained HTML replay of a project's recorded history: `uiHtml` (the single-file export UI)
 * with the payload embedded as gzip JSON in base64, which holds no `<` and so cannot close its script.
 * Reads the store read-only, so it works with or without a running LiveMap.
 */
export async function buildExport(root: string, opts: ExportOptions): Promise<ExportResult> {
  const realRoot = fs.realpathSync(root);
  const name = path.basename(realRoot);
  if (!fs.existsSync(projectDir(realRoot, opts.home))) throw new Error(NO_HISTORY);
  const store = await HistoryStore.open(realRoot, { home: opts.home, readOnly: true });
  try {
    const info = store.info();
    if (info.error) throw new Error(`History is unavailable: ${info.error}`);
    if (!info.last) throw new Error(NO_HISTORY);
    const all: Rec[] = store.messages(info.first, info.last, Number.MAX_SAFE_INTEGER).map(r => [r.seq, r.at, r.msg]);
    let initial: ProjectState;
    let messages: Rec[];
    if (opts.session === undefined) {
      // The first record becomes a hello of the state there: a run whose start the cap trimmed begins mid-run.
      const first = await store.stateAt(info.first);
      const { seq: _s, at: _a, ...state } = first;
      initial = emptyState(name, name);
      messages = [[all[0][0], all[0][1], { type: 'hello', ...state }], ...all.slice(1)];
    } else {
      ({ initial, messages } = await sessionScope(store, all, opts.session, info.first, name));
    }

    if (!opts.code) ({ initial, messages } = withoutCode(initial, messages));
    const code = opts.code ? await readCode(realRoot, initial, messages) : undefined;
    // Paths are scrubbed everywhere but in the code map: that is file content, shown as it is.
    const scrub = pathScrubber([root, realRoot], name);
    const local = localizer([root, realRoot]);
    const scrubbed = scrub.value(localSessions({ version: 1, name, exportedAt: Date.now(), initial, messages }, local));
    const payload: ExportPayload = { ...scrubbed, ...(code ? { code } : {}) };
    const json = JSON.stringify(payload);
    const data = (await gzip(Buffer.from(json, 'utf8'))).toString('base64');
    return { html: embed(opts.uiHtml, data), files: code ? Object.keys(code).length : 0, events: messages.length };
  } finally {
    await store.close();
  }
}

/**
 * A session's slice: its events and session records, the changes attributed to it (with their
 * attribution and summary records), and files, domain, usedBy, control, file summary and run start
 * records between its first and last event. Starts from the state just before its first event.
 */
async function sessionScope(store: HistoryStore, all: Rec[], id: string, firstSeq: number, name: string): Promise<{ initial: ProjectState; messages: Rec[] }> {
  const mine = all.filter(([, , m]) => m.type === 'agentEvent' && m.event.sessionId === id);
  if (!mine.length) throw new Error(`No events recorded for session ${id}.`);
  const first = mine[0][0];
  const last = mine[mine.length - 1][0];
  const changeIds = new Set<number>();
  for (const [seq, , m] of all) {
    if (seq < first) continue;
    if (m.type === 'attribution' && m.attribution.sessionId === id) changeIds.add(m.changeId);
    if (m.type === 'change' && m.change.attribution?.sessionId === id) changeIds.add(m.change.id);
  }
  const keep = (seq: number, m: ServerMessage): boolean => {
    if (seq < first) return false;
    const inSpan = seq <= last;
    switch (m.type) {
      case 'agentEvent': return m.event.sessionId === id;
      case 'session': return m.session.id === id;
      case 'change': return changeIds.has(m.change.id);
      case 'attribution': case 'summary': return changeIds.has(m.changeId);
      case 'hello': case 'files': case 'domain': case 'usedBy': case 'control': case 'fileSummary': return inSpan;
      default: return false;
    }
  };
  const only = (s: ProjectState): ProjectState => ({
    ...s,
    events: s.events.filter(e => e.sessionId === id),
    sessions: s.sessions.filter(x => x.id === id),
    changes: s.changes.filter(c => changeIds.has(c.id)),
  });
  const messages = all.filter(([seq, , m]) => keep(seq, m)).map(([seq, at, m]): Rec => [seq, at, m.type === 'hello' ? { ...m, ...only(m), type: 'hello' } : m]);
  let initial: ProjectState;
  // The nearest record before the first event: seqs can have gaps where a corrupt line was skipped.
  const before = all.filter(([seq]) => seq < first).at(-1)?.[0];
  if (before !== undefined && before >= firstSeq) {
    const { seq: _s, at: _a, ...state } = await store.stateAt(before);
    initial = only(state);
  } else {
    // The cap trimmed history to start at this event: the state there, without the event it replays next.
    const { seq: _s, at: _a, ...state } = await store.stateAt(first);
    const ev = (mine[0][2] as Extract<ServerMessage, { type: 'agentEvent' }>).event;
    const o = only(state);
    initial = { ...emptyState(name, name), ...o, events: o.events.filter(e => e.id !== ev.id) };
  }
  return { initial, messages };
}

/** Stands in for a fenced block or an inline code span in agent text under `--no-code`. */
export const CODE_REMOVED = '[code removed]';

/**
 * Agent text with code replaced, erring on the side of removing. A fence of three or more backticks or tildes
 * (also one opened mid-line) runs to a line holding only a closing fence of the same character at least as
 * long, so an inner shorter fence or a "```python" line does not end it, and an unclosed one runs to the end.
 * An inline span ends at the next backtick run of its own length, on its line or a later one (a hard-wrapped
 * prompt); an unclosed one (as in a truncated title) runs to the end of its line. Indented code blocks are not
 * recognized.
 */
export function stripCode(text: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(inlineCode(prose.join('\n')));
    prose = [];
  };
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1];
      out.push(CODE_REMOVED);
      continue;
    }
    // A run of three or more backticks later on the line that never closes opens a fence there.
    const mid = unclosedFence(line);
    if (mid) {
      prose.push(line.slice(0, mid.at));
      flush();
      out[out.length - 1] += CODE_REMOVED;
      fence = mid.run;
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join('\n');
}

/** Where a run of three or more backticks opens a block on `line`: the first such run with no match after it. */
function unclosedFence(line: string): { at: number; run: string } | null {
  for (const m of line.matchAll(/`{3,}/g)) {
    const run = m[0];
    const rest = line.slice(m.index + run.length);
    if (!new RegExp(`(?<!\`)${run}(?!\`)`).test(rest)) return { at: m.index, run };
  }
  return null;
}

/** Text with its backtick spans replaced; a span may cross lines, and an unclosed one runs to its line's end. */
function inlineCode(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('`', i);
    if (start < 0) return out + text.slice(i);
    let n = start;
    while (text[n] === '`') n++;
    const run = text.slice(start, n);
    const close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
    close.lastIndex = n;
    const m = close.exec(text);
    out += text.slice(i, start) + CODE_REMOVED;
    if (m) { i = m.index + run.length; continue; }
    const eol = text.indexOf('\n', n);
    if (eol < 0) return out;
    i = eol;
  }
}

/** `$ <command name>` of a shell label (`$ FOO=1 ./bin/run --x` is `$ run`); the secret marker stays. */
function shellLabel(label: string): string {
  if (label === SECRET_LABEL || !label.startsWith('$')) return label;
  const word = label.slice(1).trim().split(/\s+/).find(w => !/^[A-Za-z_]\w*=/.test(w)) ?? '';
  const name = /[\w.+-]+/.exec(word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1))?.[0];
  return name ? `$ ${name}` : '$';
}

/**
 * `--no-code`: the code map is not all of the source an export can carry. Diff hunks in change cards,
 * tool inputs and outputs in agent events (an Edit's old and new text), shell command lines in tool
 * labels, and code in prompts, messages, thinking, commit messages, session titles, attribution intents,
 * flag notes and AI summaries are code too. Symbol names and signatures stay: they are the structure the
 * Map and the cards show.
 */
function withoutCode(initial: ProjectState, messages: Rec[]): { initial: ProjectState; messages: Rec[] } {
  const attribution = (a: Attribution): Attribution => (a.intent === undefined ? a : { ...a, intent: stripCode(a.intent) });
  const change = (c: ChangeSummary): ChangeSummary => ({
    ...c, hunks: [],
    ...(c.attribution ? { attribution: attribution(c.attribution) } : {}),
    ...(c.summary !== undefined ? { summary: stripCode(c.summary) } : {}),
  });
  const prose = new Set<AgentEvent['type']>(['prompt', 'message', 'thinking', 'commit']);
  const event = (e: AgentEvent): AgentEvent => {
    const out = e.text !== undefined && prose.has(e.type) ? { ...e, text: stripCode(e.text) } : e;
    if (!out.tool) return out;
    const { input: _i, output: _o, ...tool } = out.tool;
    return { ...out, tool: { ...tool, label: toolFamily(tool.name) === 'shell' ? shellLabel(tool.label) : stripCode(tool.label) } };
  };
  const session = (s: AgentSession): AgentSession => ({ ...s, title: stripCode(s.title) });
  const control = (c: ControlState): ControlState => ({ ...c, flags: c.flags.map(f => ({ ...f, note: stripCode(f.note) })) });
  const summaries = (x: SummariesState): SummariesState => ({
    ...x, files: Object.fromEntries(Object.entries(x.files).map(([p, f]) => [p, { ...f, summary: stripCode(f.summary) }])),
  });
  const state = <T extends Pick<ProjectState, 'changes' | 'events' | 'sessions'> & { control?: ControlState; summaries?: SummariesState }>(s: T): T => ({
    ...s, changes: s.changes.map(change), events: s.events.map(event), sessions: s.sessions.map(session),
    ...(s.control ? { control: control(s.control) } : {}),
    ...(s.summaries ? { summaries: summaries(s.summaries) } : {}),
  });
  const msg = (m: ServerMessage): ServerMessage => {
    switch (m.type) {
      case 'hello': return state(m);
      case 'change': return { ...m, change: change(m.change) };
      case 'agentEvent': return { ...m, event: event(m.event) };
      case 'attribution': return { ...m, attribution: attribution(m.attribution) };
      case 'session': return { ...m, session: session(m.session) };
      case 'control': return { ...m, control: control(m.control) };
      case 'summary': case 'fileSummary': return { ...m, summary: stripCode(m.summary) };
      default: return m;
    }
  };
  return { initial: state(initial), messages: messages.map(([seq, at, m]): Rec => [seq, at, msg(m)]) };
}

/** Current text of the files the exported messages create or change, through the engine's reader: never secret, binary or over 1 MB. */
async function readCode(root: string, initial: ProjectState, messages: Rec[]): Promise<Record<string, string>> {
  const secret = new Set(initial.files.filter(f => f.flags.secret).map(f => f.path));
  const touched = new Set<string>();
  for (const [, , m] of messages) {
    if (m.type !== 'change' && m.type !== 'files' && m.type !== 'hello') continue;
    for (const f of m.files) if (f.flags.secret) secret.add(f.path);
    if (m.type === 'hello') continue;
    for (const f of m.files) touched.add(f.path);
    if (m.type === 'change' && m.change.kind !== 'deleted') touched.add(m.change.path);
  }
  const paths = [...touched].filter(p => !secret.has(p)).sort();
  const code: Record<string, string> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const rel = paths[next++];
      const r = await readForModel(root, rel, root);
      if (r?.kind === 'text') code[rel] = r.text;
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  // Keys in path order, whatever order the reads finished in.
  return Object.fromEntries(paths.filter(p => p in code).map(p => [p, code[p]]));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Either separator, once or more. */
const SEP = '[\\\\/]+';
/** A match starts at the string's start or after a character that cannot be part of a path. */
const START = '(?<![\\w.~$%@+\\-\\\\/])';
/** A bare path ends before anything that would continue its last name. */
const END = '(?![\\w.~$%@+\\-])';

/** The trailing separators of a path removed (a filesystem root is kept). */
const trimSep = (p: string): string => p.replace(/(?<=[^\\/:])[\\/]+$/, '');
/** A filesystem root: `/`, `C:` or `C:\`. */
const isFsRoot = (p: string): boolean => /^(?:[\\/]+|[A-Za-z]:[\\/]*)$/.test(p);

/**
 * A regex source matching `p` with either separator between its names and a drive letter in any case.
 * Case-insensitive file systems (Windows, macOS) match the whole path in any case.
 */
function pathSource(p: string): string {
  return trimSep(p).split(/[\\/]+/).map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? `[${seg[0].toLowerCase()}${seg[0].toUpperCase()}]:` : escapeRe(seg))).join(SEP);
}

/** Directories of a path, by either separator. */
const parentOf = (p: string): string => {
  const t = trimSep(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i <= 0 ? t.slice(0, i + 1) : t.slice(0, i);
};

export interface ScrubOptions { caseInsensitive?: boolean }

/**
 * Removes the project's location from text: `<root>/x` becomes `x`, a bare root becomes the project name,
 * and then `<parent of root>/y` becomes `y`, so sibling paths lose the user and home part too. Matches
 * either separator and any drive letter case, and only at a path boundary, so a longer path that merely
 * contains the root (`/mnt/bk/home/u/app/x`) is left alone.
 */
export function pathScrubber(roots: string[], name: string, opts: ScrubOptions = {}) {
  const flags = (opts.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')) ? 'gi' : 'g';
  const uniq = [...new Set(roots.map(trimSep))].filter(r => !isFsRoot(r)).sort((a, b) => b.length - a.length);
  const alt = (ps: string[]) => ps.map(pathSource).join('|');
  const parents = [...new Set(uniq.map(parentOf))].filter(p => p && !isFsRoot(p));
  const inside = new RegExp(`${START}(?:${alt(uniq)})${SEP}`, flags);
  const bare = new RegExp(`${START}(?:${alt(uniq)})${END}`, flags);
  const near = parents.length ? new RegExp(`${START}(?:${alt(parents)})${SEP}`, flags) : null;
  // A cheap test first: most strings mention no absolute path at all.
  const hint = new RegExp(alt(parents.length ? parents : uniq), flags.replace('g', ''));
  const text = (s: string): string => {
    if (!uniq.length || !hint.test(s)) return s;
    let out = s.replace(inside, '').replace(bare, () => name);
    if (near) out = out.replace(near, '');
    return out;
  };
  const value = <T>(v: T): T => {
    if (typeof v === 'string') return text(v) as T;
    if (Array.isArray(v)) return v.map(value) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[text(k)] = value(x);
      return out as T;
    }
    return v;
  };
  return { text, value };
}

/** `p` relative to a root it lies in ('.' for the root itself), else its base name. */
function localizer(roots: string[]): (p: string) => string {
  const uniq = [...new Set(roots.map(trimSep))].sort((a, b) => b.length - a.length);
  const flags = process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '';
  const re = new RegExp(`^(?:${uniq.map(pathSource).join('|')})(?:${SEP}(.*))?$`, flags);
  return p => {
    const m = re.exec(p);
    if (m) return m[1] ? m[1].split(/[\\/]+/).join('/') : '.';
    return trimSep(p).split(/[\\/]+/).pop() ?? p;
  };
}

function localSession(s: AgentSession, local: (p: string) => string): AgentSession {
  return { ...s, cwd: local(s.cwd), ...(s.transcriptPath ? { transcriptPath: local(s.transcriptPath) } : {}) };
}

/** Sessions' cwd and transcript paths made relative to the root, or reduced to their base name. */
function localSessions<P extends Omit<ExportPayload, 'code'>>(p: P, local: (p: string) => string): P {
  const state = <T extends ProjectState>(s: T): T => ({ ...s, sessions: s.sessions.map(x => localSession(x, local)) });
  return {
    ...p,
    initial: state(p.initial),
    messages: p.messages.map(([seq, at, m]): Rec => [seq, at,
      m.type === 'session' ? { ...m, session: localSession(m.session, local) } : m.type === 'hello' ? state(m as Hello) : m]),
  };
}

/** The page with the payload's script element inserted before its closing body tag. */
function embed(html: string, base64: string): string {
  const tag = `<script type="application/octet-stream" id="${EXPORT_DATA_ID}">${base64}</script>`;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}
