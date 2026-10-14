import { useMemo } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { agentName, chipSessions } from '../agents';
import { useNow } from '../recent';
import { Avatar } from './Avatar';

const MAX_CHIPS = 3;

const STEER_HINT = 'Run livemap init to steer this agent';

/**
 * One chip per agent session active in the last 30 minutes; a working agent gets a spinning ring.
 * Pause applies only to sessions wired with hooks; the others say they are not connected.
 */
export function AgentChips() {
  const sessions = useStore(s => s.sessions);
  const paused = useStore(s => s.control.paused);
  const now = useNow(15_000);
  const list = useMemo(() => chipSessions(sessions, now), [sessions, now]);
  if (!list.length) return null;
  const shown = list.slice(0, MAX_CHIPS);
  return (
    <div className="agentchips" role="list" aria-label="Agents">
      {shown.map(s => {
        const working = s.status === 'working';
        const state = working ? (paused && s.hooks ? 'paused' : 'working') : 'idle';
        return (
          <span role="listitem" key={s.id} className={clsx('agentchip pop', state)} title={`${agentName(s.agent)}: ${s.title}${s.hooks ? '' : `. ${STEER_HINT}`}`}>
            <Avatar agent={s.agent} className={clsx(state === 'working' && 'ring')} />
            <span className="lab">{agentName(s.agent)}</span>
            <span className="st">{state}</span>
            {!s.hooks && <span className="nc" title={STEER_HINT}>not connected</span>}
          </span>
        );
      })}
      {list.length > MAX_CHIPS && <span role="listitem" className="agentchip more">+{list.length - MAX_CHIPS}</span>}
    </div>
  );
}
