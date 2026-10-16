import { memo, useRef } from 'react';
import clsx from 'clsx';
import type { FileModel } from '@shared/types.js';
import type { SymbolTag } from '../changes';
import type { Layer } from '../layers';
import type { LiveBadge } from '../recent';
import { splitName, symKey, type FlatSymbol } from '../treeModel';
import { Chevron, KindBadge, LayerTile } from './icons';

const PARSE_ERROR_TIP = 'Parse error: showing the last good structure';

/**
 * A name cut in the middle when it does not fit: the start shrinks with an ellipsis, the end always shows. Spaces
 * show as typed (white-space:pre), so line breaks show as ␤ instead of breaking the row.
 */
export function MidName({ name, kind = 'file' }: { name: string; kind?: 'file' | 'dir' }) {
  const [head, tail] = splitName(name.replace(/\r\n|[\n\r]/g, '\u2424'), kind);
  return <span className="fn"><span>{head}</span>{tail && <span>{tail}</span>}</span>;
}

/** Test hook: called on every FileRow render. */
export const rowRenderProbe: { fn: ((path: string) => void) | null } = { fn: null };

export interface FileRowProps {
  file: FileModel;
  /** The file's name, without its folder. */
  name: string;
  /** Tree depth, 1 at the top level. */
  level: number;
  /** The nav key of the folder holding it; null at the top level. */
  up: string | null;
  layer: Layer;
  total: number;
  symbols: FlatSymbol[];
  open: boolean;
  selected: boolean;
  badge: LiveBadge | undefined;
  /** The file the agent is working on right now: shows NOW instead of New or Edited. */
  target: boolean;
  pop: boolean;
  tags: Map<string, SymbolTag>;
  /** The roving-focus key when it is this row or one of its symbols, else null. */
  activeKey: string | null;
  onSelect(path: string): void;
  onToggle(path: string): void;
  onSymbol(path: string, line: number): void;
  /** Records a mounted row (or null when it unmounts) by nav key. */
  register(key: string, el: HTMLElement | null): void;
}

export const FileRow = memo(function FileRow(props: FileRowProps) {
  const { file, name, level, up, layer, total, symbols, open, selected, badge: liveBadge, target, pop, tags, activeKey } = props;
  rowRenderProbe.fn?.(file.path);
  const badge = target ? 'now' : liveBadge;
  const mounted = useRef(open);
  if (open) mounted.current = true;
  const hasSyms = symbols.length > 0;
  const closed = open ? {} : ({ 'data-closed': '', inert: '' } as Record<string, string>);
  return (
    <div role="none">
      <button
        type="button"
        role="treeitem"
        aria-level={level}
        aria-selected={selected}
        aria-expanded={hasSyms ? open : undefined}
        ref={el => props.register(file.path, el)}
        data-nav={file.path}
        data-file={file.path}
        data-up={up ?? undefined}
        style={{ ['--d' as string]: level - 1 }}
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
        <MidName name={name} />
        {file.flags.parseError && (badge
          // Next to a live badge the parse error is a compact dot so the name keeps its room.
          ? <span className="badge b-err b-dot" role="img" aria-label="parse error" title={PARSE_ERROR_TIP} />
          : <span className="badge b-err" title={PARSE_ERROR_TIP}>parse error</span>)}
        {badge === 'now' && <span className="badge b-now">Now</span>}
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
                  aria-level={level + 1}
                  key={key}
                  ref={el => props.register(key, el)}
                  data-nav={key}
                  data-parent={file.path}
                  tabIndex={activeKey === key ? 0 : -1}
                  className={clsx('srow', tags.get(sym.qname))}
                  style={{ ['--d' as string]: level - 1, ['--sd' as string]: depth }}
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
