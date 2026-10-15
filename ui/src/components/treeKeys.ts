import type { KeyboardEvent } from 'react';
import { dirKey, type Item } from '../treeModel';

/** Typed letters within this long of each other search as one prefix. */
const TYPEAHEAD_MS = 700;

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
  typed: { text: string; at: number };
}

/**
 * The file tree's keys, loaded after first paint (FileTree): Up/Down/Home/End move, Right opens or enters, Left
 * closes or goes up, and typing a name moves to the next row that starts with it.
 */
export function treeKeyDown(e: KeyboardEvent<HTMLElement>, c: TreeKeyContext): void {
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
      // Typeahead: letters and digits move to the next row whose name starts with what was typed.
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !/^[\p{L}\p{N}._-]$/u.test(e.key)) return;
      const now = Date.now();
      const t = c.typed;
      t.text = now - t.at < TYPEAHEAD_MS ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      // Names per row: a file's name, or each folder of a compact row (typing "app" finds src/app).
      const names = new Map<string, string[]>();
      for (const it of c.items) {
        if (it.kind === 'dir') names.set(dirKey(it.node.path), it.label.toLowerCase().split('/'));
        else if (it.kind === 'file') names.set(it.row.file.path, [it.row.name.toLowerCase()]);
      }
      const from = t.text.length > 1 ? i : i + 1;
      for (let n = 0; n < navKeys.length; n++) {
        const j = (from + n) % navKeys.length;
        if (names.get(navKeys[j])?.some(name => name.startsWith(t.text))) { focusAt(j); break; }
      }
    }
  }
  e.preventDefault();
}
