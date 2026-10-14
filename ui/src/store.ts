import { create } from 'zustand';
import type { ApiRoute, DomainIndex, Table } from '@shared/domain.js';
import type { ServerMessage, UsedByEntry } from '@shared/protocol.js';
import type { AgentEvent, AgentSession, ChangeSummary, ControlState, Dep, FileModel } from '@shared/types.js';

export const MAX_CHANGES = 2000;
export const MAX_EVENTS = 2000;

export type CenterTab = 'activity' | 'schema' | 'api' | 'stack';
export const CENTER_TABS: CenterTab[] = ['activity', 'schema', 'api', 'stack'];
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
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

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
  /** A short message shown at the top of the window (seq makes repeats fire). */
  toast: { text: string; tone: 'info' | 'error'; seq: number } | null;
  /** Routes, tables, stack, deps, scripts and env for the whole project. */
  domain: DomainIndex;
  domainBase: DomainBase;
  /** `domain.routes` grouped by file, rebuilt only when the domain changes. */
  routesByFile: Record<string, ApiRoute[]>;
  /** The center pane's tab, remembered across reloads. */
  tab: CenterTab;

  apply(msg: ServerMessage): void;
  select(path: string | null): void;
  toggle(path: string): void;
  setFilter(q: string): void;
  setConnection(state: ConnectionState): void;
  revealLine(path: string, line: number): void;
  clearReveal(): void;
  setPanel(panel: StoreState['panel']): void;
  showToast(text: string, tone?: 'info' | 'error'): void;
  setTab(t: CenterTab): void;
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
  toast: null,
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

export const useStore = create<StoreState>()((set, get) => ({
  ...initial,
  ...freshDomain(),
  tab: loadTab(),

  apply(msg) {
    switch (msg.type) {
      case 'hello': {
        // Replaces all project data. View state (selection, expansion, filter) survives a
        // reconnect as long as the selected file still exists.
        const files: Record<string, FileModel> = {};
        for (const f of msg.files) files[f.path] = f;
        const changes = msg.changes.slice(-MAX_CHANGES);
        const recent: StoreState['recent'] = {};
        for (const c of changes) recordRecent(recent, c);
        const { selected } = get();
        // Tolerate a hello without agent fields (agent activity unavailable).
        const events = (msg.events ?? []).slice(-MAX_EVENTS);
        const sessions: Record<string, AgentSession> = {};
        for (const x of msg.sessions ?? []) sessions[x.id] = x;
        // Tolerate a hello without a domain (older server).
        const domain = msg.domain ?? emptyDomainIndex();
        set({
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
          recent,
          indexing: msg.indexing ? get().indexing ?? { done: 0, total: 0 } : null,
          selected: selected && files[selected] ? selected : null,
        });
        return;
      }
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
      case 'attribution': {
        const prev = get().changes;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].id !== msg.changeId) continue;
          const changes = prev.slice();
          changes[i] = { ...prev[i], attribution: msg.attribution };
          set({ changes });
          return;
        }
        return;
      }
    }
  },

  select(path) {
    set({ selected: path });
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
    set({ selected: path, reveal: { path, line, seq } });
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

  reset() {
    set({ ...initial, ...freshDomain(), tab: 'activity', files: {}, changes: [], usedBy: [], recent: {}, expanded: {}, events: [], sessions: {}, control: { paused: false, flags: [] } });
  },
}));
