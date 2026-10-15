import { useEffect, useMemo, useRef } from 'react';
import type { Pos } from '../layout/elk';
import { loadPins, resetPins, savePins, type Pins } from './pins';

/** Pins are written this long after the last drop. */
export const SAVE_DELAY = 300;

export interface PinStore {
  /** The project's current pins (read at call time). */
  get(): Pins;
  /** Pin a file, or a folder card, and save soon. */
  pin(kind: keyof Pins, id: string, p: Pos): void;
  /** Forget every pin of the project, in memory and in storage. */
  reset(): void;
}

/**
 * The project's pins, loaded when the project changes and saved `SAVE_DELAY` ms after the last drop.
 * A pending save is written when the project changes or the view unmounts.
 */
export function usePins(root: string): PinStore {
  // Read storage once per project (a lazy ref, not a parse on every render).
  const state = useRef<{ root: string; pins: Pins } | null>(null);
  state.current ??= { root, pins: loadPins(root) };
  const timer = useRef<number | null>(null);

  const { store, flush } = useMemo(() => {
    const flush = () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
      savePins(state.current!.root, state.current!.pins);
    };
    const store: PinStore = {
      get: () => state.current!.pins,
      pin(kind, id, p) {
        const cur = state.current!.pins;
        state.current!.pins = { ...cur, [kind]: { ...cur[kind], [id]: { x: p.x, y: p.y } } };
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, SAVE_DELAY);
      },
      reset() {
        if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
        resetPins(state.current!.root);
        state.current!.pins = { files: {}, functions: {}, folders: {} };
      },
    };
    return { store, flush };
  }, []);

  useEffect(() => {
    if (state.current!.root !== root) state.current = { root, pins: loadPins(root) };
    // Leaving this project (or unmounting): write its pending pins first.
    return flush;
  }, [root, flush]);

  return store;
}
