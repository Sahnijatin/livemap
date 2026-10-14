import { useEffect } from 'react';
import clsx from 'clsx';
import { useStore } from './store';
import { Toolbar } from './components/Toolbar';
import { FileTree } from './components/FileTree';
import { Inspector } from './components/Inspector';
import { Gate } from './components/Empty';
import { CenterTabs } from './components/CenterTabs';
import { Toast } from './components/Toast';

export function App() {
  const panel = useStore(s => s.panel);
  const setPanel = useStore(s => s.setPanel);
  const name = useStore(s => s.name);
  // While the gate covers the workspace, nothing behind it is focusable or clickable.
  const gated = useStore(s => s.connection === 'unauthorized' || !s.loaded);

  useEffect(() => {
    document.title = name ? `${name} · LiveMap` : 'LiveMap';
  }, [name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && useStore.getState().panel) setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPanel]);

  return (
    <>
      <div className="ambient" aria-hidden="true"><div className="blob b1" /><div className="blob b2" /><div className="blob b3" /></div>
      <div className="app" {...(gated ? { inert: '', 'aria-hidden': true } : {})}>
        <Toolbar />
        <FileTree />
        <CenterTabs />
        <Inspector />
        {/* Inside .app: a fixed .app is its own stacking context, so the slide-over panels sit above this. */}
        <div className={clsx('scrim only-narrow-scrim', panel && 'open')} onClick={() => setPanel(null)} aria-hidden="true" />
      </div>
      <Toast />
      <Gate />
    </>
  );
}
