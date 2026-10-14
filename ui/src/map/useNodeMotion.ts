import { useCallback, useEffect, useRef, useState } from 'react';
import { applyNodeChanges, type NodeChange } from '@xyflow/react';
import { animate } from 'framer-motion';
import type { Level, MapGraph } from './mapModel';
import { FILE_W } from './mapLayout';
import { DataCache, MOVE_S, lerpBox, prefersReducedMotion, sameBox, type Box, type MapFlowNode } from './mapFlow';

export interface Move { id: string; from: Box; to: Box }

/**
 * Where each node starts this update and which ones move. A node keeps its shown box when that already
 * matches; a node the user is dragging stays where the user holds it (never a mover); after a level
 * switch, files opening out of a folder card start from that card.
 */
export function planMoves(
  boxes: Map<string, Box>, shown: Map<string, Box>,
  opts: { levelChanged: boolean; folderOf: Map<string, string>; dragging: Set<string> },
): { next: Map<string, Box>; movers: Move[] } {
  const movers: Move[] = [];
  const next = new Map<string, Box>();
  for (const [id, to] of boxes) {
    let from = shown.get(id);
    if (from && opts.dragging.has(id)) { next.set(id, from); continue; }
    if (!from && opts.levelChanged) {
      const fb = shown.get(opts.folderOf.get(id) ?? '');
      if (fb) from = { x: fb.x + fb.w / 2 - FILE_W / 2, y: fb.y + fb.h / 2 - to.h / 2, w: to.w, h: to.h };
    }
    if (from && !sameBox(from, to)) {
      movers.push({ id, from, to });
      next.set(id, from);
    } else next.set(id, to);
  }
  return { next, movers };
}

/** Where a new card springs in from, relative to its slot (card centers). */
export interface Spawn { dx: number; dy: number }

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * New files (per `isNew`) that appear on a map already showing: each springs in from the center of its
 * first edge partner that was already placed, else from its folder's center. Nothing on a first show.
 */
export function planSpawns(g: MapGraph, boxes: Map<string, Box>, shown: Map<string, Box>, isNew: (id: string) => boolean): Map<string, Spawn> {
  const out = new Map<string, Spawn>();
  if (!shown.size) return out;
  for (const f of g.files) {
    const slot = boxes.get(f.id);
    if (!slot || shown.has(f.id) || !isNew(f.id)) continue;
    let from: Box | undefined;
    for (const e of g.edges) {
      const other = e.source === f.id ? e.target : e.target === f.id ? e.source : null;
      if (other && shown.has(other)) { from = boxes.get(other) ?? shown.get(other); break; }
    }
    from ??= boxes.get(f.folder) ?? shown.get(f.folder);
    if (!from) continue;
    const a = center(from), b = center(slot);
    out.set(f.id, { dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y) });
  }
  return out;
}

/** A spawn is read when its card mounts; one not read this soon (an off-screen card) is dropped. */
const SPAWN_TTL_MS = 1500;

/** React Flow nodes at their shown boxes; unchanged nodes keep their objects. */
export function buildNodes(g: MapGraph, shown: Map<string, Box>, cache: DataCache, expanded: Set<string>, prev: MapFlowNode[]): MapFlowNode[] {
  const old = new Map(prev.map(n => [n.id, n]));
  const out: MapFlowNode[] = [];
  const keep = (n: MapFlowNode): MapFlowNode => {
    const o = old.get(n.id);
    if (!o) return n;
    if (o.type === n.type && o.data === n.data && o.position.x === n.position.x && o.position.y === n.position.y
      && o.width === n.width && o.height === n.height && o.draggable === n.draggable && o.zIndex === n.zIndex) return o;
    // Keep React Flow's measured size so cards do not blink while it measures again.
    return o.measured ? ({ ...n, measured: o.measured } as MapFlowNode) : n;
  };
  const folders = g.level === 'folders';
  for (const f of g.folders) {
    const b = shown.get(f.id);
    if (!b) continue;
    out.push(keep({
      id: f.id, type: 'folder', position: { x: b.x, y: b.y }, width: b.w, height: b.h,
      data: cache.folder(f, g.level, g.large, expanded.has(f.id)),
      draggable: folders, selectable: false, zIndex: folders ? 0 : -1,
    }));
  }
  for (const f of g.files) {
    const b = shown.get(f.id);
    if (!b) continue;
    out.push(keep({
      id: f.id, type: 'file', position: { x: b.x, y: b.y }, width: b.w, height: b.h,
      data: cache.file(f, g.level), draggable: true, selectable: false, zIndex: 0,
    }));
  }
  cache.prune(new Set(out.map(n => n.id)));
  return out;
}

