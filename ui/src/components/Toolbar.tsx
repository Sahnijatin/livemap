import { useState, type MouseEvent } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { useTheme } from '../theme';
import { setPaused } from '../api';
import { READ_ONLY_TIP } from '../history';
import { AgentChips } from './AgentChips';
import { useLiveState } from './Activity';
import { preloadPalette } from '../palette/PaletteHost';
import { PANELS, shownLayout, togglePanel } from '../panels';
import { NARROW_QUERY, useMedia } from '../media';
import type { Panel } from '../panelLayout';
import { MenuIcon, GearIcon, MoonIcon, PanelIcon, PauseIcon, PlayIcon, SearchIcon, SidebarIcon, SunIcon } from './icons';

export function StatusChip() {
  const connection = useStore(s => s.connection);
  const replay = useStore(s => s.replay);
  const indexing = useStore(s => s.indexing);
  const loaded = useStore(s => s.loaded);
  const rewound = useStore(s => s.rewound !== null);
  const offline = useStore(s => s.source?.state === 'offline');

  let dot = <i className="dot" />;
  let label = 'Connecting';
  let detail = '';
  if (replay) {
    label = 'Replay';
  } else if (connection === 'unauthorized') {
    dot = <i className="dot bad" />;
    label = 'Key needed';
  } else if (connection === 'open' && indexing) {
    dot = <span className="spinner" />;
    label = 'Indexing';
    detail = indexing.total ? `${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}` : '';
  } else if (rewound) {
    // Showing the past: not Live, whatever the socket says.
    dot = <i className="dot" />;
    label = 'Rewound';
  } else if (connection === 'open' && loaded && offline) {
    // The source (a ServiceNow instance) is unreachable: the map shows its last mirror.
    dot = <i className="dot warn" />;
    label = 'Offline';
    detail = 'instance offline';
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
  const rewound = useStore(s => s.rewound !== null);
  const replay = useStore(s => s.replay);
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
  if (replay) return null;
  return (
    // The wrapper carries the tooltip too: some browsers show none for a disabled button.
    <span className="pausewrap" title={rewound ? READ_ONLY_TIP : undefined}>
      <button type="button" className={clsx('pillbtn pause', paused && 'on', rewound && 'ro')} onClick={click} disabled={busy || rewound} aria-pressed={paused} aria-label={label} title={rewound ? READ_ONLY_TIP : label}>
        {paused ? <PlayIcon /> : <PauseIcon />}<span>{label}</span>
      </button>
      {error && <span className="pause-err" role="alert">{error}</span>}
    </span>
  );
}

const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

/** "Search everything ⌘K": opens the palette (also while focus is in a text field); icon-only on phones. */
export function SearchButton() {
  const setPalette = useStore(s => s.setPalette);
  const mac = isMac();
  return (
    <button
      type="button"
      className="pillbtn search"
      aria-label="Search everything"
      aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
      title={`Search everything (${mac ? '⌘K' : 'Ctrl+K'})`}
      onClick={() => setPalette(true)}
      onMouseEnter={preloadPalette}
      onFocus={preloadPalette}
    >
      <SearchIcon />
      <span className="sl">Search everything</span>
      <span className="kbd" aria-hidden="true">{mac ? '⌘K' : 'Ctrl K'}</span>
    </button>
  );
}

/** Copies text: the Clipboard API, else a selected off-screen field and execCommand (focus then returns to `back`). Resolves to whether it worked. */
async function copyText(text: string, back: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable (for example over plain http): fall through.
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(field);
  try {
    field.focus();
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    back.focus();
  }
}

/** The project chip (prototype `.projsel`): name and folder. One project per run, so no menu: a click copies the root path. */
export function ProjectChip() {
  const name = useStore(s => s.name);
  const root = useStore(s => s.root);
  const showToast = useStore(s => s.showToast);
  if (!name) return null;
  const home = root.replace(/^\/(Users|home)\/[^/]+/, '~');
  const parent = home.includes('/') ? home.slice(0, home.lastIndexOf('/')) || '/' : '';
  const copy = async (e: MouseEvent<HTMLButtonElement>) => {
    const ok = await copyText(root, e.currentTarget);
    if (ok) showToast('Path copied');
    else showToast("Couldn't copy path", 'error');
  };
  return (
    <button type="button" className="projsel" title={`${root} · click to copy`} aria-label={`${name}, copy project path`} onClick={copy}>
      <span className="pn">{name}</span>
      {parent && <small>{parent}</small>}
    </button>
  );
}

/**
 * Files and Inspector: below 1080 px they open the slide-overs; wider they collapse and expand the docked panels,
 * and the icon's filled side shows the panel is shown (no pressed background there).
 */
function PanelButton({ p }: { p: Panel }) {
  const narrow = useMedia(NARROW_QUERY);
  const open = useStore(s => (narrow ? s.panel === p : !shownLayout(s).collapsed[p]));
  const { name, key, id } = PANELS[p];
  const on = open && !narrow;
  return (
    <button
      type="button"
      className="iconbtn"
      aria-label={p === 'files' ? 'Files' : 'Inspector'}
      aria-controls={id}
      aria-keyshortcuts={key}
      title={narrow ? undefined : `${open ? 'Hide' : 'Show'} ${name} (${key})`}
      data-panel-opener={p}
      aria-expanded={open}
      onClick={() => togglePanel(p)}
    >
      {p === 'inspector' ? <PanelIcon on={on} /> : narrow ? <MenuIcon /> : <SidebarIcon on={on} />}
    </button>
  );
}

/** Opens Settings (AI, guardrails). An exported replay has no server to configure, so it has no button. */
function SettingsButton() {
  const open = useStore(s => s.openSettings);
  const replay = useStore(s => s.replay);
  if (replay) return null;
  return <button type="button" className="iconbtn" aria-label="Settings" title="Settings" onClick={open}><GearIcon /></button>;
}

export function Toolbar() {
  const { theme, toggle } = useTheme();

  return (
    <header className="toolbar glass">
      <PanelButton p="files" />
      <span className="brand"><i className="mark" aria-hidden="true" /><span>LiveMap</span></span>
      <span className="sep" aria-hidden="true" />
      <ProjectChip />
      <StatusChip />
      <AgentChips />
      <span className="grow"><NowLine /></span>
      <SearchButton />
      <button type="button" className="iconbtn theme" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </button>
      <SettingsButton />
      <PanelButton p="inspector" />
      <PauseButton />
    </header>
  );
}
