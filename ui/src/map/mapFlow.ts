import type { Edge, Node } from '@xyflow/react';
import type { Level, MapFile, MapFolder, MapGraph } from './mapModel';
import { FILE_W, fileHeight, type Positions } from './mapLayout';

/**
 * Pure glue between the map model and React Flow: node boxes from a layout, edge objects with their
 * sides and freshness, stable node data, and keyboard neighbors. No React here.
 */

/** A new link keeps its gradient this long after it first appears, then settles. */
export const FRESH_MS = 4000;
/** Level switches and push-downs move nodes over about this long (critically damped spring). */
export const MOVE_S = 0.45;
/** Draw links on top of a file card at the middle of its header. */
export const HANDLE_Y = 32;

export type Box = { x: number; y: number; w: number; h: number };

export type FileNodeData = { file: MapFile; level: Level };
export type FolderNodeData = { folder: MapFolder; level: Level; large: boolean; expanded: boolean };
export type FileFlowNode = Node<FileNodeData, 'file'>;
export type FolderFlowNode = Node<FolderNodeData, 'folder'>;
/** A folder region's header, drawn above the links at the files and functions levels. */
export type FolderLabelFlowNode = Node<FolderNodeData, 'folderLabel'>;
export type MapFlowNode = FileFlowNode | FolderFlowNode | FolderLabelFlowNode;
export type LinkData = { fresh: boolean; weight: number };
export type LinkFlowEdge = Edge<LinkData, 'link'>;

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

/** Every node's box at the graph's level: folder rects, and file slots sized for the level. */
export function layoutBoxes(graph: MapGraph, pos: Positions): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const f of graph.folders) {
    const r = pos.folders.get(f.id);
    if (r) out.set(f.id, { x: r.x, y: r.y, w: r.w, h: r.h });
  }
  for (const f of graph.files) {
    const p = pos.files.get(f.id);
    if (p) out.set(f.id, { x: p.x, y: p.y, w: FILE_W, h: fileHeight(f, graph.level) });
  }
  return out;
}

/**
 * Edges first seen less than `FRESH_MS` ago that were not in the hello baseline. `seen` remembers
 * when each new edge first appeared (session memory, so a tab switch does not replay it).
 */
export function freshEdgeIds(graph: MapGraph, seen: Map<string, number>, now: number): Set<string> {
  const out = new Set<string>();
  for (const e of graph.edges) {
    if (!e.isNew) continue;
    let at = seen.get(e.id);
    if (at === undefined) seen.set(e.id, (at = now));
    if (now - at < FRESH_MS) out.add(e.id);
  }
  return out;
}

/** When the soonest fresh edge settles, or null when none is fresh. */
export function nextSettle(fresh: Set<string>, seen: Map<string, number>): number | null {
  let soonest: number | null = null;
  for (const id of fresh) {
    const t = (seen.get(id) ?? 0) + FRESH_MS;
    if (soonest === null || t < soonest) soonest = t;
  }
  return soonest;
}

/**
 * Which sides a link leaves and enters by: rightward links go right to left, leftward ones left to
 * right, and a target in the same column is reached by a loop around the right side.
 */
export function edgeSides(a: Box, b: Box): { sourceHandle: string; targetHandle: string } {
  if (b.x > a.x + a.w / 2) return { sourceHandle: 'r', targetHandle: 'l' };
  if (b.x + b.w / 2 < a.x) return { sourceHandle: 'l', targetHandle: 'r' };
  return { sourceHandle: 'r', targetHandle: 'r' };
}

/**
 * Whether a drag that just ended saves a pin: not while a level switch or a reset waits for its
 * layout (the cards on screen are not this level's), and not for a card that layout does not place.
 */
export function shouldSavePin(node: { id: string; type?: string }, placed: Positions, layoutPending: boolean): boolean {
  if (layoutPending) return false;
  return node.type === 'file' ? placed.files.has(node.id) : placed.folders.has(node.id);
}

/**
 * React Flow edges for the graph (only between placed nodes). An edge equal to its entry in `prev`
 * (same sides, freshness and weight) keeps that object, so React Flow skips re-rendering it.
 */
export function flowEdges(graph: MapGraph, boxes: Map<string, Box>, fresh: Set<string>, prev?: Map<string, LinkFlowEdge>): LinkFlowEdge[] {
  const out: LinkFlowEdge[] = [];
  for (const e of graph.edges) {
    const a = boxes.get(e.source);
    const b = boxes.get(e.target);
    if (!a || !b) continue;
    const isFresh = fresh.has(e.id);
    const sides = edgeSides(a, b);
    const old = prev?.get(e.id);
    if (old && old.sourceHandle === sides.sourceHandle && old.targetHandle === sides.targetHandle
      && old.data?.fresh === isFresh && old.data?.weight === e.weight) {
      out.push(old);
      continue;
    }
    out.push({
      id: e.id,
      source: e.source,
      target: e.target,
      ...sides,
      type: 'link',
      className: isFresh ? 'fresh' : undefined,
      data: { fresh: isFresh, weight: e.weight },
      focusable: false,
      selectable: false,
      interactionWidth: 0,
    });
  }
  return out;
}

