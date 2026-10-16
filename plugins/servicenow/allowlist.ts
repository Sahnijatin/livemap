/**
 * LiveMap is read-only on every ServiceNow instance. These are the only nexus tools it may call,
 * directly or as the inner tool of `tool_execute`. `tool_search` only finds and enables tools; nexus
 * often needs it before `tool_execute` will run one.
 */
export const READ_ONLY_TOOLS: readonly string[] = Object.freeze([
  'sn_query_table',
  'sn_get_table_metadata',
  'sn_get_instance_info',
  'sn_session_context',
  'tool_search',
]);

const ALLOWED = new Set(READ_ONLY_TOOLS);
/** The gateway that runs another tool named by its `tool` arg. */
export const GATEWAY = 'tool_execute';

export class NotAllowedError extends Error {
  constructor(readonly tool: string) {
    super(`LiveMap is read-only: the nexus tool "${tool}" is not on its allowlist`);
    this.name = 'NotAllowedError';
  }
}

/**
 * Throws NotAllowedError unless the call is on the allowlist. A `tool_execute` call is checked by its inner
 * tool, which must itself be allowed and must not be another gateway.
 */
export function assertReadOnly(tool: string, args: unknown): void {
  if (tool === GATEWAY) {
    const inner = args && typeof args === 'object' ? (args as { tool?: unknown }).tool : undefined;
    if (typeof inner !== 'string' || inner === GATEWAY || !ALLOWED.has(inner)) throw new NotAllowedError(`${GATEWAY}(${String(inner)})`);
    return;
  }
  if (!ALLOWED.has(tool)) throw new NotAllowedError(tool);
}
