import { useStore } from '../store';
import { useTheme } from '../theme';
import { MenuIcon, MoonIcon, PanelIcon, SunIcon } from './icons';

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
      <span className="grow" />
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
    </header>
  );
}
