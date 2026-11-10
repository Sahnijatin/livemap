import type { SummaryProvider } from './summaries.js';

/** What the Settings panel may know about AI summaries: never the key itself. */
export interface AiSettings {
  /** Turned on in the saved settings (or by `--summaries` for this run). */
  enabled: boolean;
  /** A provider is configured and in use right now. */
  active: boolean;
  provider?: SummaryProvider;
  model?: string;
  url?: string;
  monthlyTokenCap?: number;
  /** Where the key in use comes from: the saved settings, the environment, or nowhere. */
  keySource: 'config' | 'env' | 'none';
  /** Why AI is not active although it is enabled. */
  problem?: string;
}

export interface SettingsView {
  version: string;
  /** The file the AI settings are saved to. */
  configFile: string;
  ai: AiSettings;
}
