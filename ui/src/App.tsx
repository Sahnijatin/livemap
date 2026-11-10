import { lazy, Suspense, useEffect } from 'react';
import clsx from 'clsx';
import { isGated, useStore } from './store';
import { Toolbar } from './components/Toolbar';
import { FileTree } from './components/FileTree';
import { Inspector } from './components/Inspector';
import { Gate } from './components/Empty';
import { CenterTabs } from './components/CenterTabs';
import { Toast } from './components/Toast';
import { PaletteHost } from './palette/PaletteHost';
import { MotionRoot } from './motion';
import { closePanel, useSlideOvers } from './panels';
import { Dock } from './components/Dock';
import { PanelHandle } from './components/PanelHandle';

// Loaded on first open, so the main chunk carries none of it.
const Settings = lazy(() => import('./components/Settings'));

export function App() {
  const panel = useStore(s => s.panel);
  const name = useStore(s => s.name);
  // Keyed by project: switching projects starts the file tree's state (folders, Show more, filter closes) fresh.
  const root = useStore(s => s.root);
  // While the gate covers the workspace, nothing behind it is focusable or clickable.
  const gated = useStore(isGated);
  const settingsOpen = useStore(s => s.settingsOpen);

  useEffect(() => {
    document.title = name ? `${name} · LiveMap` : 'LiveMap';
  }, [name]);

  // [ and ] toggle the panels; Esc and a resize to wide close the slide-overs (while the palette is open, Esc closes only the palette).
  useSlideOvers();

  return (
    <MotionRoot>
      <div className="ambient" aria-hidden="true"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
      <Dock gated={gated}>
        <Toolbar />
        <FileTree key={root} />
        <PanelHandle panel="files" />
        <CenterTabs />
        <PanelHandle panel="inspector" />
        <Inspector />
        {/* Inside .app: a fixed .app is its own stacking context, so the slide-over panels sit above this. */}
        <div className={clsx('scrim only-narrow-scrim', panel && 'open')} onClick={closePanel} aria-hidden="true" />
      </Dock>
      <Toast />
      <PaletteHost />
      {settingsOpen && <Suspense fallback={null}><Settings /></Suspense>}
      <Gate />
    </MotionRoot>
  );
}
