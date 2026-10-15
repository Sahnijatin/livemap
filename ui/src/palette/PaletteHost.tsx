import { Suspense, lazy, useEffect, useState } from 'react';
import { useStore } from '../store';

// The palette (cmdk, Radix Dialog, the search index) loads on first open, so Activity's first paint does not pay for it.
const load = () => import('./Palette');
const Palette = lazy(load);

/** Start loading the palette early (toolbar button hover or focus). */
export function preloadPalette(): void {
  void load();
}

/** A text field other than the palette's own input: ⌘K there belongs to the field. */
function typingElsewhere(el: Element | null): boolean {
  if (!el || el.closest('[cmdk-dialog]')) return false;
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
}

/** ⌘K or Ctrl+K anywhere opens (or closes) the palette; the palette itself mounts on first open and stays. */
export function PaletteHost() {
  const open = useStore(s => s.paletteOpen);
  // While the gate covers the workspace (key needed, or loading) there is nothing to search: close and stay closed.
  const gated = useStore(s => s.connection === 'unauthorized' || !s.loaded);
  const [mounted, setMounted] = useState(open);
  useEffect(() => { if (open) setMounted(true); }, [open]);
  useEffect(() => { if (gated && open) useStore.getState().setPalette(false); }, [gated, open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || (e.key.toLowerCase() !== 'k' && e.code !== 'KeyK')) return; // KeyK: Ctrl+K on Cyrillic, Greek or Hebrew layouts
      const s = useStore.getState();
      if (s.connection === 'unauthorized' || !s.loaded) return;
      const target = e.target instanceof Element ? e.target : document.activeElement;
      if (typingElsewhere(target)) return;
      // A held-down ⌘K would flicker the palette open and shut.
      if (e.repeat) { e.preventDefault(); return; }
      e.preventDefault();
      s.setPalette(!s.paletteOpen);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (gated || (!mounted && !open)) return null;
  return <Suspense fallback={null}><Palette /></Suspense>;
}
