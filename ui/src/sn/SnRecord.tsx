import { useMemo, useState } from 'react';
import type { SnRecordInfo } from '@shared/sn.js';
import { useStore } from '../store';
import { agentName } from '../agents';
import {
  CONFIDENCE_HINT, CONFIDENCE_LABEL, inRecord, kindOf, levelOf, openUrl, recordOf, useSn, whyOf,
  type ConfidenceLevel, type RichAttribution,
} from './data';

/* The inspector's ServiceNow card: what the selected record is, who changed it last and why, and a link to it. */

/** Goal and Step texts longer than this show cut, with a button to show all. */
const CUT = 180;

function Expandable({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CUT;
  return (
    <>
      <span className="sn-txt">{long && !open ? `${text.slice(0, CUT).trimEnd()}...` : text}</span>
      {long && <button type="button" className="sn-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button>}
    </>
  );
}

/** The confidence level as a badge, its reason (or what the level means) on hover. */
export function ConfidenceBadge({ level, reason }: { level: ConfidenceLevel; reason?: string }) {
  return <span className={`sn-conf c-${level}`} title={reason || CONFIDENCE_HINT[level]}>{CONFIDENCE_LABEL[level]}</span>;
}

/** The first file of a record, to select it: its `meta.json` for a folder record. */
function fileOf(r: SnRecordInfo, files: Record<string, unknown>): string | undefined {
  if (!r.dir) return files[r.path] ? r.path : undefined;
  if (files[`${r.path}/meta.json`]) return `${r.path}/meta.json`;
  for (const p in files) if (p.startsWith(`${r.path}/`)) return p;
  return undefined;
}

export function SnRecordCard({ path }: { path: string }) {
  const index = useSn(s => s.index);
  const byPath = useSn(s => s.byPath);
  const files = useStore(s => s.files);
  const dataRefs = useStore(s => s.domain.dataRefs);
  const changes = useStore(s => s.changes);
  const events = useStore(s => s.events);
  const sessions = useStore(s => s.sessions);
  const vf = useStore(s => s.viewFilter);
  const { select, setTab, focusTable } = useStore.getState();
  const r = index ? recordOf(byPath, path) : undefined;

  // What the record's files use: other records (script includes, embedded widgets) and tables, by name.
  const uses = useMemo(() => {
    if (!r) return { records: [] as SnRecordInfo[], tables: [] as string[] };
    const mine = Object.keys(files).filter(p => inRecord(r, p));
    const recs = new Map<string, SnRecordInfo>();
    const tables = new Set<string>();
    for (const p of mine) {
      for (const dep of files[p].imports.local) {
        const u = recordOf(byPath, dep);
        if (!u || u.path === r.path) continue;
        // A table's file (`schema/<table>.sntable.json`) is listed by its table name, with the tables read by name.
        const t = /([^/]+)\.sntable\.json$/.exec(u.path);
        if (t) tables.add(t[1]);
        else recs.set(u.path, u);
      }
    }
    for (const d of dataRefs) if (inRecord(r, d.file)) for (const t of d.tables) tables.add(t);
    return { records: [...recs.values()].sort((a, b) => a.name.localeCompare(b.name)), tables: [...tables].sort() };
  }, [r, files, byPath, dataRefs]);

  const latest = useMemo(() => {
    if (!r) return undefined;
    for (let i = changes.length - 1; i >= 0; i--) if (inRecord(r, changes[i].path) && (!vf || vf.change(changes[i]))) return changes[i];
    return undefined;
  }, [r, changes, vf]);

  if (!r || !index) return null;
  const kind = kindOf(r.table);
  const a = latest?.attribution as RichAttribution | undefined;
  const level = levelOf(a);
  const why = latest ? whyOf(latest, kind, events, sessions) : {};
  const url = openUrl(index.instance, r.table, r.sysId);
  const who = a ? `${agentName(a.agent)}${why.session?.title ? `, ${why.session.title}` : ''}` : undefined;

  return (
    <div className="sec sn-rec" aria-label="ServiceNow record">
      <h4>ServiceNow record</h4>
      <div className="sn-title"><b>{r.name}</b><span className="sn-kind">{kind}</span></div>
      <dl className="sn-facts">
        {latest && (
          <>
            {who && <><dt>Session</dt><dd>{who}</dd></>}
            {why.goal && <><dt>Goal</dt><dd><Expandable text={why.goal} /></dd></>}
            {why.step && <><dt>Step</dt><dd><Expandable text={why.step} /></dd></>}
            {why.action && <><dt>Action</dt><dd>{why.action}</dd></>}
            <dt>Confidence</dt>
            <dd>
              <ConfidenceBadge level={level} reason={a?.reason} />
              {level === 'ambiguous' && a?.candidates?.length ? (
                <ul className="sn-cands" aria-label="Candidate sessions">
                  {a.candidates.map(c => <li key={`${c.agent}:${c.sessionId}`}>{agentName(c.agent)}{sessions[c.sessionId]?.title ? `, ${sessions[c.sessionId].title}` : `, session ${c.sessionId}`}</li>)}
                </ul>
              ) : null}
            </dd>
          </>
        )}
        <dt>Update set</dt><dd>{r.updateSetName ?? <span className="muted">Not recorded</span>}</dd>
        <dt>Last updated</dt>
        <dd>{r.updatedBy || r.updatedOn ? [r.updatedBy, r.updatedOn && `${r.updatedOn} UTC`].filter(Boolean).join(', ') : <span className="muted">Not recorded</span>}</dd>
        <dt>Uses</dt>
        <dd>
          {uses.records.length || uses.tables.length ? (
            <ul className="sn-uses">
              {uses.records.map(u => {
                const f = fileOf(u, files);
                return <li key={u.path}><button type="button" className="chip" title={u.name} disabled={!f} onClick={() => f && select(f)}><span>{u.name}</span><small>{kindOf(u.table)}</small></button></li>;
              })}
              {uses.tables.map(t => (
                <li key={t}><button type="button" className="chip" title={t} onClick={() => { setTab('schema'); focusTable(t.toLowerCase()); }}><span>{t}</span><small>Table</small></button></li>
              ))}
            </ul>
          ) : <span className="muted">Nothing found</span>}
        </dd>
      </dl>
      {!latest && <p className="muted sn-none">No changes to this record since LiveMap started.</p>}
      {url && <a className="sn-open" href={url} target="_blank" rel="noopener noreferrer">Open in ServiceNow</a>}
    </div>
  );
}
