import { useEffect } from 'react';
import { isGated, useStore, type StoreState } from './store';
import { NARROW_QUERY, isNarrow, isPhone } from './media';
import { typingIn } from './keys';
import { fitLayout, reach, type Panel as Side, type PanelLayout } from './panelLayout';

type Panel = NonNullable<StoreState['panel']>;

/** Each docked panel's name in labels, its shortcut key and its element id. */
export const PANELS: Record<Side, { name: string; key: string; id: string }> = {
  files: { name: 'project panel', key: '[', id: 'sidebar' },
  inspector: { name: 'inspector', key: ']', id: 'inspector' },
};

type Shown = Pick<StoreState, 'layout' | 'peek' | 'selected' | 'files'>;
/** A selection shows a collapsed inspector while the peeked file is the selected one and exists. */
const peeking = (s: Shown): boolean => s.peek !== null && s.peek === s.selected && !!s.files[s.selected];

/**
 * The docked layout as drawn: the user's, with a collapsed inspector shown while peeking, at its normal width (a
 * widened one too: picking a file never squeezes the project panel). Nothing here is stored.
 */
export function shownLayout(s: Shown): PanelLayout {
  if (!peeking(s) || !s.layout.collapsed.inspector) return s.layout;
  const { wide: _wide, ...l } = s.layout;
  return { ...l, collapsed: { ...l.collapsed, inspector: false } };
}

export interface Drawn { l: PanelLayout; fit: Record<Side, number>; reach: Record<Side, number> }
let memo: { layout: PanelLayout; peek: boolean; dock: StoreState['dock']; v: Drawn } | undefined;
/** The shown layout and each panel's drawn width and reach, computed once per change of layout, peek or box. */
export function drawn(s: StoreState): Drawn {
  const peek = peeking(s);
  if (memo && memo.layout === s.layout && memo.peek === peek && memo.dock === s.dock) return memo.v;
  const l = shownLayout(s);
  const { width, vw } = s.dock;
  const v = { l, fit: fitLayout(l, width, vw), reach: { files: reach(l, 'files', width), inspector: reach(l, 'inspector', width) } };
  memo = { layout: s.layout, peek, dock: s.dock, v };
  return v;
}

/** Spread on a closed slide-over below 1080 px: off screen, so out of the tab order and the accessibility tree (React 18 has no `inert` prop). */
export const INERT = { inert: '' } as Record<string, unknown>;

/** Moves focus to a panel's toolbar button (when a panel that held focus hides). */
export const focusOpener = (p: Panel): void => opener(p)?.focus();
const opener = (p: Panel) => document.querySelector<HTMLElement>(`[data-panel-opener="${p}"]`);
const host = (p: Panel) => document.querySelector<HTMLElement>(`[data-panel="${p}"]`);

/**
 * Closes the open slide-over. Focus that was inside it (or on its toolbar button, or lost to the body) goes back to the
 * toolbar button that opens it, except when the layout just became wide and the panel is a shown docked column again:
 * focus that was inside it stays there.
 */
export function closePanel(): void {
  const panel = useStore.getState().panel;
  if (!panel) return;
  const active = document.activeElement as HTMLElement | null;
  const box = host(panel);
  const btn = opener(panel);
  const inside = !!active && !!box?.contains(active);
  const owned = inside || !active || active === document.body || active === btn;
  useStore.getState().setPanel(null);
  const s = useStore.getState();
  if (owned && !(inside && !isNarrow() && !shownLayout(s).collapsed[panel])) btn?.focus();
}

/** Where the slide-overs go after a file is picked in the sidebar: closed below 1080 px, the inspector on a phone. Undefined: leave as is. */
export function panelAfterSelect(): 'inspector' | null | undefined {
  if (isPhone()) return 'inspector';
  if (isNarrow()) return null;
  return undefined;
}

/** Applies panelAfterSelect. Opening the inspector hands it focus once it has rendered (see useSlideOvers). */
export function afterSelect(): void {
  const next = panelAfterSelect();
  if (next === undefined) return;
  if (next === null) closePanel();
  else useStore.getState().setPanel(next);
}

/**
 * Collapses or expands a docked panel (1080 px and wider). Focus inside a panel that collapses, or on its resize
 * handle, moves to the panel's toolbar button.
 */
export function setCollapsed(p: Panel, on: boolean): void {
  const active = document.activeElement;
  const lost = on && !!active && (!!host(p)?.contains(active) || active.closest('[data-handle]')?.getAttribute('data-handle') === p);
  useStore.getState().collapse(p, on);
  if (lost) opener(p)?.focus();
}

/**
 * The toolbar Files and Inspector buttons and the [ ] keys: below 1080 px, open that slide-over, or close it when it
 * is the open one; wider, collapse or expand the docked panel.
 */
export function togglePanel(p: Panel): void {
  const s = useStore.getState();
  if (!isNarrow()) setCollapsed(p, !shownLayout(s).collapsed[p]);
  else if (s.panel === p) closePanel();
  else s.setPanel(p);
}

/**
 * The panel wiring for App: [ and ] toggle the project panel and the inspector (not while typing or with the palette
 * open). Esc closes the open slide-over (unless the palette is open, which closes first), and
 * a resize to 1080 px or wider closes it, so no scrim is left over a docked layout (Review Focus 4). A panel that
 * opens takes focus after React commits, when it is no longer inert and whatever held focus behind it (the center
 * pane, the other panel) has become inert.
 */
export function useSlideOvers(): void {
  const panel = useStore(s => s.panel);
  useEffect(() => {
    if (!panel) return;
    const box = host(panel);
    if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
  }, [panel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.key === 'Escape' && s.panel && !s.paletteOpen && !e.defaultPrevented) closePanel();
      // The [ and ] keys as typed (e.key), so layouts that type them with AltGr, Option or Shift work; not Meta or Ctrl
      // shortcuts (AltGr reports Ctrl and Alt). Not while the Gate is up, the palette is open, or focus is in a form control.
      if ((e.key === '[' || e.key === ']') && !e.metaKey && !(e.ctrlKey && !e.altKey) && !e.repeat && !e.defaultPrevented && !s.paletteOpen
        && !isGated(s) && !typingIn(e.target instanceof Element ? e.target : document.activeElement, { controls: true })) {
        e.preventDefault();
        togglePanel(e.key === '[' ? 'files' : 'inspector');
      }
    };
    window.addEventListener('keydown', onKey);
    const mq = window.matchMedia?.(NARROW_QUERY);
    const onChange = (e: { matches: boolean }) => { if (!e.matches) closePanel(); };
    mq?.addEventListener?.('change', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      mq?.removeEventListener?.('change', onChange);
    };
  }, []);
}
