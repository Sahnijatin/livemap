import { memo, type CSSProperties, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { NodeProps } from '@xyflow/react';
import { LAYERS } from '../layers';
import { Chevron, LayerTile, layerVars } from '../components/icons';
import { ARROWS, type FolderFlowNode } from './mapFlow';
import { useMapActions } from './MapContext';
import { Anchors } from './FileNode';
import { useStore } from '../store';
import { READ_ONLY_TIP } from '../history';

const midHandle: CSSProperties = { top: '50%', opacity: 0, pointerEvents: 'none' };
const n = (v: number): string => v.toLocaleString();
const plural = (v: number, one: string, many: string): string => `${n(v)} ${v === 1 ? one : many}`;
const slash = (label: string, path: string): string => (path === '' ? label : `${label}/`);

/**
 * A folder. At the folders level it is a `.folder` card with counts (double-click or Enter opens its
 * files). At the files and functions levels it is the tinted region behind its file cards, labeled
 * with the folder and its layer; in a large project its header opens or closes the folder.
 */
function FolderNodeView({ id, data }: NodeProps<FolderFlowNode>) {
  const { folder: f, level, large, expanded } = data;
  const actions = useMapActions();
  // Folder cards are draggable pins: read-only while the UI shows the past.
  const ro = useStore(s => s.rewound !== null);
  const layer = LAYERS[f.layer];

  if (level === 'folders') {
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        actions.openFolder(id);
        return;
      }
      const dir = ARROWS[e.key];
      if (!dir) return;
      e.preventDefault();
      actions.focusNeighbor(id, dir);
    };
    return (
      <div
        className={clsx('folder', f.isNew && 'isnew')}
        style={layerVars(f.layer)}
        role="button"
        tabIndex={0}
        aria-label={`${f.label} (${layer.name}, ${plural(f.counts.files, 'file', 'files')}). Open to see its files.`}
        data-folder={id}
        title={ro ? READ_ONLY_TIP : undefined}
        onKeyDown={onKeyDown}
      >
        <Anchors style={midHandle} />
        <div className="fnm">
          <LayerTile layer={f.layer} className="ic" />
          <span className="ftx">
            <span className="fl">{slash(f.label, f.path)}</span>
            <span className="fly">{layer.name}</span>
          </span>
        </div>
        <div className="fc">
          <span><b>{n(f.counts.files)}</b> {f.counts.files === 1 ? 'file' : 'files'}</span>
          <span><b>{n(f.counts.symbols)}</b> {f.counts.symbols === 1 ? 'symbol' : 'symbols'}</span>
          {f.counts.routes > 0 && <span><b>{n(f.counts.routes)}</b> {f.counts.routes === 1 ? 'route' : 'routes'}</span>}
          {f.counts.tables > 0 && <span><b>{n(f.counts.tables)}</b> {f.counts.tables === 1 ? 'table' : 'tables'}</span>}
          {f.isNew && <span className="fnew">New</span>}
        </div>
      </div>
    );
  }

  const open = !large || expanded;
  return (
    <div className={clsx('mgroup', !open && 'shut', large && 'large')} style={layerVars(f.layer)} data-folder={id}>
      <div className="mg-head" title={f.label}>
        <span className="gl">
          {slash(f.label, f.path)} <small>{layer.name}</small>
        </span>
        <span className="mg-ct">{plural(f.counts.files, 'file', 'files')} · {plural(f.counts.symbols, 'symbol', 'symbols')}</span>
      </div>
      {large && (
        <button
          type="button"
          className="mg-tog nodrag"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Close' : 'Open'} ${f.label}`}
          onClick={e => { e.stopPropagation(); actions.toggleFolder(id); }}
        >
          <Chevron className="dchev" />
          {expanded ? 'Close' : 'Open'}
        </button>
      )}
    </div>
  );
}

export const FolderNode = memo(FolderNodeView);
