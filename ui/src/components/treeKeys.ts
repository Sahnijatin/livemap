import { dirKey, type Item } from '../treeModel';

/** Typed letters within this long of each other search as one prefix. */
const TYPEAHEAD_MS = 700;

/** What the handler reads from a key event (a replayed key has only these). */
export interface KeyPress { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault(): void }

export interface TreeKeyContext {
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
 * The file tree's keys, loaded after first paint (FileTree): Up/Down/Home/End move, Right opens or enters, Left
 * closes or goes up, and typing a name moves to the next row that starts with it.
 */
export function treeKeyDown(e: KeyPress, c: TreeKeyContext): void {
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
      // Typeahead: any printable character (AltGr ones too), not Space, which presses the row. A key that matches
      // no row is left alone, so `[` with no `[...]` row still toggles the file panel.
      if (e.key.length !== 1 || e.key === ' ' || e.metaKey || (e.ctrlKey && !e.altKey)) return;
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
