/**
 * Hook events that can block the agent's next step. Shared by the hook script (bundled standalone,
 * so this file imports nothing at runtime) and `normalizeHook`.
 */
import type { AgentKind } from './types.js';

export function isBlockable(agent: AgentKind, event: string): boolean {
  if (agent === 'cursor') return event === 'preToolUse' || event === 'beforeShellExecution';
  return (agent === 'claude-code' || agent === 'codex') && event === 'PreToolUse';
}

/** Stop events: the agent finished its turn, and the hook's answer can hand it a follow-up instruction. */
export function isStop(agent: AgentKind, event: string): boolean {
  if (agent === 'cursor') return event === 'stop';
  return (agent === 'claude-code' || agent === 'codex') && event === 'Stop';
}
