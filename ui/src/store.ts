import { create } from 'zustand';
import type { ServerMessage, UsedByEntry } from '@shared/protocol.js';
import type { ChangeSummary, FileModel } from '@shared/types.js';

export const MAX_CHANGES = 2000;

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

  apply(msg: ServerMessage): void;
  select(path: string | null): void;
  toggle(path: string): void;
  setFilter(q: string): void;
  setConnection(state: ConnectionState): void;
  revealLine(path: string, line: number): void;
  clearReveal(): void;
  setPanel(panel: StoreState['panel']): void;
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
};

function recordRecent(recent: StoreState['recent'], c: ChangeSummary): void {
  if (c.kind === 'deleted') delete recent[c.path];
  else recent[c.path] = { kind: c.kind, at: c.at };
}

export const useStore = create<StoreState>()((set, get) => ({
  ...initial,

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
        set({
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
      case 'files': {
        const files = { ...get().files };
        for (const p of msg.removed) delete files[p];
        for (const f of msg.files) files[f.path] = f;
        const { selected } = get();
        set({ files, selected: selected && files[selected] ? selected : null });
        return;
      }
      case 'change': {
        const c = msg.change;
        const prev = get().changes;
        const changes = prev.length >= MAX_CHANGES ? [...prev.slice(prev.length - MAX_CHANGES + 1), c] : [...prev, c];
        const recent = { ...get().recent };
        recordRecent(recent, c);
        const expanded = c.kind === 'deleted' ? get().expanded : { ...get().expanded, [c.path]: true };
        set({ changes, recent, expanded });
        return;
      }
      case 'usedBy':
        set({ usedBy: msg.usedBy });
        return;
      case 'indexing':
        set({ indexing: { done: msg.done, total: msg.total } });
        return;
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

  reset() {
    set({ ...initial, files: {}, changes: [], usedBy: [], recent: {}, expanded: {} });
  },
}));