/** Edges touching `focus` get `hl` (new objects); every other edge object is returned as is. */
export function highlightEdges(edges: LinkFlowEdge[], focus: string | null): LinkFlowEdge[] {
  if (!focus) return edges;
  return edges.map(e => (e.source === focus || e.target === focus ? { ...e, className: e.className ? `${e.className} hl` : 'hl' } : e));
}

/** Signature of what a file card shows; equal signatures reuse the previous data object. */
function fileSig(f: MapFile, level: Level): string {
  let s = `${level}\u0000${f.label}\u0000${f.layer}\u0000${f.symbols}\u0000${+f.isNew}${+f.isLive}${+f.isFlagged}`;
  for (const r of f.rows) s += `\u0001${r.name}\u0002${r.kind}\u0002${r.tag ?? ''}`;
  return s;
}

function folderSig(f: MapFolder, level: Level, large: boolean, expanded: boolean): string {
  const c = f.counts;
  return `${level}\u0000${f.label}\u0000${f.layer}\u0000${c.files},${c.symbols},${c.routes},${c.tables}\u0000${+f.isNew}${+large}${+expanded}`;
}

/** Keeps node data objects stable while what they show is unchanged, so memoized cards skip re-rendering. */
export class DataCache {
  private files = new Map<string, { sig: string; data: FileNodeData }>();
  private folders = new Map<string, { sig: string; data: FolderNodeData }>();

  file(f: MapFile, level: Level): FileNodeData {
    const sig = fileSig(f, level);
    const hit = this.files.get(f.id);
    if (hit && hit.sig === sig) return hit.data;
    const data = { file: f, level };
    this.files.set(f.id, { sig, data });
    return data;
  }

  /** Forget nodes that are no longer drawn. */
  prune(keep: Set<string>): void {
    for (const id of this.files.keys()) if (!keep.has(id)) this.files.delete(id);
    for (const id of this.folders.keys()) if (!keep.has(id)) this.folders.delete(id);
  }

  folder(f: MapFolder, level: Level, large: boolean, expanded: boolean): FolderNodeData {
    const sig = folderSig(f, level, large, expanded);
    const hit = this.folders.get(f.id);
    if (hit && hit.sig === sig) return hit.data;
    const data = { folder: f, level, large, expanded };
    this.folders.set(f.id, { sig, data });
    return data;
  }
}

export type Dir = 'left' | 'right' | 'up' | 'down';
export const ARROWS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** The nearest candidate whose center lies in direction `dir` from `from`'s center; off-axis distance counts double. */
export function nearestInDirection(from: Box, candidates: { id: string; box: Box }[], dir: Dir): string | null {
  const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
  let best: string | null = null, bestScore = Infinity;
  for (const c of candidates) {
    const dx = c.box.x + c.box.w / 2 - cx;
    const dy = c.box.y + c.box.h / 2 - cy;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + 2 * across;
    if (score < bestScore) { bestScore = score; best = c.id; }
  }
  return best;
}

/** Union of boxes, or null for none. */
export function boundsOf(boxes: Iterable<Box>): Box | null {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const sameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

export const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
});

/** Zoom floor for fitting a folder that the user opened. */
export const FIT_MIN_ZOOM = 0.4;
/** First show and level switches fit everything only when the fitted zoom is at least this (cards stay readable). */
export const READABLE_ZOOM = 0.7;
/** Otherwise the camera opens at this zoom, centered on the live or selected file, or on the top-left cluster. */
export const FOCUS_ZOOM = 0.85;

export type CameraPlan = { kind: 'fit' } | { kind: 'center'; zoom: number } | { kind: 'topleft'; zoom: number };

/**
 * The overview camera: fit everything when that stays readable (fitted zoom >= 0.7); otherwise zoom 0.85
 * centered on the live file, else the selected one; with nothing to focus, anchor the top-left cluster.
 */
export function cameraPlan(fitZoom: number, hasFocus: boolean): CameraPlan {
  if (fitZoom >= READABLE_ZOOM) return { kind: 'fit' };
  if (hasFocus) return { kind: 'center', zoom: FOCUS_ZOOM };
  return { kind: 'topleft', zoom: FOCUS_ZOOM };
}
