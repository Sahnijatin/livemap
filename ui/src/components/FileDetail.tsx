import { useEffect, useMemo, useReducer } from 'react';
import type { ChangeSummary, FileModel } from '@shared/types.js';
import { summaryRequests, useStore } from '../store';
import { LAYERS, layerOf } from '../layers';
import { flattenSymbols, latestChange, symbolTags } from '../changes';
import { agentName, clock } from '../agents';
import { baseName } from '../recent';
import { CodeView } from './CodeView';
import { FlagBox } from './FlagBox';
import { Avatar } from './Avatar';
import { KindBadge, LayerTile, layerVars } from './icons';
import { MethodPill } from './MethodPill';
import { authHeaders } from '../connection';
import { askAbout } from './Ask';
import { SnRecordCard } from '../sn/SnRecord';

/* The inspector's file view. It only shows once a file is selected, so it loads after first paint (see Inspector). */

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

/** How long the summary shimmer waits for a `fileSummary` before giving up (a slow provider retries for a while). */
const PENDING_MS = 60_000;

/**
 * Asks the server for a file summary unless a request for it is unanswered (see `summaryRequests`); false then.
 * A cached summary applies at once and a pending one arrives as `fileSummary`; `done` runs when the request fails.
 */
function requestSummary(path: string, done: () => void): boolean {
  if (summaryRequests.has(path)) return false;
  summaryRequests.set(path, Date.now());
  const fail = () => { summaryRequests.set(path, 0); done(); };
  fetch(`/api/summary?path=${encodeURIComponent(path)}`, { headers: authHeaders() })
    .then(async res => {
      if (res.status === 202) return;
      if (res.status !== 200) return fail();
      const j = (await res.json()) as { summary?: unknown; hash?: unknown };
      if (typeof j.summary !== 'string' || typeof j.hash !== 'string') return fail();
      useStore.getState().apply({ type: 'fileSummary', path, hash: j.hash, summary: j.summary });
    })
    .catch(fail);
  return true;
}

/**
 * "In plain English": the AI file summary, else the agent's own words for the latest change. With AI on it
 * always shows, so a failed summary says why (with a retry) instead of disappearing. Summaries render as text only.
 */
function PlainEnglish({ path }: { path: string }) {
  const entry = useStore(s => s.summaries.files[path]);
  const status = useStore(s => s.summaries.status);
  const replay = useStore(s => s.replay);
  const state = status.state;
  const on = state !== 'off';
  // At the cap or after an error a cached summary can still come back, but no new one is being written.
  const writing = state === 'ready' || state === 'working';
  const rewound = useStore(s => s.rewound !== null);
  const changes = useStore(s => s.changes);
  const intent = useMemo(() => latestChange(changes, path)?.attribution?.intent, [changes, path]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!entry && on && !rewound && requestSummary(path, rerender)) rerender(); // show the shimmer
  }, [path, entry, on, rewound]);
  const since = summaryRequests.get(path) ?? 0;
  const left = entry || !writing || rewound ? 0 : since + PENDING_MS - Date.now();
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(rerender, left);
    return () => clearTimeout(t);
  }, [left > 0, since]);
  const retry = () => {
    summaryRequests.delete(path);
    if (requestSummary(path, rerender)) rerender();
  };

  const live = on && !rewound && !replay;
  if (!entry && left <= 0 && !intent && !live) return null;
  const why = state === 'error' ? `Could not write a summary: ${status.error ?? 'unknown error'}.`
    : state === 'cap' ? 'No new summaries this month: the token cap is reached.'
    : since === 0 && summaryRequests.has(path) ? 'Could not write a summary for this file.'
    : 'No summary for this file yet.';
  return (
    <div className="ai fi">
      <small><span aria-hidden="true">✦ </span>In plain English</small>
      {entry ? <p>{entry.summary}</p>
        : left > 0 ? <div className="ai-wait" aria-busy="true" aria-label="Writing a summary"><i /><i /></div>
        : intent ? <><span className="ai-src">In the agent's words</span><p>{intent}</p></>
        : <p className="ai-why">{why}</p>}
      {live && (
        <div className="ai-acts">
          {!entry && left <= 0 && state !== 'cap' && <button type="button" className="linkbtn" onClick={retry}>Try again</button>}
          <button type="button" className="linkbtn" onClick={() => askAbout(path)}>Ask about this file</button>
        </div>
      )}
      {live && !entry && left <= 0 && intent && state === 'error' && <p className="ai-why">{why}</p>}
    </div>
  );
}

const MAX_WHY = 12;

/** The changes the views show: all of them, or those the filter bar lets through. */
function useShownChanges(): ChangeSummary[] {
  const changes = useStore(s => s.changes);
  const vf = useStore(s => s.viewFilter);
  return useMemo(() => (vf ? changes.filter(vf.change) : changes), [changes, vf]);
}

/** This file's changes, newest first, each with the intent of the agent step that made it. */
function WhyItChanged({ path }: { path: string }) {
  const changes = useShownChanges();
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

export function FileDetail({ file }: { file: FileModel }) {
  const files = useStore(s => s.files);
  // The diff shows the latest change the filters let through.
  const changes = useShownChanges();
  const usedByIndex = useStore(s => s.usedBy);
  const { revealLine } = useStore.getState();
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

      <SnRecordCard path={file.path} />

      <PlainEnglish path={file.path} />

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

