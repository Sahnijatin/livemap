import clsx from 'clsx';
import type { AgentKind } from '@shared/types.js';
import { AGENTS } from '../agents';

/** Round agent avatar (C Claude Code, X Codex, U Cursor, G git), colored per agent. */
export function Avatar({ agent, className }: { agent: AgentKind | null | undefined; className?: string }) {
  const a = agent ?? 'other';
  return <span className={clsx('av', `av-${a}`, className)} aria-hidden="true">{AGENTS[a]?.letter ?? 'A'}</span>;
}
