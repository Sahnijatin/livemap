import { useStore } from '../store';

/** Blocking states shown over the workspace: no key, or not connected / indexing before the first hello. */
export function Gate() {
  const connection = useStore(s => s.connection);
  const loaded = useStore(s => s.loaded);
  const indexing = useStore(s => s.indexing);

  if (connection === 'unauthorized') {
    return (
      <>
        <div className="scrim open" />
        <div className="intro" role="alertdialog" aria-labelledby="gate-title" aria-describedby="gate-text">
          <i className="mark" aria-hidden="true" />
          <h1 id="gate-title">Open the link printed in your terminal</h1>
          <p id="gate-text">This page needs the one-time key that LiveMap prints when it starts. Run <code className="font-mono">livemap</code> again if the terminal is closed.</p>
        </div>
      </>
    );
  }
  if (loaded) return null;

  const pct = indexing && indexing.total ? Math.round((indexing.done / indexing.total) * 100) : 0;
  const title = indexing ? 'Reading your project' : connection === 'closed' ? 'Reconnecting to LiveMap' : 'Connecting to LiveMap';
  return (
    <>
      <div className="scrim open" />
      <div className="intro" role="status" aria-live="polite">
        <i className="mark" aria-hidden="true" />
        <h1>{title}</h1>
        <p>{indexing ? 'Finding files, functions and how they connect.' : connection === 'closed' ? 'Is LiveMap still running in your terminal?' : 'One moment.'}</p>
        {indexing && <div className="prog"><i style={{ width: `${pct}%` }} /></div>}
        {indexing && indexing.total > 0 && <div className="hint">{indexing.done.toLocaleString()} of {indexing.total.toLocaleString()} files</div>}
      </div>
    </>
  );
}
