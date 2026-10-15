import { createContext, useContext } from 'react';
import type { Dir } from './mapFlow';
import type { Spawn } from './useNodeMotion';

/** What map cards and head tools can ask the map to do. The value is stable for the view's life. */
export interface MapActions {
  /** Select a file (opens the inspector; the slide-over at narrow widths). */
  open(path: string): void;
  /** From the folders level: show that folder's files (expanding it in a large project) and fit to it. */
  openFolder(id: string): void;
  /** Large projects: show or hide a folder's files. */
  toggleFolder(id: string): void;
  /** Move keyboard focus to the nearest card in a direction. */
  focusNeighbor(from: string, dir: Dir): void;
  /** Forget pins and computed positions, then lay the map out again. */
  resetLayout(): void;
  /** Fit the whole map in view. */
  fitAll(): void;
  /** For a card mounting now: where it springs in from (new files only), or null. */
  spawnOf(id: string): Spawn | null;
}

const noop = () => {};
export const MapContext = createContext<MapActions>({
  open: noop, openFolder: noop, toggleFolder: noop, focusNeighbor: noop, resetLayout: noop, fitAll: noop, spawnOf: () => null,
});

export const useMapActions = (): MapActions => useContext(MapContext);
