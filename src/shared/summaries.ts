/** Summary engine shapes shared by the server (`src/summarize`) and the UI. No node imports. */

export type SummaryProvider = 'anthropic' | 'openai' | 'ollama';

/** A resolved, enabled configuration. `apiKey` never leaves the server. */
export interface SummaryConfig {
  provider: SummaryProvider;
  apiKey?: string;
  model: string;
  url?: string;
  monthlyTokenCap: number;
}

/** What the UI may know about the summarizer: never the key. */
export interface SummaryStatus {
  state: 'off' | 'ready' | 'working' | 'error' | 'cap';
  provider?: SummaryProvider;
  model?: string;
  usedTokens: number;
  capTokens: number;
  /** `YYYY-MM` the usage counts against. */
  month: string;
  error?: string;
}

export const DEFAULT_MONTHLY_TOKEN_CAP = 2_000_000;

/** A file's AI summary and the symbol-set hash it was written for. */
export interface FileSummary { hash: string; summary: string }

/** What a client holds about summaries: the engine status and file summaries by path. */
export interface SummariesState { status: SummaryStatus; files: Record<string, FileSummary> }

/** The status while summaries are disabled. `month` is empty when unknown. */
export function offStatus(month = ''): SummaryStatus {
  return { state: 'off', usedTokens: 0, capTokens: DEFAULT_MONTHLY_TOKEN_CAP, month };
}

export function emptySummaries(): SummariesState {
  return { status: offStatus(), files: {} };
}
