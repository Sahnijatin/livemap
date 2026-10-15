import { memo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useStore } from '../store';
import { READ_ONLY_TIP } from '../history';
import { LAYERS } from '../layers';
import { KindBadge, LayerTile, layerVars } from '../components/icons';
import { ARROWS, HANDLE_Y, type FileFlowNode } from './mapFlow';
import { useMapActions } from './MapContext';

const handle: CSSProperties = { top: HANDLE_Y, opacity: 0, pointerEvents: 'none' };

/**
 * Hidden link anchors on both sides, at the middle of the header (links never move with rows). Two per
 * card: links start and end on either one (the map uses `ConnectionMode.Loose`).
 */
export function Anchors({ style = handle }: { style?: CSSProperties }) {
  return (
    <>
      <Handle type="source" position={Position.Right} id="r" isConnectable={false} style={style} />
      <Handle type="source" position={Position.Left} id="l" isConnectable={false} style={style} />
    </>
  );
}

/** A new file's card springs from its partner (or folder) to its slot. */
const SPAWN = { type: 'spring', stiffness: 260, damping: 24 } as const;
const SETTLED = { x: 0, y: 0, scale: 1, opacity: 1 } as const;

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * A file card after the prototype's `.node`: layer chip, name, symbol count and a layer-colored
 * accent; NEW, live (amber ring and sheen), selected (blue), flagged (red) and, at the functions
 * level, symbol rows tinted green (new) or orange (changed).
 */
function FileNodeView({ id, data, positionAbsoluteX, positionAbsoluteY }: NodeProps<FileFlowNode>) {
  const { file: f, level } = data;
  // Only this card re-renders when the selection moves to or from it.
  const sel = useStore(s => s.selected === id);
  const actions = useMapActions();
  // File cards are draggable pins: read-only while the UI shows the past.
  const ro = useStore(s => s.rewound !== null);
  // Read once, when the card mounts: a new file springs in from where the map says.
  const [enter] = useState(() => actions.spawnOf(id));
  const fnz = level === 'functions';
  const count = plural(f.symbols, 'symbol', 'symbols');

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      actions.open(id);
      return;
    }
    const dir = ARROWS[e.key];
    if (!dir) return;
    e.preventDefault();
    actions.focusNeighbor(id, dir);
  };

  const card = (
    <div
      className={clsx('node', f.isNew && 'isnew', f.isLive && 'live', sel && 'sel', f.isFlagged && 'flagged', fnz && 'fnz')}
      style={layerVars(f.layer)}
      role="button"
      tabIndex={0}
      aria-label={`${f.label} (${LAYERS[f.layer].name}, ${count})`}
      aria-current={sel ? 'true' : undefined}
      data-path={id}
      data-x={Math.round(positionAbsoluteX)}
      data-y={Math.round(positionAbsoluteY)}
      title={ro ? READ_ONLY_TIP : undefined}
      onClick={() => actions.open(id)}
      onKeyDown={onKeyDown}
    >
      <Anchors />
      <div className="top">
        <LayerTile layer={f.layer} className="ic" />
        <div className="tx">
          <div className="nm">
            <span className="nmt">{f.label}</span>
            {f.isNew && <i className="newtag">NEW</i>}
          </div>
          <div className="sub">
            {/* While live, the sub-label is just "Writing now" so it is never cut off; the count is in the aria-label. */}
            {f.isLive ? <span className="wn">Writing now</span> : count}
          </div>
        </div>
      </div>
      {fnz && f.rows.length > 0 && (
        <div className="nsyms">
          {f.rows.map((r, i) => (
            <div
              key={`${r.name}:${i}`}
              className={clsx('nsrow', r.tag === 'new' && 'new', r.tag === 'changed' && 'chg')}
              style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}
            >
              <KindBadge kind={r.kind} />
              <span className="nsn">{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  if (!enter) return card;
  return (
    <motion.div
      className="spawn"
      data-spawn={id}
      initial={{ x: enter.dx, y: enter.dy, scale: 0.6, opacity: 0 }}
      animate={SETTLED}
      transition={SPAWN}
    >
      {card}
    </motion.div>
  );
}

export const FileNode = memo(FileNodeView);
