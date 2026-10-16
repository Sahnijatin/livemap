/**
 * The file tree's code that first paint does not need, in a chunk of its own (FileTree loads it on mount): key
 * handling, and opening and closing folders.
 */
import type { Dispatch, SetStateAction } from 'react';
import { MAX_STORED, NO_PATHS, ancestors, closedAbove, dirKey, editSet as edit, type DirState, type Item } from '../treeModel';
import type { Moving, Session } from './FileTree';

/** Folder unfold and fold (height and fade), matching `.dgroup.unfold/.fold` in styles.css. */
const FOLD_MS = 360;

/** Typed letters within this long of each other search as one prefix. */
const TYPEAHEAD_MS = 700;

/** What the handler reads from a key event (a replayed key has only these). */
export interface KeyPress { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void }

type Set_<T> = Dispatch<SetStateAction<T>>;

/** What the deferred tree code reads and sets in FileTree. */
export interface TreeContext {
  dirItems: ReadonlyMap<string, Extract<Item, { kind: 'dir' }>>;
  q: string;
  reduced: boolean;
  big: boolean;
  dirs: DirState;
  /** The first index is still running: the default may change when it ends, so every choice is stored. */
  indexing: boolean;
  setFilterClosed: Set_<{ q: string; dirs: ReadonlySet<string> }>;
  setDirs: Set_<DirState>;
  setSession: Set_<Session>;
  setMoving: Set_<ReadonlyMap<string, Moving>>;
  /** Focusable rows in order. */
  navKeys: string[];
  navSet: ReadonlySet<string>;
  /** The rows (not those of folding folders), for typeahead names. */
  items: Item[];
  /** Focuses the row with this nav key. */
  focus(key: string): void;
  /** Opens or closes the folder or file row. */
  toggle(el: HTMLElement): void;
}

/** What was typed for typeahead, and when (one tree on the page). */
const typed = { text: '', at: 0 };

const namesCache = new WeakMap<Item[], Map<string, string[]>>();
/** Lowercase names per row, built once per row list: a file's name, or each folder of a compact row ("app" finds src/app). */
export function namesFor(items: Item[]): Map<string, string[]> {
  let names = namesCache.get(items);
  if (!names) {
    names = new Map();
    for (const it of items) {
      if (it.kind === 'dir') names.set(dirKey(it.node.path), it.label.toLowerCase().split('/'));
      else if (it.kind === 'file') names.set(it.row.file.path, [it.row.name.toLowerCase()]);
    }
    namesCache.set(items, names);
  }
  return names;
}

/**
 * The file tree's keys: Up/Down/Home/End move, Right opens or enters, Left
 * closes or goes up, and typing a name moves to the next row that starts with it.
 */
export function treeKeyDown(e: KeyPress, c: TreeContext): void {
  const el = document.activeElement as HTMLElement | null;
  const key = el?.dataset.nav;
  const { navKeys } = c;
  const i = key ? navKeys.indexOf(key) : -1;
  if (!el || i < 0) return;
  const focusAt = (j: number) => c.focus(navKeys[Math.max(0, Math.min(navKeys.length - 1, j))]);
  const expanded = el.getAttribute('aria-expanded');
  const up = el.dataset.parent ?? el.dataset.up;
  switch (e.key) {
    case 'ArrowDown': focusAt(i + 1); break;
    case 'ArrowUp': focusAt(i - 1); break;
    case 'Home': focusAt(0); break;
    case 'End': focusAt(navKeys.length - 1); break;
    case 'ArrowRight':
      if (expanded === 'false') c.toggle(el);
      else if (expanded === 'true') focusAt(i + 1);
      else return;
      break;
    case 'ArrowLeft':
      if (expanded === 'true') c.toggle(el);
      else if (up !== undefined && c.navSet.has(up)) c.focus(up);
      else return;
      break;
    default: {
      // Typeahead: a printable character with no modifier, or typed with AltGr (Ctrl and Alt together, as panels.ts
      // allows). Space presses the row, and `[` and `]` toggle the panels, so those are left alone, as is a key that
      // matches no row.
      if (e.key.length !== 1 || ' []'.includes(e.key) || e.metaKey || e.ctrlKey !== e.altKey) return;
      const now = Date.now();
      const t = typed;
      t.text = now - t.at < TYPEAHEAD_MS ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const names = namesFor(c.items);
      const from = t.text.length > 1 ? i : i + 1;
      let hit = -1;
      for (let n = 0; n < navKeys.length && hit < 0; n++) {
        const j = (from + n) % navKeys.length;
        if (names.get(navKeys[j])?.some(name => name.startsWith(t.text))) hit = j;
      }
      if (hit < 0) return;
      focusAt(hit);
    }
  }
  e.preventDefault();
}

/** Opens or closes a folder row: for the session under a filter, else as the user's saved choice. */
export function toggleDir(dir: string, c: TreeContext): void {
  const item = c.dirItems.get(dir);
  if (!item) return;
  const { open, chain } = item;
  const { q } = c;
  if (q) {
    c.setFilterClosed(f => {
      const was = f.q === q ? f.dirs : NO_PATHS;
      return { q, dirs: open ? edit(was, [dir]) : edit(was, [], [dir]) };
    });
  } else {
    // A chain opens and closes as a whole, so each of its folders keeps the state when the chain splits.
    // A folder set back to its default (open below BIG_PROJECT files) is not stored, except while indexing; the
    // oldest go past the cap.
    c.setDirs(d => {
      const next = new Map(d);
      for (const p of chain) { next.delete(p); if (c.indexing || open !== c.big) next.set(p, !open); } // re-added last: the newest choices are kept longest
      for (const k of next.keys()) { if (next.size <= MAX_STORED) break; next.delete(k); }
      return next;
    });
    // The user's choice replaces a reveal, and a close holds against the agent for the session.
    c.setSession(s => ({
      ...s,
      picked: edit(s.picked, [], chain),
      closed: open ? edit(s.closed, chain) : edit(s.closed, [], chain),
    }));
  }
  if (c.reduced) return;
  // A closing folder keeps the rows it shows now until its fold ends. A child still folding inside it is kept as a
  // closed row: its own rows go at once (a snap inside a fold that is closing anyway).
  const rows = c.items;
  const at = rows.findIndex(it => it.kind === 'dir' && it.node.path === dir);
  let end = at + 1;
  while (at >= 0 && end < rows.length && rows[end].level > rows[at].level) end++;
  const kept = open && at >= 0 ? rows.slice(at + 1, end) : [];
  c.setMoving(m => new Map(m).set(dir, { kind: open ? 'fold' : 'unfold', until: Date.now() + FOLD_MS, rows: kept }));
}

/** Shows a file the user selected: opens the closed folders above it for this session, even ones they closed. */
export function showPicked(path: string, c: TreeContext): void {
  const above = ancestors(path);
  c.setSession(s => {
    const need = closedAbove(path, c.dirs, c.big, s.picked);
    const unclose = above.filter(a => s.closed.has(a));
    if (!need.length && !unclose.length) return s;
    return { ...s, picked: edit(s.picked, need), closed: edit(s.closed, [], unclose) };
  });
  c.setFilterClosed(f => (above.some(a => f.dirs.has(a)) ? { q: f.q, dirs: edit(f.dirs, [], above) } : f));
}
