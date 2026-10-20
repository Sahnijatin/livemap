import type { Pos } from '../layout/elk';
import type { Level } from './mapModel';
import { dict } from '../dict';

/**
 * Positions the user dragged nodes to. File cards by path, kept per level (`files` at the files level,
 * `functions` at the functions level, where cards are taller); folder cards (folders level only) by folder id.
 * Pins stored before levels had their own load as files-level pins.
 */
export type Pins = { files: Record<string, Pos>; functions: Record<string, Pos>; folders: Record<string, Pos> };

export const pinsKey = (root: string): string => `livemap:pins:${root}`;

/** No pins. Each record is a `dict`, so a file named `__proto__` or `constructor` keeps its pin. */
export const emptyPins = (): Pins => ({ files: dict(), functions: dict(), folders: dict() });
const NONE: Record<string, Pos> = Object.freeze(dict<Pos>());

/** Which pins hold file cards at `level`. */
export const fileKind = (level: Level): 'files' | 'functions' => (level === 'functions' ? 'functions' : 'files');

/** The file-card pins that apply at `level` (none at the folders level, which draws no file cards). */
export const filePins = (pins: Pins, level: Level): Record<string, Pos> =>
  level === 'folders' ? NONE : pins[fileKind(level)];

function positions(v: unknown): Record<string, Pos> {
  const out = dict<Pos>();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    const q = p as Partial<Pos> | null;
    if (q && typeof q === 'object' && Number.isFinite(q.x) && Number.isFinite(q.y)) out[k] = { x: q.x!, y: q.y! };
  }
  return out;
}

/** The project's pins; empty when storage is missing, blocked, throws or holds something unreadable. */
export function loadPins(root: string): Pins {
  try {
    const raw = globalThis.localStorage?.getItem(pinsKey(root));
    if (!raw) return emptyPins();
    const v = JSON.parse(raw) as { files?: unknown; functions?: unknown; folders?: unknown } | null;
    if (!v || typeof v !== 'object') return emptyPins();
    return { files: positions(v.files), functions: positions(v.functions), folders: positions(v.folders) };
  } catch {
    return emptyPins();
  }
}

/** Store the project's pins (the caller debounces this by 300 ms). Storage errors are ignored. */
export function savePins(root: string, pins: Pins): void {
  try {
    globalThis.localStorage?.setItem(pinsKey(root), JSON.stringify(pins));
  } catch {
    // Private mode, quota or blocked storage: pins last for this page only.
  }
}

export function resetPins(root: string): void {
  try {
    globalThis.localStorage?.removeItem(pinsKey(root));
  } catch {
    // Nothing stored that we can reach.
  }
}