/** Moved nodes get new objects at their new boxes; every other node object is returned as is. */
export function patchNodes(ns: MapFlowNode[], moved: Map<string, Box>): MapFlowNode[] {
  if (!moved.size) return ns;
  return ns.map(n => {
    const b = moved.get(n.id);
    return b ? ({ ...n, position: { x: b.x, y: b.y }, width: b.w, height: b.h } as MapFlowNode) : n;
  });
}

/**
 * React Flow nodes that follow their layout boxes. Changed boxes (push-down, level switch, reset) move
 * with a critically damped spring over `MOVE_S` (instant under reduced motion); a newer layout continues
 * from wherever the nodes are. Nodes being dragged are left to the user. `onPlaced` runs after each
 * update with the new boxes (the camera hooks in there). New files (per `born`) spring in: their node is
 * placed at its slot at once and `spawnOf` tells the card where to start.
 */
export function useNodeMotion(
  graph: MapGraph, boxes: Map<string, Box> | null, expanded: Set<string>,
  onPlaced: (g: MapGraph, boxes: Map<string, Box>) => void,
  born?: { isNew(id: string): boolean; done(id: string): void },
) {
  const [nodes, setNodes] = useState<MapFlowNode[]>([]);
  const shown = useRef(new Map<string, Box>());
  const shownLevel = useRef<Level | null>(null);
  const cache = useRef(new DataCache());
  const dragging = useRef(new Set<string>());
  const spawns = useRef(new Map<string, Spawn & { at: number }>());
  const bornRef = useRef(born);
  bornRef.current = born;

  useEffect(() => {
    if (!boxes) return;
    const g = graph;
    const levelChanged = shownLevel.current !== null && shownLevel.current !== g.level;
    shownLevel.current = g.level;
    const folderOf = new Map(g.files.map(f => [f.id, f.folder]));
    const reduced = prefersReducedMotion();
    const b = bornRef.current;
    if (b && !levelChanged && !reduced) {
      const now = Date.now();
      for (const [id, s] of spawns.current) if (now - s.at > SPAWN_TTL_MS) spawns.current.delete(id);
      for (const [id, s] of planSpawns(g, boxes, shown.current, b.isNew)) {
        spawns.current.set(id, { ...s, at: now });
        b.done(id);
      }
    }
    const { next, movers } = planMoves(boxes, shown.current, { levelChanged, folderOf, dragging: dragging.current });
    const instant = reduced || !movers.length;
    if (instant) for (const m of movers) next.set(m.id, m.to);
    shown.current = next;
    setNodes(prev => buildNodes(g, next, cache.current, expanded, prev));
    onPlaced(g, boxes);
    if (instant) return;
    const step = (t: number | null) => {
      const moved = new Map<string, Box>();
      for (const m of movers) {
        // A card the user grabbed mid-move stays in their hand.
        if (dragging.current.has(m.id)) continue;
        const b = t === null || t >= 1 ? m.to : lerpBox(m.from, m.to, t);
        shown.current.set(m.id, b);
        moved.set(m.id, b);
      }
      setNodes(ns => patchNodes(ns, moved));
    };
    const controls = animate(0, 1, { type: 'spring', bounce: 0, duration: MOVE_S, onUpdate: step, onComplete: () => step(null) });
    return () => controls.stop();
  }, [boxes, graph, expanded, onPlaced]);

  const onNodesChange = useCallback((changes: NodeChange<MapFlowNode>[]) => {
    for (const c of changes) {
      if (c.type !== 'position' || !c.position) continue;
      const b = shown.current.get(c.id);
      if (b) shown.current.set(c.id, { ...b, x: c.position.x, y: c.position.y });
    }
    setNodes(ns => applyNodeChanges(changes, ns));
  }, []);

  const dragStart = useCallback((id: string) => { dragging.current.add(id); }, []);
  const dragEnd = useCallback((id: string) => { dragging.current.delete(id); }, []);

  /** Where a card that just appeared should spring in from, or null. */
  const spawnOf = useCallback((id: string): Spawn | null => {
    const s = spawns.current.get(id);
    return s && Date.now() - s.at <= SPAWN_TTL_MS ? { dx: s.dx, dy: s.dy } : null;
  }, []);

  return { nodes, onNodesChange, dragStart, dragEnd, spawnOf };
}
