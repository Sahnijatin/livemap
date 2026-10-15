import { create } from 'zustand';
import type { ApiRoute, DomainIndex, Table } from '@shared/domain.js';
import type { HistoryStatus, UsedByEntry, WireMessage } from '@shared/protocol.js';
import { patchChanges, withFileSummary, type ProjectState } from '@shared/state.js';
import { emptySummaries, type SummariesState } from '@shared/summaries.js';
import type { AgentEvent, AgentSession, ChangeSummary, ControlState, Dep, FileModel } from '@shared/types.js';
import { LARGE_PROJECT, codeFileCount, edgeBaseline, type Level } from './map/mapModel';
import { historySource, type HistoryRecord, type HistoryState, type LiveState } from './history';

export const MAX_CHANGES = 2000;
export const MAX_EVENTS = 2000;

export type CenterTab = 'activity' | 'map' | 'schema' | 'api' | 'stack';
export const CENTER_TABS: CenterTab[] = ['activity', 'map', 'schema', 'api', 'stack'];
const TAB_KEY = 'livemap-tab';

/** The remembered center tab; `activity` when storage is empty, unavailable or throws. */
export function loadTab(): CenterTab {
  try {
    const t = globalThis.localStorage?.getItem(TAB_KEY);
    return CENTER_TABS.includes(t as CenterTab) ? (t as CenterTab) : 'activity';
  } catch {
    return 'activity';
  }
}

const FOLLOW_KEY = 'livemap:follow';

