import { useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useTheme } from '../theme';
import { setPaused } from '../api';
import { AgentChips } from './AgentChips';
import { useLiveState } from './Activity';
import { MenuIcon, MoonIcon, PanelIcon, PauseIcon, PlayIcon, SunIcon } from './icons';

function StatusChip() {
  const connection = useStore(s => s.connection);
  const indexing = useStore(s => s.indexing);
  const loaded = useStore(s => s.loaded);

  let dot = <i className="dot" />;
  let label = 'Connecting';
  let detail = '';
  if (connection === 'unauthorized') {
    dot = <i className="dot bad" />;
    label = 'Key needed';
  } else if (connection === 'open' && indexing) {
    dot = <span className="spinner" />;
    label = 'Indexing';
    detail = indexing.total ? `${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}` : '';
  } else if (connection === 'open' && loaded) {
    dot = <i className="dot live" />;
    label = 'Live';
    detail = 'watching';
  } else if (connection === 'closed') {
    dot = <i className="dot warn" />;
    label = 'Reconnecting';
  }
  return (
    <span className="statuschip" role="status" aria-live="polite">
      {dot}
      <span>{label}</span>
      {detail && <span className="st">{detail}</span>}
    </span>
  );
}

/** "Now: <current step>" next to the agent chips while an agent works. */
function NowLine() {
  const { step, working, paused, session } = useLiveState();
  if (!session) return null;
  const active = working && !paused;
  return (
    <span className={clsx('now', !active && 'idle')} aria-live="off">
      {paused ? 'Paused: ' : active ? 'Now: ' : 'Last: '}<b>{step.line}</b>
    </span>
  );
}

/** Pause agent / Resume agent; a failure shows inline under the button until the next attempt. */
export function PauseButton() {
  const paused = useStore(s => s.control.paused);
  const showToast = useStore(s => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = paused ? 'Resume agent' : 'Pause agent';
  const click = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setPaused(!paused);
      showToast(paused ? 'Resumed. Agents can carry on.' : 'Paused. Agents stop at their next action and wait.');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not reach LiveMap');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="pausewrap">
      <button type="button" className={clsx('pillbtn pause', paused && 'on')} onClick={click} disabled={busy} aria-pressed={paused} aria-label={label} title={label}>
        {paused ? <PlayIcon /> : <PauseIcon />}<span>{label}</span>
      </button>
      {error && <span className="pause-err" role="alert">{error}</span>}
    </span>
  );
}

export function Toolbar() {
  const name = useStore(s => s.name);
  const root = useStore(s => s.root);
  const panel = useStore(s => s.panel);
  const setPanel = useStore(s => s.setPanel);
  const { theme, toggle } = useTheme();
  const home = root.replace(/^\/(Users|home)\/[^/]+/, '~');
  const parent = home.includes('/') ? home.slice(0, home.lastIndexOf('/')) || '/' : '';

  return (
    <header className="toolbar glass">
      <button
        className="iconbtn only-narrow"
        aria-label="Files"
        aria-expanded={panel === 'files'}
        onClick={() => setPanel(panel === 'files' ? null : 'files')}
      >
        <MenuIcon />
      </button>
      <span className="brand"><i className="mark" aria-hidden="true" /><span>LiveMap</span></span>
      <span className="sep" aria-hidden="true" />
      {name && (
        <span className="projname" title={root}>
          <span className="truncate">{name}</span>
          {parent && <small>{parent}</small>}
        </span>
      )}
      <StatusChip />
      <AgentChips />
      <span className="grow"><NowLine /></span>
      <button className="iconbtn" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      <button
        className="iconbtn only-narrow"
        aria-label="Inspector"
        aria-expanded={panel === 'inspector'}
        onClick={() => setPanel(panel === 'inspector' ? null : 'inspector')}
      >
        <PanelIcon />
      </button>
      <PauseButton />
    </header>
  );
}
