import { memo, type CSSProperties } from 'react';
import { Position, type EdgeProps } from '@xyflow/react';
import type { LinkFlowEdge } from './mapFlow';

/**
 * The curve between two cards, after the prototype's `edgePath`: a horizontal S-curve between facing
 * sides, or a loop around the right side when both ends leave from the right (same column).
 */
export function linkPath(sx: number, sy: number, tx: number, ty: number, sp: Position, tp: Position): string {
  // A perfectly flat curve has a zero-height bounding box, which hides an objectBoundingBox gradient.
  if (Math.abs(ty - sy) < 1) ty = sy + 1;
  if (sp === Position.Right && tp === Position.Right) {
    const x = Math.max(sx, tx);
    const d = 46 + Math.min(70, Math.abs(ty - sy) * 0.12);
    return `M${sx},${sy} C${x + d},${sy} ${x + d},${ty} ${tx},${ty}`;
  }
  const dir = sp === Position.Left ? -1 : 1;
  // Ease out over half the gap between the facing sides. Only a link that also climbs eases out further
  // (up to 50 px, a third of the climb): a fixed 50 px drew short squiggles between close, level cards.
  const d = Math.max(Math.abs(tx - sx) / 2, Math.min(50, Math.abs(ty - sy) / 3));
  return `M${sx},${sy} C${sx + dir * d},${sy} ${tx - dir * d},${ty} ${tx},${ty}`;
}

/**
 * A hairline import link. A fresh one (new since hello, first seen under 4 s ago) draws itself in the
 * green-to-blue `#gfresh` gradient; `pathLength` normalizes the dash so no measuring is needed.
 */
function LinkEdgeView({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<LinkFlowEdge>) {
  const d = linkPath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition);
  const fresh = !!data?.fresh;
  const weight = data?.weight ?? 1;
  // Folder links stand for several imports: a little heavier, up to a cap.
  const style = weight > 1 ? ({ '--lw': `${1.5 + Math.min(5, weight - 1) * 0.3}px` } as CSSProperties) : undefined;
  return (
    <path
      className={fresh ? 'react-flow__edge-path lk draw' : 'react-flow__edge-path lk'}
      d={d}
      fill="none"
      style={style}
      pathLength={fresh ? 1 : undefined}
    />
  );
}

export const LinkEdge = memo(LinkEdgeView);
