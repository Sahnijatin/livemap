import type { DomainIndex } from './domain.js';
import type { FileModel, ChangeSummary, AgentEvent, AgentSession, ControlState, Attribution } from './types.js';
export interface UsedByEntry { file: string; symbol: string; usedIn: string[] }
export type ServerMessage =
  | { type: 'hello'; root: string; name: string; files: FileModel[]; changes: ChangeSummary[]; usedBy: UsedByEntry[]; domain: DomainIndex; indexing: boolean; events: AgentEvent[]; sessions: AgentSession[]; control: ControlState }
  | { type: 'files'; files: FileModel[]; removed: string[] }
  | { type: 'change'; change: ChangeSummary }
  | { type: 'usedBy'; usedBy: UsedByEntry[] }
  | { type: 'domain'; domain: DomainIndex }
  | { type: 'indexing'; done: number; total: number }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'session'; session: AgentSession }
  | { type: 'control'; control: ControlState }
  | { type: 'attribution'; changeId: number; attribution: Attribution };
