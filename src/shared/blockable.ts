/**
 * Hook events that can block the agent's next step. Shared by the hook script (bundled standalone,
 * so this file imports nothing at runtime) and `normalizeHook`.
 */
import type { AgentKind } from './types.js';

export function isBlockable(agent: AgentKind, event: string): boolean {
  if (agent === 'cursor') return event === 'preToolUse' || event === 'beforeShellExecution';
  return (agent === 'claude-code' || agent === 'codex') && event === 'PreToolUse';
}
