import type { ServerMessage } from './protocol.js';
import type { ProjectState } from './state.js';

/** The id of the script element an export embeds its payload in (gzip JSON, base64). */
export const EXPORT_DATA_ID = 'livemap-data';

/**
 * What `livemap export` embeds: the project name (never its absolute path), the state before the first
 * message, the messages as [seq, at, msg], and the current text of the files they touch unless `--no-code`.
 */
export interface ExportPayload {
  version: 1;
  name: string;
  exportedAt: number;
  initial: ProjectState;
  messages: [number, number, ServerMessage][];
  code?: Record<string, string>;
}
