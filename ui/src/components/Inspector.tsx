import { useMemo } from 'react';
import clsx from 'clsx';
import type { FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { LAYERS, layerOf } from '../layers';
import { countSymbols, flattenSymbols, latestChange, symbolTags } from '../changes';
import { baseName, isRecent, useNow } from '../recent';
import { CodeView } from './CodeView';
import { KindBadge, LayerTile, layerVars } from './icons';

function FileChip({ path, note }: { path: string; note?: string }) {
  const file = useStore(s => s.files[path]);
  const select = useStore(s => s.select);
  const layer = file ? layerOf(path, file) : 'core';
  return (
    <button type="button" className="chip" style={layerVars(layer)} title={note ? `${path}\n${note}` : path} onClick={() => select(path)}>
      <i /><span>{baseName(path)}</span>
    </button>
  );
}

function Overview() {
  const files = useStore(s => s.files);
  const recent = useStore(s => s.recent);
  const changes = useStore(s => s.changes);
  const connected = useStore(s => s.connected);
  const select = useStore(s => s.select);
  const now = useNow();
  const list = Object.values(files);
  const symbols = useMemo(() => list.reduce((n, f) => n + countSymbols(f.symbols), 0), [files]);
  const recentPaths = Object.entries(recent)
    .filter(([p]) => files[p])
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, 8);
  const stats: [number, string][] = [
    [list.length, 'Files'],
    [symbols, 'Symbols'],
    [changes.length, 'Changes seen'],
    [list.filter(f => f.flags.parseError).length, 'Parse errors'],
  ];
  return (
    <>
      <div className="live-h"><h3>Overview</h3>{connected && <span className="livetag"><i />Live</span>}</div>
      <div className="mstats">
        {stats.map(([v, l]) => <div className="mstat" key={l}><b>{v.toLocaleString()}</b><span>{l}</span></div>)}
      </div>
      <div className="sec">
        <h4>Recently changed</h4>
        <div className="recent">
          {recentPaths.length ? recentPaths.map(([p, r]) => {
            const f = files[p];
            return (
              <button type="button" className="rrow fi" key={p} onClick={() => select(p)} title={p}>
                <LayerTile layer={layerOf(p, f)} />
                <code>{baseName(p)}</code>
                {isRecent(r, now) && <span className={clsx('badge', r.kind === 'created' ? 'b-new' : 'b-edit')}>{r.kind === 'created' ? 'New' : 'Edited'}</span>}
              </button>
            );
          }) : <div className="muted">Nothing yet. Edits show up here as they happen.</div>}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Select any file to see what is inside it, what it connects to, and the code that changed.</div>
    </>
  );
}

function FileDetail({ file }: { file: FileModel }) {
  const files = useStore(s => s.files);
  const changes = useStore(s => s.changes);
  const usedByIndex = useStore(s => s.usedBy);
  const { select, revealLine } = useStore.getState();
  const layer = layerOf(file.path, file);
  const change = latestChange(changes, file.path);
  const tags = useMemo(() => symbolTags(file, change), [file, change]);
  const flat = useMemo(() => flattenSymbols(file.symbols), [file]);

  const uses = file.imports.local.filter(p => p !== file.path);
  const usedBy = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const f of Object.values(files)) {
      if (f.path !== file.path && f.imports.local.includes(file.path)) out.set(f.path, out.get(f.path) ?? new Set());
    }
    for (const e of usedByIndex) {
      if (e.file !== file.path) continue;
      for (const p of e.usedIn) {
        if (p === file.path) continue;
        const s = out.get(p) ?? new Set<string>();
        s.add(e.symbol);
        out.set(p, s);
      }
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files, usedByIndex, file.path]);

  return (
    <>
      <button type="button" className="backbtn" onClick={() => select(null)}>‹ Overview</button>
      <div className="sh-head">
        <LayerTile layer={layer} className="ic" />
        <div style={{ minWidth: 0 }}>
          <h3>{baseName(file.path)}</h3>
          <div className="path">{file.path}</div>
          <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 6 }}>
            <span className="tg" style={{ background: LAYERS[layer].tint, color: LAYERS[layer].color }}>{LAYERS[layer].name}</span>
            <span className="fmeta">{file.lang} · {file.lines.toLocaleString()} lines</span>
          </div>
        </div>
      </div>

      {file.flags.parseError && (
        <div className="note err">
          <small>Parse error</small>
          This file does not parse right now, so the structure below is from its last good version.
        </div>
      )}

      {flat.length > 0 && (
        <div className="sec">
          <h4>Inside this file · {flat.length}</h4>
          <div className="symlist">
            {flat.map(({ sym, depth }) => {
              const tag = tags.get(sym.qname);
              return (
                <button
                  type="button"
                  className="sym"
                  key={`${sym.qname}:${sym.line}`}
                  style={depth ? { paddingLeft: 12 + depth * 16 } : undefined}
                  onClick={() => revealLine(file.path, sym.line)}
                  title={sym.signature || sym.name}
                >
                  <KindBadge kind={sym.kind} />
                  <code>{sym.name}</code>
                  {tag === 'new' && <span className="tg t-add">New</span>}
                  {tag === 'changed' && <span className="tg t-chg">Changed</span>}
                  <span className="ln">:{sym.line}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="sec">
        <h4>Uses</h4>
        <div className="chips">
          {uses.length ? uses.map(p => <FileChip key={p} path={p} />) : <span className="muted">No local imports</span>}
        </div>
        {file.imports.external.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Packages: <span className="font-mono">{file.imports.external.join(', ')}</span>
          </div>
        )}
      </div>

      <div className="sec">
        <h4>Used by</h4>
        <div className="chips">
          {usedBy.length
            ? usedBy.map(([p, syms]) => <FileChip key={p} path={p} note={syms.size ? `uses ${[...syms].join(', ')}` : undefined} />)
            : <span className="muted">Nothing uses this yet</span>}
        </div>
      </div>

      <div className="sec">
        <h4>Code{change && change.kind !== 'deleted' ? ` · +${change.lines.added} −${change.lines.removed} in the last change` : ''}</h4>
        <CodeView file={file} change={change} />
      </div>
    </>
  );
}

export function Inspector() {
  const selected = useStore(s => s.selected);
  const file = useStore(s => (s.selected ? s.files[s.selected] : undefined));
  const panel = useStore(s => s.panel);
  return (
    <aside className={clsx('insp glass', panel === 'inspector' && 'open')} aria-label="Inspector">
      <div className="ins-scroll ins-swap" key={selected ?? '__overview'}>
        {file ? <FileDetail file={file} /> : <Overview />}
      </div>
    </aside>
  );
}
