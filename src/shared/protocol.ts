import type { DomainIndex } from './domain.js';
import type { SummariesState, SummaryStatus } from './summaries.js';
import type { FileModel, ChangeSummary, AgentEvent, AgentSession, ControlState, Attribution } from './types.js';
export interface UsedByEntry { file: string; symbol: string; usedIn: string[] }
/**
 * The recording's status: the seq range on disk and its times; `error` once recording has stopped. `off` marks
 * history the user turned off (`--no-history`, so the server has no store), as opposed to a failure, which
 * carries `error` instead. Both are absent while recording.
 */
export interface HistoryStatus { enabled: boolean; first: number; last: number; firstAt: number; lastAt: number; error?: string; off?: true }
export type ServerMessage =
  | { type: 'hello'; root: string; name: string; files: FileModel[]; changes: ChangeSummary[]; usedBy: UsedByEntry[]; domain: DomainIndex; indexing: boolean; events: AgentEvent[]; sessions: AgentSession[]; control: ControlState;
      /**
       * Recording status, and the last recorded seq this hello's state includes. Optional so that project
       * state (`ProjectState`, which omits both) and older hellos still type-check; the server always sends them.
       */
      history?: HistoryStatus; seq?: number;
      /** Summary status and file summaries. Optional so that older recorded hellos still load; the server always sends it. */
      summaries?: SummariesState }
  | { type: 'files'; files: FileModel[]; removed: string[] }
  /** A change and the file updates it caused, applied together. */
  | { type: 'change'; change: ChangeSummary; files: FileModel[]; removed: string[] }
  | { type: 'usedBy'; usedBy: UsedByEntry[] }
  | { type: 'domain'; domain: DomainIndex }
  | { type: 'indexing'; done: number; total: number }
  | { type: 'agentEvent'; event: AgentEvent }
  | { type: 'session'; session: AgentSession }
  | { type: 'control'; control: ControlState }
  | { type: 'attribution'; changeId: number; attribution: Attribution }
  /** An AI one-liner for a change; sets `ChangeSummary.summary`. */
  | { type: 'summary'; changeId: number; summary: string }
  /** An AI summary of a file, for the symbol set `hash` names. An empty `hash` clears the file's summary (outdated or deleted). */
  | { type: 'fileSummary'; path: string; hash: string; summary: string }
  /** The summarizer's status; never recorded. */
  | { type: 'summaryStatus'; status: SummaryStatus }
  /** Recording status; never recorded itself. */
  | { type: 'history'; history: HistoryStatus };

/**
 * A message as the socket carries it: a recorded message is stamped with the seq the history store gave
 * it (absent when recording is off, and on `indexing`, `history` and `summaryStatus`). Recorded messages and history
 * records never carry it; only the live envelope does.
 */
export type WireMessage = ServerMessage & { seq?: number };
