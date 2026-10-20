import { useDeferredValue, useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Table } from '@shared/domain.js';
import { tableKey } from '../store';
import { SchemaIcon, SearchIcon, SidebarIcon } from './icons';

const plural = (n: number, one: string): string => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;
/** Rows drawn at most; the rest wait for a narrower search. */
const SHOWN = 300;

/**
 * Every table by name, with its column and relation counts, searchable by table or column name.
 * Beside the canvas on a wide pane; over it, as the primary view, on a narrow one.
 */
export function TableList({ tables, relations, focused, narrow, q, onQuery, onPick, onClose, footer }: {
  tables: Table[];
  /** Relations per table key, in or out. */
  relations: Map<string, number>;
  focused: string | null;
  narrow: boolean;
  /** The search, kept by the view so Esc clears it from anywhere in the view. */
  q: string;
  onQuery: (q: string) => void;
  onPick: (key: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  // Typing stays responsive on thousands of tables: the rows follow a step behind.
  const needle = useDeferredValue(q).trim().toLowerCase();
  const sorted = useMemo(() => [...tables].sort((a, b) => a.name.localeCompare(b.name)), [tables]);
  const rows = useMemo(() => {
    if (!needle) return sorted.map(t => ({ t, hits: '' }));
    const out: { t: Table; hits: string }[] = [];
    for (const t of sorted) {
      const named = t.name.toLowerCase().includes(needle) || t.table.toLowerCase().includes(needle);
      const cols = t.fields.filter(f => f.name.toLowerCase().includes(needle));
      if (named || cols.length) out.push({ t, hits: named ? '' : cols.slice(0, 3).map(f => f.name).join(', ') });
    }
    return out;
  }, [sorted, needle]);

  return (
    <aside className={clsx('sv-list', narrow ? 'over' : 'glass')} aria-label="Tables">
      <div className="sv-lh">
        <label className="sv-search">
          <SearchIcon />
          <input type="search" placeholder="Find a table or column" aria-label="Search tables and columns" value={q} onChange={e => onQuery(e.target.value)} />
        </label>
        <button type="button" className={clsx('sv-close', narrow && 'txt')} onClick={onClose} aria-label={narrow ? undefined : 'Hide table list'} title={narrow ? undefined : 'Hide table list'}>
          {narrow ? 'Diagram' : <SidebarIcon on />}
        </button>
      </div>
      <div className="sv-meta">
        <p className="sv-count">{needle ? `${rows.length.toLocaleString()} of ${plural(tables.length, 'table')}` : plural(tables.length, 'table')}</p>
        <span className="sv-legend" aria-hidden="true"><i>Cols</i><i>Rels</i></span>
      </div>
      <div className="sv-rows">
        {rows.slice(0, SHOWN).map(({ t, hits }) => {
          const k = tableKey(t);
          const rel = relations.get(k) ?? 0;
          return (
            <button
              type="button"
              key={k}
              className="sv-row"
              data-table={k}
              aria-current={focused === k ? 'true' : undefined}
              aria-label={`${t.name}, ${plural(t.fields.length, 'column')}, ${plural(rel, 'relation')}`}
              onClick={() => onPick(k)}
            >
              <span className="sv-ic" aria-hidden="true"><SchemaIcon /></span>
              <span className="sv-rt">
                <span className="sv-rn">{t.name}</span>
                {hits && <small className="sv-hit">{hits}</small>}
              </span>
              <span className="sv-cols" title="Columns">{t.fields.length}</span>
              <span className={clsx('sv-rels', !rel && 'none')} title="Relations">{rel}</span>
            </button>
          );
        })}
        {rows.length > SHOWN && <p className="sv-more">{(rows.length - SHOWN).toLocaleString()} more, refine the search</p>}
        {!rows.length && <p className="sv-none">No tables match “{q.trim()}”.</p>}
      </div>
      {footer}
    </aside>
  );
}