/** The remembered Follow toggle; on when storage is empty, unavailable or throws. */
export function loadFollow(): boolean {
  try {
    return globalThis.localStorage?.getItem(FOLLOW_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveFollow(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(FOLLOW_KEY, on ? '1' : '0');
  } catch {
    // Blocked storage: the setting lasts for this page only.
  }
}

function saveTab(t: CenterTab): void {
  try {
    globalThis.localStorage?.setItem(TAB_KEY, t);
  } catch {
    // Private mode or blocked storage: the tab lasts for this page only.
  }
}

/** Identity of a dependency for "new since hello": its manifest and name. */
export const depKey = (d: Dep & { file: string }): string => `${d.file}\u0000${d.name}`;

/** Identity of a table across domain updates: its merged table name, case-insensitive. */
export const tableKey = (t: Pick<Table, 'table'>): string => t.table.toLowerCase();
/** Identity of a column for "new since hello": its table and name, case-insensitive. */
export const fieldKey = (t: Pick<Table, 'table'>, f: { name: string }): string => `${tableKey(t)}\u0000${f.name.toLowerCase()}`;
/** Identity of a route for "new since hello": method, full path and file, without the line (edits above it move the line). */
export const routeBaseKey = (r: Pick<ApiRoute, 'method' | 'fullPath' | 'file'>): string => `${r.method} ${r.fullPath} ${r.file}`;

export function emptyDomainIndex(): DomainIndex {
  return { routes: [], tables: [], dataRefs: [], stack: [], deps: [], scripts: [], env: [], counts: { routes: 0, pages: 0, screens: 0, tables: 0, deps: 0, env: 0 } };
}

/** Tech ids, dep keys, table keys, field keys and route keys present in the last hello; later items not in these sets are "new". */
export interface DomainBase { stack: Set<string>; deps: Set<string>; tables: Set<string>; fields: Set<string>; routes: Set<string> }

function baseOf(d: DomainIndex): DomainBase {
  return {
    stack: new Set(d.stack.map(t => t.id)),
    deps: new Set(d.deps.map(depKey)),
    tables: new Set(d.tables.map(tableKey)),
    fields: new Set(d.tables.flatMap(t => t.fields.map(f => fieldKey(t, f)))),
    routes: new Set(d.routes.map(routeBaseKey)),
  };
}

export type RecentKind = 'created' | 'modified';
/** How many recently selected files the palette's "Recent" lists. */
export const HISTORY_MAX = 8;

/** `path` first, then the rest without it, at most HISTORY_MAX. */
function pushHistory(history: string[], path: string): string[] {
  if (history[0] === path) return history;
  return [path, ...history.filter(p => p !== path)].slice(0, HISTORY_MAX);
}
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

/** Recording status before a hello says otherwise (and from a server without history). */
export const NO_HISTORY: HistoryStatus = { enabled: false, first: 0, last: 0, firstAt: 0, lastAt: 0 };

export interface StoreState {
  connected: boolean;
  /** Finer connection detail for the status chip; `unauthorized` stops reconnecting. */
  connection: ConnectionState;
  indexing: { done: number; total: number } | null;
  /** True once a hello has arrived, so the UI can tell "loading" from "empty project". */
  loaded: boolean;
  /** When the last hello arrived; rows that appear with a hello do not animate in. */
  helloAt: number;
  root: string;
  name: string;
  files: Record<string, FileModel>;
  changes: ChangeSummary[];
  usedBy: UsedByEntry[];
  selected: string | null;
  recent: Record<string, { kind: RecentKind; at: number }>;
  expanded: Record<string, boolean>;
  filter: string;
  /** A line in the selected file to scroll the code view to (seq makes repeats fire). */
  reveal: { path: string; line: number; seq: number } | null;
  /** Narrow layouts: which slide-over panel is open. */
  panel: 'files' | 'inspector' | null;
  /** Agent activity: the last 2,000 events, sessions by id, and pause and flag state. */
  events: AgentEvent[];
  sessions: Record<string, AgentSession>;
  control: ControlState;
  /** The newest event id replayed by the last hello; later ids arrived live. */
  liveAfterId: number;
  /** Bumped by every live hello. A new LiveMap run restarts event ids at 1, so per-id memos reset on it. */
  hellos: number;
  /** A short message shown at the top of the window (seq makes repeats fire). */
  toast: { text: string; tone: 'info' | 'error'; seq: number } | null;
  /** Routes, tables, stack, deps, scripts and env for the whole project. */
  domain: DomainIndex;
  domainBase: DomainBase;
  /** `domain.routes` grouped by file, rebuilt only when the domain changes. */
  routesByFile: Record<string, ApiRoute[]>;
  /** The center pane's tab, remembered across reloads. */
  tab: CenterTab;
  /** Map detail level; a large project opens at folders. */
  mapLevel: Level;
  /** Map folders (by `dir:` id) whose files show in a large project. */
  mapExpanded: Record<string, true>;
  /** File and folder edge ids present in the last hello; later edges are "new". */
  helloEdges: Set<string>;
  /** File paths present in the last hello; files that appear later are new to this session (they spring in on the Map). */
  helloFiles: Set<string>;
  /** Map Follow: the camera eases to the file the agent is writing. Remembered across reloads. */
  follow: boolean;
  /** The last HISTORY_MAX distinct selected files, most recent first. */
  history: string[];
  /** Requests for the active view to bring something into view (seq makes repeats fire). */
  mapFocus: { path: string; seq: number } | null;
  tableFocus: { key: string; seq: number } | null;
  routeTrace: { id: string; seq: number } | null;
  /** The ⌘K palette is open. */
  paletteOpen: boolean;
  /** Recording status, from hello and `history` messages. (`history` above is the recent-files list.) */
  historyStatus: HistoryStatus;
  /** The UI shows a past moment: live data messages are dropped until `backToLive`. */
  rewound: { seq: number; at: number } | null;
  /** The timeline is playing history forward. */
  playing: boolean;
  /** Summarizer status (always live, even while rewound) and file summaries by path. */
  summaries: SummariesState;
  /** An exported replay: no server, always rewound; its end state stands in for live. */
  replay: boolean;

  /** Applies a socket message (or a played one); while rewound, live data is dropped or buffered. */
  apply(msg: WireMessage): void;
  select(path: string | null): void;
  toggle(path: string): void;
  setFilter(q: string): void;
  setConnection(state: ConnectionState): void;
  revealLine(path: string, line: number): void;
  clearReveal(): void;
  setPanel(panel: StoreState['panel']): void;
  showToast(text: string, tone?: 'info' | 'error'): void;
  setTab(t: CenterTab): void;
  setMapLevel(level: Level): void;
  toggleMapFolder(id: string): void;
  expandMapFolder(id: string): void;
  setFollow(on: boolean): void;
  /** Ask the Map to center on a file (a programmatic camera move). */
  focusMap(path: string): void;
  /** Ask the Schema view to center and highlight a table (by table key). */
  focusTable(key: string): void;
  /** Ask the API view to trace a route (by route id). */
  traceRoute(id: string): void;
  setPalette(open: boolean): void;
  /** Shows the project as it was at a recorded seq; keeps the tab, selection and panel. */
  rewind(state: HistoryState): void;
  /** Applies one played record while rewound (a `hello` is a run boundary: a full replace). */
  applyHistorical(rec: HistoryRecord): void;
  /** Fetches the live state and applies it like a hello, keeping the tab, selection and panel. */
  backToLive(): Promise<void>;
  setPlaying(on: boolean): void;
  reset(): void;
}

const initial = {
  connected: false,
  connection: 'connecting' as ConnectionState,
  indexing: null,
  loaded: false,
  helloAt: 0,
  root: '',
  name: '',
  files: {},
  changes: [],
  usedBy: [],
  selected: null,
  recent: {},
  expanded: {},
  filter: '',
  reveal: null,
  panel: null,
  events: [],
  sessions: {},
  control: { paused: false, flags: [] } as ControlState,
  liveAfterId: 0,
  hellos: 0,
  toast: null,
  mapLevel: 'files' as Level,
  mapExpanded: {} as Record<string, true>,
  helloEdges: new Set<string>(),
  helloFiles: new Set<string>(),
  history: [] as string[],
  mapFocus: null,
  tableFocus: null,
  routeTrace: null,
  paletteOpen: false,
  historyStatus: NO_HISTORY,
  rewound: null as StoreState['rewound'],
  playing: false,
  summaries: emptySummaries(),
  replay: false,
};

function routesByFileOf(domain: DomainIndex): Record<string, ApiRoute[]> {
  const out: Record<string, ApiRoute[]> = {};
  for (const r of domain.routes) (out[r.file] ??= []).push(r);
  return out;
}

const freshDomain = () => ({ domain: emptyDomainIndex(), domainBase: baseOf(emptyDomainIndex()), routesByFile: {} });

/** Files after upserting and removing; clears the selection if its file is gone. */
function upsertFiles(st: StoreState, upserts: FileModel[], removed: string[]): Pick<StoreState, 'files' | 'selected'> {
  const files = { ...st.files };
  for (const p of removed) delete files[p];
  for (const f of upserts) files[f.path] = f;
  return { files, selected: st.selected && files[st.selected] ? st.selected : null };
}

function recordRecent(recent: StoreState['recent'], c: ChangeSummary): void {
  if (c.kind === 'deleted') delete recent[c.path];
  else recent[c.path] = { kind: c.kind, at: c.at };
}

/**
 * Project data from a hello (or a past state): replaces every data slice and resets the "new since hello"
 * baselines, so nothing that arrives with it animates in. View state is the caller's business.
 */
function replaceData(msg: ProjectState, st: StoreState) {
  const files: Record<string, FileModel> = {};
  for (const f of msg.files) files[f.path] = f;
  const changes = msg.changes.slice(-MAX_CHANGES);
  const recent: StoreState['recent'] = {};
  for (const c of changes) recordRecent(recent, c);
  // Tolerate a hello without agent fields (agent activity unavailable).
  const events = (msg.events ?? []).slice(-MAX_EVENTS);
  const sessions: Record<string, AgentSession> = {};
  for (const x of msg.sessions ?? []) sessions[x.id] = x;
  // Tolerate a hello without a domain (older server).
  const domain = msg.domain ?? emptyDomainIndex();
  return {
    domain,
    domainBase: baseOf(domain),
    routesByFile: routesByFileOf(domain),
    events,
    sessions,
    control: msg.control ?? { paused: false, flags: [] },
    liveAfterId: events.reduce((m, e) => Math.max(m, e.id), 0),
    loaded: true,
    helloAt: Date.now(),
    root: msg.root,
    name: msg.name,
    files,
    changes,
    usedBy: msg.usedBy,
    // Tolerate a hello (or past state) without summaries: older server or recording.
    summaries: msg.summaries ?? emptySummaries(),
    recent,
    indexing: msg.indexing ? st.indexing ?? { done: 0, total: 0 } : null,
    helloEdges: edgeBaseline(files),
    helloFiles: new Set(Object.keys(files)),
    // The first hello of a large project opens the map at folders; a reconnect keeps the user's level.
    ...(!st.loaded && codeFileCount(files) > LARGE_PROJECT ? { mapLevel: 'folders' as Level } : {}),
  };
}

/**
 * File summaries this page asked for and has no answer to yet (path to request time, 0 once it failed): the
 * Inspector asks once per file. Any `fileSummary` for a path, a summary or a clear, settles it, so a file whose
 * summary was withdrawn is asked for again when next viewed.
 */
export const summaryRequests = new Map<string, number>();
/** Bumped by every `summaryStatus`, so `backToLive` can tell one arrived while it waited. */
let statusGen = 0;

/** True while `applyHistorical` feeds a played record through `apply`, past the rewound guard. */
let replaying = false;
/** Bumped by every rewind and return to live, so a slow `backToLive` never overrides a later rewind. */
let viewGen = 0;
/** Bumped by every `backToLive`: a past state requested before it must not rewind the UI again. */
let liveGen = 0;
export const liveGeneration = (): number => liveGen;
/**
 * Stops the running play engine. `backToLive` calls it before anything else, so a played record (such as
 * a run-start hello, which rewinds) cannot land while it waits and make it give up.
 */
let stopPlayEngine: (() => void) | null = null;
export function setPlayEngine(stop: (() => void) | null): void {
  stopPlayEngine = stop;
}
function stopPlayback(): void {
  stopPlayEngine?.();
  stopPlayEngine = null;
}
/** Live data messages that arrive while `backToLive` waits for the live state; null when not waiting. */
let liveBuffer: WireMessage[] | null = null;

/**
 * Whether a message buffered during `backToLive` is newer than the fetched live state (seq `stateSeq`).
 * A message without a seq (recording off or failed) cannot be placed: it is replayed only when the
 * state's seq is unknown too, so a delta the state may already include is never applied twice.
 */
export const isAfter = (msg: WireMessage, stateSeq: number | undefined): boolean =>
  msg.seq === undefined ? stateSeq === undefined : stateSeq === undefined || msg.seq > stateSeq;


export const useStore = create<StoreState>()((set, get) => ({
  ...initial,
  ...freshDomain(),
  tab: loadTab(),
  follow: loadFollow(),

  apply(msg) {
    if (msg.type === 'fileSummary') summaryRequests.delete(msg.path); // even while rewound: see summaryRequests
    if (get().rewound && !replaying && msg.type !== 'history' && msg.type !== 'summaryStatus') {
      // Rewound: live data is dropped (backToLive refetches it), or kept while backToLive waits, for
      // replay after the state it fetches. A reconnect's hello still updates the status.
      if (msg.type === 'hello' && msg.history) set({ historyStatus: msg.history });
      liveBuffer?.push(msg);
      return;
    }
    switch (msg.type) {
      case 'hello': {
        // Replaces all project data. View state (selection, expansion, filter) survives a
        // reconnect as long as the selected file still exists.
        const { selected } = get();
        const data = replaceData(msg, get());
        set({
          ...data,
          hellos: get().hellos + 1,
          historyStatus: msg.history ?? NO_HISTORY,
          selected: selected && data.files[selected] ? selected : null,
        });
        return;
      }
      case 'history':
        set({ historyStatus: msg.history });
        return;
      case 'files':
        set(upsertFiles(get(), msg.files, msg.removed));
        return;
      case 'change': {
        const c = msg.change;
        const prev = get().changes;
        const changes = prev.length >= MAX_CHANGES ? [...prev.slice(prev.length - MAX_CHANGES + 1), c] : [...prev, c];
        const recent = { ...get().recent };
        recordRecent(recent, c);
        const expanded = c.kind === 'deleted' ? get().expanded : { ...get().expanded, [c.path]: true };
        // One update for the change and its files, so views re-render (and refetch code) once.
        set({ changes, recent, expanded, ...upsertFiles(get(), msg.files, msg.removed) });
        return;
      }
      case 'usedBy':
        set({ usedBy: msg.usedBy });
        return;
      case 'domain':
        set({ domain: msg.domain, routesByFile: routesByFileOf(msg.domain) });
        return;
      case 'indexing':
        set({ indexing: { done: msg.done, total: msg.total } });
        return;
      case 'agentEvent': {
        const prev = get().events;
        set({ events: prev.length >= MAX_EVENTS ? [...prev.slice(prev.length - MAX_EVENTS + 1), msg.event] : [...prev, msg.event] });
        return;
      }
      case 'session':
        set({ sessions: { ...get().sessions, [msg.session.id]: msg.session } });
        return;
      case 'control':
        set({ control: msg.control });
        return;
      case 'attribution':
      case 'summary': {
        const changes = patchChanges(get().changes, msg.changeId, msg.type === 'summary' ? { summary: msg.summary } : { attribution: msg.attribution });
        if (changes) set({ changes });
        return;
      }
      case 'fileSummary': {
        const prev = get().summaries;
        set({ summaries: { ...prev, files: withFileSummary(prev.files, msg) } });
        return;
      }
      case 'summaryStatus':
        statusGen++;
        set({ summaries: { ...get().summaries, status: msg.status } });
        return;
    }
  },

  select(path) {
    set(path ? { selected: path, history: pushHistory(get().history, path) } : { selected: null });
  },

  toggle(path) {
    const expanded = get().expanded;
    set({ expanded: { ...expanded, [path]: !expanded[path] } });
  },

  setFilter(q) {
    set({ filter: q });
  },

  setConnection(state) {
    set({ connection: state, connected: state === 'open' });
  },

  revealLine(path, line) {
    const seq = (get().reveal?.seq ?? 0) + 1;
    set({ selected: path, reveal: { path, line, seq }, history: pushHistory(get().history, path) });
  },

  clearReveal() {
    if (get().reveal) set({ reveal: null });
  },

  setPanel(panel) {
    set({ panel });
  },

  showToast(text, tone = 'info') {
    set({ toast: { text, tone, seq: (get().toast?.seq ?? 0) + 1 } });
  },

  setTab(tab) {
    set({ tab });
    saveTab(tab);
  },

  setMapLevel(mapLevel) {
    set({ mapLevel });
  },

  toggleMapFolder(id) {
    const mapExpanded = { ...get().mapExpanded };
    if (mapExpanded[id]) delete mapExpanded[id];
    else mapExpanded[id] = true;
    set({ mapExpanded });
  },

  expandMapFolder(id) {
    if (!get().mapExpanded[id]) set({ mapExpanded: { ...get().mapExpanded, [id]: true } });
  },

  setFollow(follow) {
    set({ follow });
    saveFollow(follow);
  },

  focusMap(path) {
    set({ mapFocus: { path, seq: (get().mapFocus?.seq ?? 0) + 1 } });
  },

  focusTable(key) {
    set({ tableFocus: { key, seq: (get().tableFocus?.seq ?? 0) + 1 } });
  },

  traceRoute(id) {
    set({ routeTrace: { id, seq: (get().routeTrace?.seq ?? 0) + 1 } });
  },

  setPalette(paletteOpen) {
    set({ paletteOpen });
  },

  rewind(state) {
    viewGen++;
    liveBuffer = null;
    const { seq, at, ...data } = state;
    // The selection stays even when its file did not exist yet, so going back to live restores it.
    // The summarizer status is the engine's now, not history's: it stays live.
    const past = replaceData(data, get());
    set({ ...past, summaries: { ...past.summaries, status: get().summaries.status }, rewound: { seq, at } });
  },

  applyHistorical({ seq, at, msg }) {
    if (!get().rewound) return;
    // A hello is a run boundary: the recorded start state of the next LiveMap run.
    if (msg.type === 'hello') return get().rewind({ ...msg, seq, at });
    const { selected } = get();
    replaying = true;
    try {
      get().apply(msg);
    } finally {
      replaying = false;
    }
    set({ rewound: { seq, at }, selected });
  },

  async backToLive() {
    // Drops a queued seek even before the first rewound state has landed.
    liveGen++;
    if (!get().rewound) return;
    stopPlayback();
    if (get().replay) {
      // No live in a replay: its end.
      set({ playing: false });
      const gen = viewGen;
      let end: HistoryState;
      try {
        end = await historySource().stateAt(get().historyStatus.last);
      } catch {
        if (gen === viewGen) get().showToast('Could not load the end of this replay.', 'error');
        return;
      }
      // A seek made while the end was loading wins.
      if (gen !== viewGen) return;
      return get().rewind(end);
    }
    const gen = ++viewGen;
    liveGen++;
    liveBuffer = [];
    const statusAt = statusGen;
    set({ playing: false });
    let live: LiveState;
    try {
      live = await historySource().live();
    } catch {
      if (gen === viewGen) {
        liveBuffer = null;
        get().showToast('LiveMap is not reachable. Is it still running?', 'error');
      }
      return;
    }
    if (gen !== viewGen || !get().rewound) return;
    const buffered = liveBuffer ?? [];
    liveBuffer = null;
    // Like a hello: the selection stays while its file exists; tab and panel are untouched. A status that
    // arrived while waiting is newer than the one in the fetched state.
    const { selected, historyStatus, summaries } = get();
    const data = replaceData(live, get());
    const status = live.history && live.history.last >= historyStatus.last ? live.history : historyStatus;
    // Likewise a summarizer status that arrived while waiting (it is applied at once, never buffered).
    if (statusGen !== statusAt) data.summaries = { ...data.summaries, status: summaries.status };
    set({ ...data, historyStatus: status, selected: selected && data.files[selected] ? selected : null, rewound: null });
    // Then what arrived after the state was built, each once.
    for (const m of buffered) if (isAfter(m, live.seq)) get().apply(m);
  },

  setPlaying(playing) {
    set({ playing });
  },

  reset() {
    summaryRequests.clear();
    set({ ...initial, ...freshDomain(), tab: 'activity', follow: loadFollow(), historyStatus: NO_HISTORY, rewound: null, playing: false, summaries: emptySummaries(), helloFiles: new Set(), files: {}, changes: [], usedBy: [], recent: {}, expanded: {}, events: [], sessions: {}, control: { paused: false, flags: [] }, mapExpanded: {}, helloEdges: new Set(), history: [] });
  },
}));
