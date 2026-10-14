import { useEffect } from 'react';
import { useStore, type StoreState } from './store';
import { NARROW_QUERY, isNarrow, isPhone } from './media';

type Panel = NonNullable<StoreState['panel']>;

/** Spread on a closed slide-over below 1080 px: off screen, so out of the tab order and the accessibility tree (React 18 has no `inert` prop). */
export const INERT = { inert: '' } as Record<string, unknown>;

const opener = (p: Panel) => document.querySelector<HTMLElement>(`[data-panel-opener="${p}"]`);
const host = (p: Panel) => document.querySelector<HTMLElement>(`[data-panel="${p}"]`);

/**
 * Closes the open slide-over. Focus that was inside it (or on its toolbar button, or lost to the body) goes back to the
 * toolbar button that opens it. When that button is hidden (the layout just became wide, so the panel is a docked
 * column again), focus that was inside the panel stays there, and otherwise lands on the docked panel itself.
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
  if (!owned) return;
  btn?.focus();
  if (btn && document.activeElement === btn) return;
  if (!inside) box?.focus();
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

/** The toolbar Files and Inspector buttons: open that slide-over, or close it when it is the open one. */
export function togglePanel(p: Panel): void {
  if (useStore.getState().panel === p) closePanel();
  else useStore.getState().setPanel(p);
}

/**
 * The slide-over wiring for App: Esc closes the open panel (unless the palette is open, which closes first), and
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
