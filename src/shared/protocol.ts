import type { FileModel, ChangeSummary, AgentEvent, AgentSession, ControlState, Attribution } from './types.js';
export interface UsedByEntry { file: string; symbol: string; usedIn: string[] }
export type ServerMessage =
  | { type: 'hello'; root: string; name: string; files: FileModel[]; changes: ChangeSummary[]; usedBy: UsedByEntry[]; indexing: boolean; events: AgentEvent[]; sessions: AgentSession[]; control: ControlState }
  | { type: 'files'; files: FileModel[]; removed: string[] }
  /** A change and the file updates it caused, applied together. */
  | { type: 'change'; change: ChangeSummary; files: FileModel[]; removed: string[] }
  | { type: 'usedBy'; usedBy: UsedByEntry[] }
  | { type: 'indexing'; done: number; total: number }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'session'; session: AgentSession }
  | { type: 'control'; control: ControlState }
  | { type: 'attribution'; changeId: number; attribution: Attribution };
