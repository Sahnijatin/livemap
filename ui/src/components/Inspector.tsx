import { useMemo } from 'react';
import clsx from 'clsx';
import type { ChangeSummary, FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { LAYERS, layerOf } from '../layers';
import { flattenSymbols, latestChange, symbolTags } from '../changes';
import { agentName, clock } from '../agents';
import { baseName } from '../recent';
import { CodeView } from './CodeView';
import { FlagBox } from './FlagBox';
import { LiveSession } from './LiveSession';
import { Avatar } from './Avatar';
import { KindBadge, LayerTile, layerVars } from './icons';
import { MethodPill } from './MethodPill';

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

const MAX_WHY = 12;

/** This file's changes, newest first, each with the intent of the agent step that made it. */
function WhyItChanged({ path }: { path: string }) {
  const changes = useStore(s => s.changes);
  const list = useMemo(() => {
    const out: ChangeSummary[] = [];
    for (let i = changes.length - 1; i >= 0 && out.length < MAX_WHY; i--) if (changes[i].path === path) out.push(changes[i]);
    return out;
  }, [changes, path]);
  return (
    <div className="sec">
      <h4>Why it changed</h4>
      {list.length ? (
        <div className="why">
          {list.map(c => {
            const a = c.attribution;
            const verb = c.kind === 'created' ? 'Created' : c.kind === 'deleted' ? 'Deleted' : 'Edited';
            return (
              <div className="hrow fi" key={c.id}>
                <span className="t">{clock(c.at)}</span>
                {a ? <Avatar agent={a.agent} /> : <span className="av av-none" aria-hidden="true" />}
                <span className="hx">
                  {a ? <><b>{verb}</b> by {agentName(a.agent)}{a.confidence === 'likely' ? ' (likely)' : ''}</> : <><b>{verb}</b>. Changed outside an agent</>}
                  {a?.intent && <q>{a.intent}</q>}
                </span>
              </div>
            );
          })}
        </div>
      ) : <div className="muted">No changes since LiveMap started.</div>}
    </div>
  );
}

/** Routes, tables, table references and env var names for one file, each section only when it has items. */
function DomainSections({ file }: { file: FileModel }) {
  const domain = useStore(s => s.domain);
  const { revealLine } = useStore.getState();
  const path = file.path;
  const routes = useMemo(() => domain.routes.filter(r => r.file === path).sort((a, b) => a.line - b.line), [domain.routes, path]);
  const defined = useMemo(() => domain.tables.flatMap(t => {
    const src = t.sources.find(x => x.file === path);
    return src ? [{ t, line: src.line, fields: t.fields.filter(f => f.file === path).length }] : [];
  }), [domain.tables, path]);
  const uses = useMemo(() => {
    const names = domain.dataRefs.find(d => d.file === path)?.tables ?? [];
    const byName = new Map(domain.tables.map(t => [t.table.toLowerCase(), t]));
    return names.map(n => ({ name: n, src: byName.get(n.toLowerCase())?.sources[0] }));
  }, [domain.dataRefs, domain.tables, path]);
  const env = file.env;
  return (
    <>
      {routes.length > 0 && (
        <div className="sec">
          <h4>Routes in this file · {routes.length}</h4>
          <div className="symlist">
            {routes.map(r => (
              <button type="button" className="sym rt-row" key={r.id} onClick={() => revealLine(path, r.line)} title={r.mountedVia?.length ? `Mounted via ${r.mountedVia.join(', ')}` : r.fullPath}>
                <MethodPill method={r.method} />
                <code>{r.fullPath}</code>
                <span className="ln">:{r.line}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {defined.length > 0 && (
        <div className="sec">
          <h4>Tables defined here · {defined.length}</h4>
          <div className="symlist">
            {defined.map(({ t, line, fields }) => (
              <button type="button" className="sym" key={t.table} onClick={() => revealLine(path, line)} title={t.table}>
                <span className="kb k-tbl" aria-hidden="true">T</span>
                <code>{t.name}</code>
                <span className="ln">{fields} {fields === 1 ? 'field' : 'fields'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {uses.length > 0 && (
        <div className="sec">
          <h4>Uses tables</h4>
          <div className="chips">
            {uses.map(u => (
              <button type="button" className="chip tchip" key={u.name} disabled={!u.src} onClick={() => u.src && revealLine(u.src.file, u.src.line)} title={u.src ? `Defined in ${u.src.file}:${u.src.line}` : u.name}>
                <i /><span>{u.name}</span>
              </button>
            ))}
          </div>
          <div className="muted snote">Matched by name, so approximate.</div>
        </div>
      )}
      {env.length > 0 && (
        <div className="sec">
          <h4>Env vars · {env.length}</h4>
          <div className="chips">
            {env.map(n => <span className="chip envchip" key={n}><span>{n}</span></span>)}
          </div>
        </div>
      )}
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
      <button type="button" className="backbtn" onClick={() => select(null)}>‹ Live session</button>
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

      <DomainSections file={file} />

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

      <WhyItChanged path={file.path} />
      <FlagBox key={file.path} target={file.path} />
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
        {file ? <FileDetail file={file} /> : <LiveSession />}
      </div>
    </aside>
  );
}
