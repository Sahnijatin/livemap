import { memo, type CSSProperties, type MouseEvent } from 'react';
import clsx from 'clsx';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Table } from '@shared/domain.js';
import { useStore } from '../store';
import { isNarrow } from '../media';
import { MAX_ROWS } from '../layout/schemaLayout';

export type TableNodeData = {
  table: Table;
  /** First seen after hello: NEW tag, and the spring-in when `animate`. */
  isNew: boolean;
  animate: boolean;
  /** Lowercase names of fields added since hello (green rows). */
  newFields: Set<string>;
  expanded: boolean;
  onToggle: (key: string) => void;
};
export type TableFlowNode = Node<TableNodeData, 'table'>;

const ORM: Record<string, string> = {
  prisma: 'Prisma', drizzle: 'Drizzle', typeorm: 'TypeORM', mongoose: 'Mongoose', sqlalchemy: 'SQLAlchemy',
  sqlmodel: 'SQLModel', django: 'Django', room: 'Room', swiftdata: 'SwiftData', sql: 'SQL',
};
export const ormLabel = (orm: string): string => ORM[orm] ?? orm;

/** Source handle id for a field row; the "+N more" row stands in for hidden fields. */
export const rowHandle = (field: string, side: 'l' | 'r'): string => `f:${field.toLowerCase()}:${side}`;
export const MORE_HANDLE = 'more';
export const headHandle = (side: 'l' | 'r'): string => `h:${side}`;

/** Open a file at a line in the inspector (the slide-over at narrow widths). */
function open(path: string, line?: number): void {
  const s = useStore.getState();
  if (line) s.revealLine(path, line);
  else s.select(path);
  if (isNarrow()) s.setPanel('inspector');
}

const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' };

function Sides({ id, type }: { id: (side: 'l' | 'r') => string; type: 'source' | 'target' }) {
  return (
    <>
      <Handle type={type} position={Position.Left} id={id('l')} isConnectable={false} style={hidden} />
      <Handle type={type} position={Position.Right} id={id('r')} isConnectable={false} style={hidden} />
    </>
  );
}

function Marker({ f }: { f: Table['fields'][number] }) {
  if (f.pk) return <span className="mk pk" title="Primary key">PK</span>;
  if (f.fk) return <span className="mk fk" title={`References ${f.fk.table}.${f.fk.field}`}>FK</span>;
  if (f.unique) return <span className="mk uq" title="Unique">UQ</span>;
  return <span className="mk" />;
}

/** A table card on the schema canvas, after the prototype's `.tbl`. */
function TableNodeView({ data }: NodeProps<TableFlowNode>) {
  const { table: t, isNew, animate, newFields, expanded, onToggle } = data;
  const key = t.table.toLowerCase();
  const extra = t.fields.length - MAX_ROWS;
  const collapsed = extra > 0 && !expanded;
  const rows = collapsed ? t.fields.slice(0, MAX_ROWS) : t.fields;
  const linked = new Set(t.relations.map(r => r.field.toLowerCase()));
  const hiddenLinks = collapsed && t.fields.slice(MAX_ROWS).some(f => linked.has(f.name.toLowerCase()));
  const src = t.sources[0];

  const openTable = (e: MouseEvent) => {
    e.stopPropagation();
    if (src) open(src.file, src.line);
  };

  return (
    <div className={clsx('tbl', isNew && 'isnew', animate && 'enter')} data-table={key}>
      <button type="button" className="th" onClick={openTable} title={src ? `${src.file}:${src.line}` : undefined}>
        <Sides id={headHandle} type="target" />
        <span className="tic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>
        </span>
        <b className="tn">{t.name}</b>
        {t.table !== t.name && <small className="tt">{t.table}</small>}
        {isNew && <i className="newtag">NEW</i>}
        <span className="orm">{ormLabel(t.orm)}</span>
      </button>
      <div className="cols">
        {rows.map((f, i) => {
          const isLink = linked.has(f.name.toLowerCase());
          return (
            <button
              type="button"
              key={f.name}
              className={clsx('col', newFields.has(f.name.toLowerCase()) && 'new', isLink && 'link')}
              style={animate ? ({ animationDelay: `${120 + i * 40}ms` } as CSSProperties) : undefined}
              onClick={e => { e.stopPropagation(); open(f.file, f.line); }}
              title={`${f.file}${f.line ? `:${f.line}` : ''}`}
            >
              {isLink && <Sides id={side => rowHandle(f.name, side)} type="source" />}
              <Marker f={f} />
              <span className="cn">{f.name}</span>
              {f.required && !f.pk && <i className="req" title="Required" />}
              <span className={clsx('ty', f.relation && 'rel')}>{f.type}</span>
            </button>
          );
        })}
        {extra > 0 && (
          <button type="button" className="col more" onClick={e => { e.stopPropagation(); onToggle(key); }} aria-expanded={expanded}>
            {hiddenLinks && <Sides id={side => `${MORE_HANDLE}:${side}`} type="source" />}
            <span className="mk" />
            <span className="cn">{expanded ? 'Show fewer' : `+${extra} more`}</span>
          </button>
        )}
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeView);
