import { memo, useRef } from 'react';
import clsx from 'clsx';
import type { FileModel } from '@shared/types.js';
import type { SymbolTag } from '../changes';
import type { Layer } from '../layers';
import type { LiveBadge } from '../recent';
import { baseName } from '../recent';
import { symKey, type FlatSymbol } from '../treeModel';
import { Chevron, KindBadge, LayerTile } from './icons';

const PARSE_ERROR_TIP = 'Parse error: showing the last good structure';

/** Test hook: called on every FileRow render. */
export const rowRenderProbe: { fn: ((path: string) => void) | null } = { fn: null };

export interface FileRowProps {
  file: FileModel;
  layer: Layer;
  total: number;
  symbols: FlatSymbol[];
  open: boolean;
  selected: boolean;
  badge: LiveBadge | undefined;
  pop: boolean;
  tags: Map<string, SymbolTag>;
  /** The roving-focus key when it is this row or one of its symbols, else null. */
  activeKey: string | null;
  onSelect(path: string): void;
  onToggle(path: string): void;
  onSymbol(path: string, line: number): void;
}

export const FileRow = memo(function FileRow(props: FileRowProps) {
  const { file, layer, total, symbols, open, selected, badge, pop, tags, activeKey } = props;
  rowRenderProbe.fn?.(file.path);
  const mounted = useRef(open);
  if (open) mounted.current = true;
  const hasSyms = symbols.length > 0;
  const closed = open ? {} : ({ 'data-closed': '', inert: '' } as Record<string, string>);
  return (
    <div role="none">
      <button
        type="button"
        role="treeitem"
        aria-level={2}
        aria-selected={selected}
        aria-expanded={hasSyms ? open : undefined}
        data-nav={file.path}
        data-file={file.path}
        tabIndex={activeKey === file.path ? 0 : -1}
        className={clsx('frow', open && 'open', selected && 'sel', pop && 'pop')}
        title={file.path}
        onClick={() => props.onSelect(file.path)}
      >
        <span
          className="grid place-items-center"
          onClick={e => { if (hasSyms) { e.stopPropagation(); props.onToggle(file.path); } }}
        >
          <Chevron className={clsx('chev', !hasSyms && 'empty')} />
        </span>
        <LayerTile layer={layer} />
        <span className="fn">{baseName(file.path)}</span>
        {file.flags.parseError && (badge
          // Next to a live badge the parse error is a compact dot so the name keeps its room.
          ? <span className="badge b-err b-dot" role="img" aria-label="parse error" title={PARSE_ERROR_TIP} />
          : <span className="badge b-err" title={PARSE_ERROR_TIP}>parse error</span>)}
        {badge === 'new' && <span className="badge b-new">New</span>}
        {badge === 'edited' && <span className="badge b-edit">Edited</span>}
        {!badge && !file.flags.parseError && <span className="fmeta" aria-label={`${total} symbols`}>{total || ''}</span>}
      </button>
      {hasSyms && (
        <div className={clsx('syms', open && 'open')} role="group" {...closed}>
          <div>
            {mounted.current && symbols.map(({ sym, depth }) => {
              const key = symKey(file.path, sym);
              return (
                <button
                  type="button"
                  role="treeitem"
                  aria-level={3}
                  key={key}
                  data-nav={key}
                  data-parent={file.path}
                  tabIndex={activeKey === key ? 0 : -1}
                  className={clsx('srow', tags.get(sym.qname))}
                  style={depth ? { paddingLeft: 30 + depth * 14 } : undefined}
                  onClick={() => props.onSymbol(file.path, sym.line)}
                  title={sym.signature || sym.name}
                >
                  <KindBadge kind={sym.kind} />
                  <span>{sym.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
