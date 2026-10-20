import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { classifyTool } from '@shared/tools.js';
import type { AgentEvent } from '@shared/types.js';
import { useStore } from '../store';
import { agentName } from '../agents';
import { CONFIDENCES, CONFIDENCE_LABEL, loadSn, toolWords, useSn } from './data';
import { activeCount, filtersUrl, readFilters, viewFilter, type Filters } from './filters';

/*
 * The ServiceNow parts of the page, for a `livemap sn` project only: the unattributed badge in the toolbar, the filter
 * bar over the views, and the diagnostics panel. Loaded lazily after the first hello for every live project; without
 * a ServiceNow mirror it renders only the third-party notices link.
 */

/** The mirror's records are read again this long after the last change (a burst of saves reads them once). */
const RELOAD_MS = 1500;

/** Tool names the classifier could not place (so their calls can never attribute a change), with call counts. */
export function unknownTools(events: AgentEvent[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'tool_start' || !e.tool) continue;
    const c = classifyTool(e.tool.name, e.tool.input);
    if (c.known) continue;
    const name = c.inner ?? c.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function Slot({ id, children }: { id: string; children: React.ReactNode }) {
  const el = document.getElementById(id);
  return el ? createPortal(children, el) : null;
}

function Select({ label, value, options, onChange }: { label: string; value?: string; options: [string, string][]; onChange: (v?: string) => void }) {
  return (
    <label className="sn-f">
      <span>{label}</span>
      <select value={value ?? ''} onChange={e => onChange(e.target.value || undefined)}>
        <option value="">Any</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        {value && !options.some(([v]) => v === value) && <option value={value}>{value}</option>}
      </select>
    </label>
  );
}

function Diagnostics({ onClose }: { onClose: () => void }) {
  const events = useStore(s => s.events);
  const list = useMemo(() => unknownTools(events), [events]);
  return (
    <div className="sn-diag glass" role="dialog" aria-label="Diagnostics" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="sn-diag-h">
        <b>Unknown tools</b>
        <button type="button" className="iconbtn" aria-label="Close diagnostics" onClick={onClose}>×</button>
      </div>
      <p className="muted">Tools LiveMap could not classify. Their calls never count as writes, so changes they make show as unattributed. A new agent tool shows here first.</p>
      {list.length ? (
        <table className="sn-diag-t">
          <thead><tr><th scope="col">Tool</th><th scope="col">Calls</th></tr></thead>
          <tbody>{list.map(([name, n]) => <tr key={name}><td><code>{name}</code> <span className="muted">{toolWords(name)}</span></td><td>{n.toLocaleString()}</td></tr>)}</tbody>
        </table>
      ) : <p className="sn-diag-ok">Every tool seen so far is classified.</p>}
    </div>
  );
}

export default function SnHost() {
  const index = useSn(s => s.index);
  const byPath = useSn(s => s.byPath);
  const root = useStore(s => s.root);
  const changes = useStore(s => s.changes);
  const events = useStore(s => s.events);
  const sessions = useStore(s => s.sessions);
  const [filters, setFilters] = useState<Filters>(() => readFilters(window.location.search));
  const [diag, setDiag] = useState(false);
  const [ok, setOk] = useState(false);

  // Read the records once per project, and again after changes settle (a save can move a record or its update set).
  useEffect(() => {
    let live = true;
    void loadSn().then(r => { if (live) setOk(r); });
    return () => { live = false; };
  }, [root]);
  const seen = useRef(changes.length);
  useEffect(() => {
    if (!ok || changes.length === seen.current) return;
    seen.current = changes.length;
    const t = window.setTimeout(() => void loadSn(), RELOAD_MS);
    return () => window.clearTimeout(t);
  }, [ok, changes.length]);

  // The views read the filter from the store; leaving clears it.
  useEffect(() => {
    useStore.setState({ viewFilter: ok ? viewFilter(filters, byPath, changes) : null });
  }, [ok, filters, byPath, changes]);
  useEffect(() => () => useStore.setState({ viewFilter: null }), []);

  const update = (f: Filters) => {
    setFilters(f);
    window.history.replaceState(window.history.state, '', filtersUrl(window.location.href, f));
  };
  const set = <K extends keyof Filters>(k: K) => (v?: string) => update({ ...filters, [k]: v as Filters[K] });

  const unattributed = useMemo(() => changes.reduce((n, c) => (c.attribution ? n : n + 1), 0), [changes]);
  const unknown = useMemo(() => unknownTools(events).length, [events]);
  const scopes = useMemo<[string, string][]>(() => (index?.scopes ?? []).map(s => [s.scope, s.name ? `${s.name} (${s.scope})` : s.scope]), [index]);
  const sets = useMemo<[string, string][]>(() => {
    const names = new Set<string>();
    for (const r of index?.records ?? []) if (r.updateSetName) names.add(r.updateSetName);
    return [...names].sort().map(n => [n, n]);
  }, [index]);
  const sessionOpts = useMemo<[string, string][]>(() => Object.values(sessions)
    .filter(s => s.agent !== 'git')
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(s => [s.id, `${agentName(s.agent)}: ${s.title || s.id}`]), [sessions]);

  // The third-party notices link, in the Live session view of every live project (this module loads for all of them).
  const notices = <Slot id="notices"><a className="notices" href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">Third-party notices</a></Slot>;
  if (!ok || !index) return notices;
  const n = activeCount(filters);
  return (
    <>
      {notices}
      <Slot id="sn-badge">
        <button
          type="button"
          className={`sn-badge${filters.conf === 'none' ? ' on' : ''}`}
          title="Changes no agent call was matched to. Click to show only these."
          aria-pressed={filters.conf === 'none'}
          onClick={() => update(filters.conf === 'none' ? { ...filters, conf: undefined } : { ...filters, conf: 'none', who: undefined })}
        >
          <b>{unattributed.toLocaleString()}</b> unattributed
        </button>
      </Slot>
      <Slot id="sn-filters">
        <div className="sn-bar" role="group" aria-label="Filters">
          <Select label="Scope" value={filters.scope} options={scopes} onChange={set('scope')} />
          <Select label="Update set" value={filters.set} options={sets} onChange={set('set')} />
          <Select label="Session" value={filters.session} options={sessionOpts} onChange={set('session')} />
          <Select label="Made by" value={filters.who} options={[['agent', 'Agent'], ['human', 'Human']]} onChange={set('who')} />
          <Select label="Confidence" value={filters.conf} options={CONFIDENCES.map(c => [c, CONFIDENCE_LABEL[c]])} onChange={set('conf')} />
          {n > 0 && <button type="button" className="sn-clear" onClick={() => update({})}>Clear {n === 1 ? 'filter' : `${n} filters`}</button>}
          <span className="grow" />
          <button type="button" className="sn-diag-b" aria-expanded={diag} onClick={() => setDiag(!diag)}>
            Unknown tools <b>{unknown.toLocaleString()}</b>
          </button>
          {diag && <Diagnostics onClose={() => setDiag(false)} />}
        </div>
      </Slot>
    </>
  );
}
