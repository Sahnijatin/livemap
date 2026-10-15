import { useStore, type StoreState } from './store';
import { shownLayout } from './panels';
import { fitLayout, loadLayout, saveLayout } from './panelLayout';

/**
 * The docked layout's runtime, loaded after first paint (the Gate covers the workspace until the first hello anyway):
 * loads the stored layout, measures the `.app` box (safe-area insets and gutters included; jsdom has no layout, so
 * it falls back to the 12 px gutters), writes the drawn widths onto it as `--left-w` and `--right-w`, and saves the
 * layout whenever it changes outside a drag. Writing the widths here, not through React, keeps a drag or a window
 * resize from re-rendering anything but the handles. Returns the detach.
 */
export function attach(el: HTMLElement): () => void {
  useStore.getState().setLayout(loadLayout());
  let saved = useStore.getState().layout;
  let drawn = '';
  const paint = (s: StoreState) => {
    const fit = fitLayout(shownLayout(s.layout, s.peek), s.dock.width, s.dock.vw);
    const key = `${fit.files} ${fit.inspector}`;
    if (key !== drawn) {
      drawn = key;
      el.style.setProperty('--left-w', `${fit.files}px`);
      el.style.setProperty('--right-w', `${fit.inspector}px`);
    }
    if (!s.dock.dragging && s.layout !== saved) saveLayout((saved = s.layout));
  };
  const measure = () => useStore.getState().setDock({ width: el.clientWidth || window.innerWidth - 24, vw: window.innerWidth });
  measure();
  paint(useStore.getState());
  const off = useStore.subscribe(paint);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  ro?.observe(el);
  window.addEventListener('resize', measure);
  return () => {
    off();
    ro?.disconnect();
    window.removeEventListener('resize', measure);
  };
}
