import type { FileModel, ChangeSummary } from './types.js';
export interface UsedByEntry { file: string; symbol: string; usedIn: string[] }
export type ServerMessage =
  | { type: 'hello'; root: string; name: string; files: FileModel[]; changes: ChangeSummary[]; usedBy: UsedByEntry[]; indexing: boolean }
  | { type: 'files'; files: FileModel[]; removed: string[] }
  | { type: 'change'; change: ChangeSummary }
  | { type: 'usedBy'; usedBy: UsedByEntry[] }
  | { type: 'indexing'; done: number; total: number };
