import { memo, type CSSProperties, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { NodeProps } from '@xyflow/react';
import { LAYERS } from '../layers';
import { Chevron, LayerTile, layerVars } from '../components/icons';
import { ARROWS, type FolderFlowNode, type FolderLabelFlowNode } from './mapFlow';
import { useMapActions } from './MapContext';
import { Anchors } from './FileNode';
import { useStore } from '../store';
import { READ_ONLY_TIP } from '../history';
import { MidName } from '../components/FileRow';
import { nameEnd, nameFit, slash } from './overview';

const midHandle: CSSProperties = { top: '50%', opacity: 0, pointerEvents: 'none' };
const n = (v: number): string => v.toLocaleString();
const plural = (v: number, one: string, many: string): string => `${n(v)} ${v === 1 ? one : many}`;

/** Characters of a folder card's name (15 px semibold in the card's text column). */
const CARD_CHARS = 19;
/** About 7 px a character for a region head's name (12 px semibold). */
const HEAD_CHAR_W = 7;

/**
 * A folder name that fits `chars` characters (nameFit): whole, cut in the middle by MidName (the file tree's cut, with
 * whole trailing folders), or "…" and its end when even the last folder leaves no room for a start.
 */
export function FolderName({ name, chars }: { name: string; chars: number }) {
  const fit = nameFit(name, chars);
  if (fit.mode === 'end') return <span className="fn end"><span>{`\u2026${nameEnd(name, fit.tailMax)}`}</span></span>;
  return <MidName name={name} kind="path" tailMax={fit.tailMax} />;
}

/**
 * A folder. At the folders level it is a `.folder` card with counts (double-click or Enter opens its
 * files). At the files and functions levels it is the tinted region behind its file cards and links;
 * its label is a `FolderLabelNode` drawn above the links.
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
            <span className="fl" title={f.label}><FolderName name={slash(f.label, f.path)} chars={CARD_CHARS} /></span>
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

  return <div className={clsx('mgroup', large && !expanded && 'shut')} style={layerVars(f.layer)} data-folder={id} />;
}

/**
 * A folder region's header (the folder, its layer and counts), a node of its own so it paints above
 * the links that cross the region; in a large project it opens or closes the folder.
 */
function FolderLabelNodeView({ data, width = 0 }: NodeProps<FolderLabelFlowNode>) {
  const { folder: f, large, expanded } = data;
  // The head's room: the region less its insets and padding, the layer name and, in a large project, the toggle.
  const chars = Math.floor((width - 44 - (LAYERS[f.layer].name.length * 6 + 5) - (large ? 74 : 0)) / HEAD_CHAR_W);
  const actions = useMapActions();
  return (
    <div className={clsx('mglabel', large && 'large')} style={layerVars(f.layer)} data-folder={f.id}>
      <div className="mg-head">
        <span className="gl" title={f.label}>
          <FolderName name={slash(f.label, f.path)} chars={chars} /><small>{LAYERS[f.layer].name}</small>
        </span>
        <span className="mg-ct">{plural(f.counts.files, 'file', 'files')} · {plural(f.counts.symbols, 'symbol', 'symbols')}</span>
      </div>
      {large && (
        <button
          type="button"
          className="mg-tog nodrag"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Close' : 'Open'} ${f.label}`}
          onClick={e => { e.stopPropagation(); actions.toggleFolder(f.id); }}
        >
          <Chevron className="dchev" />
          {expanded ? 'Close' : 'Open'}
        </button>
      )}
    </div>
  );
}

export const FolderNode = memo(FolderNodeView);
export const FolderLabelNode = memo(FolderLabelNodeView);
