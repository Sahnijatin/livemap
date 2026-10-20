import clsx from 'clsx';
import type { AgentEvent } from '@shared/types.js';
import { useStore } from '../store';
import { activeSession, agentName, ago, isMerge, latestMessage } from '../agents';
import { layerOf } from '../layers';
import { baseName, isRecent, useNow } from '../recent';
import { removeFlag } from '../api';
import { READ_ONLY_TIP } from '../history';
import { COUNTER_LABELS, CountUp, liveFlags, useLiveState } from './Activity';
import { FlagBox } from './FlagBox';
import { FlagIcon, GitIcon, LayerTile } from './icons';

function YourFlags() {
  const flags = useStore(s => s.control.flags);
  const select = useStore(s => s.select);
  const showToast = useStore(s => s.showToast);
  const replay = useStore(s => s.replay);
  // While the UI shows the past, flags (which act on the live agent) are read-only, as in FlagBox.
  const rewound = useStore(s => s.rewound !== null);
  if (!flags.length) return null;
  const sorted = [...flags].sort((a, b) => Number(!!a.deliveredAt) - Number(!!b.deliveredAt) || b.createdAt - a.createdAt).slice(0, 12);
  return (
    <div className="sec">
      <h4>Your flags</h4>
      <div className="flaglist">
        {sorted.map(f => (
          <div className={clsx('flagrow fi', f.deliveredAt && 'done')} key={f.id}>
            <span className="fl-ic"><FlagIcon /></span>
            <div className="fl-tx">
              {f.target
                ? <button type="button" className="linkbtn" onClick={() => select(f.target)} title={f.target}>{baseName(f.target)}</button>
                : <b>Project</b>}
              <span>{f.note}</span>
              <small>{f.deliveredAt ? `Delivered to ${agentName(f.deliveredTo?.agent)}` : 'Waiting for the next action'}</small>
            </div>
            {!f.deliveredAt && !replay && (
              <button type="button" className="fl-x" aria-label={`Remove flag: ${f.note}`} disabled={rewound} title={rewound ? READ_ONLY_TIP : undefined} onClick={() => removeFlag(f.id).catch(e => showToast(e instanceof Error ? e.message : 'Could not remove the flag', 'error'))}>×</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The latest commits LiveMap saw (merges left out), so work done through git shows even without an agent. */
function RecentCommits({ events, now }: { events: AgentEvent[]; now: number }) {
  const commits: AgentEvent[] = [];
  for (let i = events.length - 1; i >= 0 && commits.length < 5; i--) {
    if (events[i].type === 'commit' && !isMerge(events[i])) commits.push(events[i]);
  }
  if (!commits.length) return null;
  return (
    <div className="sec">
      <h4>Recent commits</h4>
      <div className="gitlist">
        {commits.map(c => {
          const n = c.paths?.length;
          return (
            <div className="gitrow fi" key={c.id} title={c.text}>
              <span className="gic"><GitIcon /></span>
              <b>{(c.text ?? '').split('\n')[0] || 'Commit'}</b>
              <small>{[c.sessionId, n !== undefined && `${n} file${n === 1 ? '' : 's'}`, ago(c.at, now)].filter(Boolean).join(' · ')}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The Live session view's header (in the Inspector's bar, above the scrolling view): its title and Live or Paused tag. */
export function LiveHead() {
  // Showing the past: no Live tag (the center's banner says what is on show).
  const rewound = useStore(s => s.rewound !== null);
  // useLiveState's rule on narrow selectors, without its event scans.
  const working = useStore(s => liveFlags(activeSession(s.sessions), s.control.paused).working);
  const paused = useStore(s => liveFlags(activeSession(s.sessions), s.control.paused).paused);
  return (
    <div className="live-h"><h3>Live session</h3>{working && !paused && !rewound && <span className="livetag"><i />Live</span>}{paused && <span className="livetag paused"><i />Paused</span>}</div>
  );
}

/** Inspector overview when nothing is selected: what the agent is doing and how to steer it. */
export function LiveSession() {
  const files = useStore(s => s.files);
  const recent = useStore(s => s.recent);
  const events = useStore(s => s.events);
  const select = useStore(s => s.select);
  const replay = useStore(s => s.replay);
  const { session, step, counts, working, paused } = useLiveState();
  const now = useNow();
  const msg = latestMessage(events, session?.id);
  const recentPaths = Object.entries(recent)
    .filter(([p]) => files[p])
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 8);

  return (
    <>
      <div className={clsx('nowcard', working && !paused && 'working')}>
        <span className="lbl">{working && !paused ? <span className="spinner" aria-hidden="true" /> : <i className="ndot" aria-hidden="true" />}<span className="truncate">{step.line}</span></span>
        <p>{msg?.text ? msg.text.slice(0, 600) : session ? `${agentName(session.agent)} has not said anything yet.` : 'No agent has worked in this project since LiveMap started. Start one to watch it here.'}</p>
      </div>
      <div className="mstats">
        {COUNTER_LABELS.map(([k, l]) => <div className="mstat" key={k}><b><CountUp value={counts[k]} /></b><span>{l.charAt(0).toUpperCase() + l.slice(1)}</span></div>)}
      </div>
      <RecentCommits events={events} now={now} />
      <div className="sec">
        <h4>Recently changed</h4>
        <div className="recent">
          {recentPaths.length ? recentPaths.map(([p, r]) => (
            <button type="button" className="rrow fi" key={p} onClick={() => select(p)} title={p}>
              <LayerTile layer={layerOf(p, files[p])} />
              <code>{baseName(p)}</code>
              {isRecent(r, now) && <span className={clsx('badge', r.kind === 'created' ? 'b-new' : 'b-edit')}>{r.kind === 'created' ? 'New' : 'Edited'}</span>}
            </button>
          )) : <div className="muted">Nothing yet. Edits show up here as they happen.</div>}
        </div>
      </div>
      <YourFlags />
      {!replay && (
        <div className="sec">
          <h4>Flag the project</h4>
          <FlagBox target={null} />
        </div>
      )}
      <div className="muted" style={{ fontSize: 12 }}>Select any file to see what is inside it, what it connects to, and why it changed.</div>
    </>
  );
}
