import type { DomainIndex } from './domain.js';
import type { ServerMessage } from './protocol.js';
import type { AgentEvent, AgentSession, ChangeSummary, FileModel } from './types.js';
import { emptySummaries, type FileSummary } from './summaries.js';

/** Caps mirrored from the UI store (`ui/src/store.ts`); keep the two in step. */
export const MAX_CHANGES = 2000;
export const MAX_EVENTS = 2000;

/** The project data a client holds: a `hello` message without its type and its recording fields (`history`, `seq`). */
export type ProjectState = Omit<Extract<ServerMessage, { type: 'hello' }>, 'type' | 'history' | 'seq'>;

function emptyDomain(): DomainIndex {
  return { routes: [], tables: [], dataRefs: [], stack: [], deps: [], scripts: [], env: [], counts: { routes: 0, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 } };
}

export function emptyState(root: string, name: string): ProjectState {
  return { root, name, files: [], changes: [], usedBy: [], domain: emptyDomain(), indexing: false, events: [], sessions: [], control: { paused: false, flags: [] }, summaries: emptySummaries() };
}

/** Files after removing then upserting; an existing path keeps its position, a new one is appended. */
function upsertFiles(files: FileModel[], upserts: FileModel[], removed: string[]): FileModel[] {
  const byPath = new Map(files.map(f => [f.path, f]));
  for (const p of removed) byPath.delete(p);
  for (const f of upserts) byPath.set(f.path, f);
  return [...byPath.values()];
}

function appendCapped<T>(list: T[], item: T, max: number): T[] {
  return list.length >= max ? [...list.slice(list.length - max + 1), item] : [...list, item];
}

/** Applies one server message. Pure: unchanged slices keep their references. Mirrors the UI store's `apply` for data. */
export function applyMessage(state: ProjectState, msg: ServerMessage): ProjectState {
  switch (msg.type) {
    case 'hello': {
      // Replaces everything. Tolerates a hello without agent fields or a domain, like the UI store.
      const { type: _type, history: _history, seq: _seq, ...rest } = msg;
      return {
        ...rest,
        changes: msg.changes.slice(-MAX_CHANGES),
        events: (msg.events ?? []).slice(-MAX_EVENTS),
        sessions: dedupeSessions(msg.sessions ?? []),
        domain: msg.domain ?? emptyDomain(),
        control: msg.control ?? { paused: false, flags: [] },
        summaries: msg.summaries ?? emptySummaries(),
      };
    }
    case 'files':
      return { ...state, files: upsertFiles(state.files, msg.files, msg.removed) };
    case 'change':
      return { ...state, changes: appendCapped<ChangeSummary>(state.changes, msg.change, MAX_CHANGES), files: upsertFiles(state.files, msg.files, msg.removed) };
    case 'usedBy':
      return { ...state, usedBy: msg.usedBy };
    case 'domain':
      return { ...state, domain: msg.domain };
    case 'indexing':
    case 'history':
      return state;
    case 'summary':
      return patchChange(state, msg.changeId, { summary: msg.summary });
    case 'fileSummary': {
      const prev = state.summaries ?? emptySummaries();
      return { ...state, summaries: { ...prev, files: withFileSummary(prev.files, msg) } };
    }
    case 'summaryStatus':
      return { ...state, summaries: { ...(state.summaries ?? emptySummaries()), status: msg.status } };
    case 'agentEvent':
      return { ...state, events: appendCapped<AgentEvent>(state.events, msg.event, MAX_EVENTS) };
    case 'session': {
      const i = state.sessions.findIndex(s => s.id === msg.session.id);
      if (i < 0) return { ...state, sessions: [...state.sessions, msg.session] };
      const sessions = state.sessions.slice();
      sessions[i] = msg.session;
      return { ...state, sessions };
    }
    case 'control':
      return { ...state, control: msg.control };
    case 'attribution':
      return patchChange(state, msg.changeId, { attribution: msg.attribution });
    default: {
      // Replay may meet record types a newer build wrote; they leave the state alone.
      const _unknown: never = msg;
      return state;
    }
  }
}

/** File summaries after a `fileSummary` message: set, or removed when its hash is empty (a clear). Mirrored by the UI store. */
export function withFileSummary(files: Record<string, FileSummary>, msg: { path: string; hash: string; summary: string }): Record<string, FileSummary> {
  const out = { ...files };
  if (msg.hash) out[msg.path] = { hash: msg.hash, summary: msg.summary };
  else delete out[msg.path];
  return out;
}

/** The change with `id` (newest first) merged with `patch`; the state itself when no change has that id. */
function patchChange(state: ProjectState, id: number, patch: Partial<ChangeSummary>): ProjectState {
  for (let i = state.changes.length - 1; i >= 0; i--) {
    if (state.changes[i].id !== id) continue;
    const changes = state.changes.slice();
    changes[i] = { ...state.changes[i], ...patch };
    return { ...state, changes };
  }
  return state;
}

/** A hello's sessions keyed by id, last one winning, as the UI store's record does. */
function dedupeSessions(sessions: AgentSession[]): AgentSession[] {
  return [...new Map(sessions.map(s => [s.id, s])).values()];
}
