import { useMemo } from 'react';
import { useStore } from '../store';
import { LAYERS, LAYER_ORDER, layerOf, type Layer } from '../layers';
import { countSymbols } from '../changes';

/** Center pane for Phase 1: a project summary and what is coming next. */
export function CenterPlaceholder() {
  const files = useStore(s => s.files);
  const changes = useStore(s => s.changes);
  const name = useStore(s => s.name);
  const { total, symbols, langs, layers } = useMemo(() => {
    const list = Object.values(files);
    const tally = new Map<Layer, number>();
    const langSet = new Set<string>();
    let symbols = 0;
    for (const f of list) {
      symbols += countSymbols(f.symbols);
      if (!['text', 'other', 'secret'].includes(f.lang)) langSet.add(f.lang);
      const l = layerOf(f.path, f);
      tally.set(l, (tally.get(l) ?? 0) + 1);
    }
    return { total: list.length, symbols, langs: langSet.size, layers: LAYER_ORDER.filter(l => tally.has(l)).map(l => [l, tally.get(l)!] as const) };
  }, [files]);

  const stats: [number, string][] = [[total, 'files'], [symbols, 'functions and types'], [changes.length, 'changes seen'], [langs, 'languages']];
  return (
    <main className="center">
      <div className="gridbg" aria-hidden="true" />
      <div className="center-body">
        <section className="hero fi" aria-labelledby="hero-title">
          <span className="lbl"><span className="mark" style={{ width: 14, height: 14, borderRadius: 5 }} aria-hidden="true" />{name ? `${name} · live` : 'LiveMap'}</span>
          <h3 id="hero-title">Map, Activity, Schema and API arrive in the next phases</h3>
          <p>For now, browse the live file tree and inspect any file to see what is inside it. Every save shows up within a moment.</p>
          {layers.length > 0 && (
            <div className="layerbar" role="img" aria-label={layers.map(([l, n]) => `${LAYERS[l].name} ${n}`).join(', ')}>
              {layers.map(([l, n]) => <i key={l} style={{ flexGrow: n, ['--c' as string]: LAYERS[l].color }} />)}
            </div>
          )}
          <div className="stats">
            {stats.map(([v, l]) => <div className="stat" key={l}><b>{v.toLocaleString()}</b><span>{l}</span></div>)}
          </div>
        </section>
      </div>
    </main>
  );
}

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
