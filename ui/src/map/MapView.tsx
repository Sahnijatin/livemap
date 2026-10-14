import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow, ReactFlowProvider, getViewportForBounds, useReactFlow, useStoreApi,
  type Node, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MotionConfig } from 'framer-motion';
import type { ChangeSummary } from '@shared/types.js';
import { useStore } from '../store';
import { isNarrow } from '../media';
import { useLiveRecent } from '../recent';
import { useCurrentTarget } from '../live';
import { workerRun, type ElkRun } from '../layout/elk';
import { buildMap, codeFileCount, type Level, type MapGraph } from './mapModel';
import { emptyPositions, placeMap, type Positions } from './mapLayout';
import { fileKind, filePins, type Pins } from './pins';
import {
  FIT_MIN_ZOOM, boundsOf, cameraPlan, flowEdges, freshEdgeIds, highlightEdges, layoutBoxes, nearestInDirection, nextSettle,
  prefersReducedMotion, type Box, type Dir, type LinkFlowEdge, type MapFlowNode,
} from './mapFlow';
import { MapContext, type MapActions } from './MapContext';
import { FileNode } from './FileNode';
import { FolderNode } from './FolderNode';
import { LinkEdge } from './LinkEdge';
import { MapTools } from './MapTools';
import { usePins } from './usePins';
import { useNodeMotion } from './useNodeMotion';
import { useFollowCamera } from './useFollowCamera';
import { FOLLOW_MAX_ZOOM, MoveGesture } from './camera';

const nodeTypes = { file: FileNode, folder: FolderNode };
const edgeTypes = { link: LinkEdge };
const ZOOM_KEYS = ['Meta', 'Control'];
const NO_CHANGES: ChangeSummary[] = [];
/** Above this many file cards, React Flow renders only what is on screen. */
const VISIBLE_ONLY = 120;
/** A palette focus zooms in at least this far, so the file reads. */
const FOCUS_MIN_ZOOM = 0.8;
const FOCUS_MS = 600;
/** A palette focus waiting for a layout (level switch, folder opening) is dropped after this long. */
export const FOCUS_WAIT_MS = 3000;

/**
 * Session memory (not storage), per project: each level's layout, the viewport, when new links first
 * showed, and which new files already sprang in.
 */
interface Session { root: string; levels: Record<Level, Positions>; viewport: Viewport | null; seen: Map<string, number>; sprung: Set<string> }
const blankLevels = (): Record<Level, Positions> => ({ folders: emptyPositions(), files: emptyPositions(), functions: emptyPositions() });
const newSession = (root: string): Session => ({ root, levels: blankLevels(), viewport: null, seen: new Map(), sprung: new Set() });
let session = newSession('');
function sessionFor(root: string): Session {
  if (session.root !== root) session = newSession(root);
  return session;
}
/** Tests: start every case without remembered layouts or viewport. */
export function forgetMapSession(): void {
  session = newSession('');
}

const ms = (n: number): number => (prefersReducedMotion() ? 0 : n);

/** What the layout depends on: the level, which folders and files are drawn, and card heights. */
function shapeOf(g: MapGraph): string {
  let s = g.level;
  for (const f of g.folders) s += `\u0000${f.id}`;
  for (const f of g.files) s += `\u0001${f.id}:${g.level === 'functions' ? f.rows.length : 0}`;
  return s;
}

/** Pins win over a layout that started before the user dropped a card. */
function withPins(g: MapGraph, p: Positions, pins: Pins): Positions {
  const pinned = filePins(pins, g.level);
  for (const f of g.files) {
    const pin = pinned[f.id];
    if (pin && p.files.has(f.id)) p.files.set(f.id, { x: pin.x, y: pin.y });
  }
  if (g.level === 'folders') {
    for (const f of g.folders) {
      const pin = pins.folders[f.id];
      const r = p.folders.get(f.id);
      if (pin && r) p.folders.set(f.id, { ...r, x: pin.x, y: pin.y });
    }
  }
  return p;
}

/** A camera move waiting for the next layout: first show, overview, a folder, or a file asked for by the palette. */
type Camera = { kind: 'first' } | { kind: 'overview' } | { kind: 'folder'; id: string } | { kind: 'file'; id: string; at: number };

/** Zoom buttons; a zoom is a user camera move (it pauses Follow). */
function ZoomControls({ fitAll, onZoom }: { fitAll: () => void; onZoom: () => void }) {
  const rf = useReactFlow();
  return (
    <div className="zoomctl glass" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => { onZoom(); void rf.zoomOut({ duration: ms(250) }); }}>−</button>
      <button type="button" className="zfit" aria-label="Fit to screen" onClick={fitAll}>Fit</button>
      <button type="button" aria-label="Zoom in" onClick={() => { onZoom(); void rf.zoomIn({ duration: ms(250) }); }}>+</button>
    </div>
  );
}

function Canvas({ run, tools }: { run: ElkRun; tools: HTMLElement | null }) {
  const files = useStore(s => s.files);
  const recent = useLiveRecent(useStore(s => s.recent));
  const allChanges = useStore(s => s.changes);
  const flags = useStore(s => s.control.flags);
  const helloEdges = useStore(s => s.helloEdges);
  const root = useStore(s => s.root);
  const level = useStore(s => s.mapLevel);
  const mapExpanded = useStore(s => s.mapExpanded);
  const selected = useStore(s => s.selected);
  const target = useCurrentTarget()?.path ?? null;
  // Symbol tags only matter at the functions level; elsewhere a new change does not rebuild the graph.
  const changes = level === 'functions' ? allChanges : NO_CHANGES;
  const expanded = useMemo(() => new Set(Object.keys(mapExpanded)), [mapExpanded]);
  const graph = useMemo(
    () => buildMap({ files, recent, changes, flags, target, helloEdges }, level, expanded),
    [files, recent, changes, flags, target, helloEdges, level, expanded],
  );
  const latest = useRef(graph);
  latest.current = graph;
  const targetRef = useRef(target);
  targetRef.current = target;

  const mem = sessionFor(root);
  const rf = useReactFlow<MapFlowNode, LinkFlowEdge>();
  const storeApi = useStoreApi<MapFlowNode, LinkFlowEdge>();
  const wrap = useRef<HTMLDivElement>(null);
  const pins = usePins(root);

  // Layout: one Positions per level, passed back in as `prev` so nothing reshuffles.
  const [layout, setLayout] = useState<{ level: Level; pos: Positions } | null>(() => {
    const p = mem.levels[level];
    return p.folders.size ? { level, pos: p } : null;
  });
  const [resetSeq, setResetSeq] = useState(0);
  const shape = useMemo(() => shapeOf(graph), [graph]);
  useEffect(() => {
    let live = true;
    const g = latest.current;
    placeMap(g, mem.levels[g.level], pins.get(), run).then(p => {
      if (!live) return;
      const pos = withPins(g, p, pins.get());
      mem.levels[g.level] = pos;
      setLayout({ level: g.level, pos });
    });
    return () => { live = false; };
  }, [shape, run, resetSeq, mem, pins]);

  const boxes = useMemo(() => (layout && layout.level === graph.level ? layoutBoxes(graph, layout.pos) : null), [graph, layout]);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes ?? boxesRef.current;
  // Camera: an overview on first show (unless a viewport is remembered) and after level switches.
  const camera = useRef<Camera | null>(mem.viewport ? null : { kind: 'first' });
  // While an overview waits for its layout, Follow holds off (it would move first, then cut the overview off).
  const {
    paused: followPaused, userMoved: followUserMoved, moved: followMoved, hold: followHold, release: followRelease,
  } = useFollowCamera(graph, boxes, target, camera.current?.kind === 'first');
  const overviewNext = useCallback(() => { camera.current = { kind: 'overview' }; followHold(); }, [followHold]);
  /** The user moved the camera: Follow pauses, and a palette focus still waiting for its layout is dropped. */
  const userMoved = useCallback(() => {
    if (camera.current?.kind === 'file') camera.current = null;
    followUserMoved();
  }, [followUserMoved]);
  const whenSized = useCallback((fn: (w: number, h: number) => void, tries = 30) => {
    const { width, height } = storeApi.getState();
    if (width > 0 && height > 0) fn(width, height);
    else if (tries > 0) window.requestAnimationFrame(() => whenSized(fn, tries - 1));
  }, [storeApi]);
  const fitBox = useCallback((b: Box | null, duration: number, minZoom = 0.08, maxZoom = 1) => {
    if (!b) return;
    whenSized((w, h) => {
      const vp = getViewportForBounds({ x: b.x, y: b.y, width: b.w, height: b.h }, w, h, minZoom, maxZoom, 0.1);
      void rf.setViewport(vp, { duration: ms(duration) });
    });
  }, [rf, whenSized]);

  /** The live file, else the selected one (at the folders level, their folder). */
  const focusBox = useCallback((g: MapGraph, bx: Map<string, Box>): Box | undefined => {
    for (const id of [targetRef.current, useStore.getState().selected]) {
      if (!id) continue;
      const b = bx.get(id) ?? (g.level === 'folders' ? bx.get(g.folders.find(f => f.files.includes(id))?.id ?? '') : undefined);
      if (b) return b;
    }
    return undefined;
  }, []);

  /** Fit everything when readable; else center the live or selected file; else the top-left cluster. */
  const overview = useCallback((g: MapGraph, bx: Map<string, Box>, duration: number) => {
    const all = boundsOf(bx.values());
    if (!all) { followRelease(); return; }
    whenSized((w, h) => {
      const fit = getViewportForBounds({ x: all.x, y: all.y, width: all.w, height: all.h }, w, h, 0.08, 1, 0.1);
      const fb = focusBox(g, bx);
      const plan = cameraPlan(fit.zoom, !!fb);
      const opts = { duration: ms(duration) };
      if (plan.kind === 'fit') void rf.setViewport(fit, opts);
      else if (plan.kind === 'center' && fb) void rf.setCenter(fb.x + fb.w / 2, fb.y + fb.h / 2, { ...opts, zoom: plan.zoom });
      else void rf.setViewport({ x: 40 - all.x * plan.zoom, y: 40 - all.y * plan.zoom, zoom: plan.zoom }, opts);
      followMoved(opts.duration);
    });
  }, [rf, whenSized, focusBox, followMoved, followRelease]);

  /** Center a file (palette focus). The user asked for it, so it counts as a user camera move: Follow pauses for 8 s. */
  const centerOn = useCallback((b: Box) => {
    followUserMoved();
    const z = Math.min(FOLLOW_MAX_ZOOM, Math.max(FOCUS_MIN_ZOOM, rf.getViewport().zoom));
    void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom: z, duration: ms(FOCUS_MS) });
  }, [rf, followUserMoved]);

  const onPlaced = useCallback((g: MapGraph, bx: Map<string, Box>) => {
    const c = camera.current;
    if (!c) return;
    if (c.kind === 'file') {
      // Wait for the layout that draws the file (level switch, folder opening), but not forever.
      if (Date.now() - c.at > FOCUS_WAIT_MS) { camera.current = null; return; }
      const b = bx.get(c.id);
      if (b && g.level !== 'folders') { camera.current = null; centerOn(b); }
      return;
    }
    camera.current = null;
    if (c.kind === 'folder') { followRelease(); fitBox(bx.get(c.id) ?? null, 450, FIT_MIN_ZOOM); }
    else overview(g, bx, c.kind === 'first' ? 0 : 450);
  }, [fitBox, overview, centerOn, followRelease]);

  // A level switch moves the camera once the new level is laid out; to and from folders also cross-fades.
  const prevLevel = useRef(level);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (prevLevel.current === level) return;
    const fade = prevLevel.current === 'folders' || level === 'folders';
    prevLevel.current = level;
    if (!camera.current || (camera.current.kind !== 'folder' && camera.current.kind !== 'file')) overviewNext();
    if (!fade || prefersReducedMotion()) return;
    setSwitching(true);
    const t = window.setTimeout(() => setSwitching(false), 650);
    return () => window.clearTimeout(t);
  }, [level, overviewNext]);

  // Palette focus: select the file and center it, opening its level or folder first when it is not drawn.
  // Requests made before this mount (another tab) are not replayed.
  const mapFocus = useStore(s => s.mapFocus);
  const focusSeq = useRef(mapFocus?.seq ?? 0);
  useEffect(() => {
    if (!mapFocus || mapFocus.seq <= focusSeq.current) return;
    focusSeq.current = mapFocus.seq;
    const { path } = mapFocus;
    const s = useStore.getState();
    if (s.selected !== path) s.select(path);
    const g = latest.current;
    const b = g.level !== 'folders' ? boxesRef.current?.get(path) : undefined;
    if (b) { centerOn(b); return; }
    const folder = g.folders.find(f => f.files.includes(path));
    if (!folder) return;
    // The user asked for this file: Follow pauses now, not only once the focus runs.
    followUserMoved();
    camera.current = { kind: 'file', id: path, at: Date.now() };
    if (g.large) s.expandMapFolder(folder.id);
    if (g.level === 'folders') s.setMapLevel('files');
  }, [mapFocus, centerOn, followUserMoved]);

  // New files (not in the hello, not yet shown springing in this session) spring in from a partner.
  const born = useMemo(() => ({
    isNew: (id: string) => !useStore.getState().helloFiles.has(id) && !mem.sprung.has(id),
    done: (id: string) => { mem.sprung.add(id); },
  }), [mem]);
  const { nodes, onNodesChange, dragStart, dragEnd, spawnOf } = useNodeMotion(graph, boxes, expanded, onPlaced, born);

  // Links: new ones draw in the gradient for a few seconds, then settle.
  const [tick, setTick] = useState(0);
  const fresh = useMemo(() => freshEdgeIds(graph, mem.seen, Date.now()), [graph, mem, tick]);
  useEffect(() => {
    const at = nextSettle(fresh, mem.seen);
    if (at === null) return;
    const t = window.setTimeout(() => setTick(n => n + 1), Math.max(0, at - Date.now()) + 20);
    return () => window.clearTimeout(t);
  }, [fresh, mem]);
  const prevEdges = useRef<LinkFlowEdge[]>([]);
  const baseEdges = useMemo(() => {
    // While a level's layout is pending the old cards stay up, and so do their links.
    if (!boxes) return prevEdges.current;
    const list = flowEdges(graph, boxes, fresh, new Map(prevEdges.current.map(e => [e.id, e])));
    prevEdges.current = list;
    return list;
  }, [graph, boxes, fresh]);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? (selected && boxes?.has(selected) ? selected : null);
  const edges = useMemo(() => highlightEdges(baseEdges, focus), [baseEdges, focus]);

  const onNodeDragStop = useCallback((_: unknown, n: Node) => {
    dragEnd(n.id);
    const g = latest.current;
    const p = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    if (n.type === 'file') pins.pin(fileKind(g.level), n.id, p);
    else if (g.level === 'folders') pins.pin('folders', n.id, p);
    else return;
    const was = mem.levels[g.level];
    const pos: Positions = { ...was, folders: new Map(was.folders), files: new Map(was.files) };
    if (n.type === 'file') pos.files.set(n.id, p);
    else pos.folders.set(n.id, { ...pos.folders.get(n.id)!, ...p });
    mem.levels[g.level] = pos;
    setLayout({ level: g.level, pos });
  }, [mem, pins, dragEnd]);

  const focusCard = useCallback((id: string) => {
    const find = () => [...(wrap.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
      .find(n => n.dataset.id === id)?.querySelector<HTMLElement>('[tabindex="0"]');
    const b = boxesRef.current?.get(id);
    const el = find();
    const { width, height } = storeApi.getState();
    if (b && width > 0 && height > 0) {
      const { x, y, zoom } = rf.getViewport();
      const sx = b.x * zoom + x, sy = b.y * zoom + y;
      const off = sx < 0 || sy < 0 || sx + b.w * zoom > width || sy + b.h * zoom > height;
      if (off || !el) {
        userMoved();
        void rf.setCenter(b.x + b.w / 2, b.y + b.h / 2, { zoom, duration: el ? ms(300) : 0 });
      }
    }
    if (el) el.focus({ preventScroll: true });
    else window.requestAnimationFrame(() => find()?.focus({ preventScroll: true }));
  }, [rf, storeApi, userMoved]);

  const actions = useMemo<MapActions>(() => ({
    open(path) {
      const s = useStore.getState();
      s.select(path);
      if (isNarrow()) s.setPanel('inspector');
    },
    openFolder(id) {
      const s = useStore.getState();
      userMoved();
      if (latest.current.large) s.expandMapFolder(id);
      camera.current = { kind: 'folder', id };
      if (s.mapLevel === 'files') { const b = boxesRef.current?.get(id); if (b) { camera.current = null; fitBox(b, 450, FIT_MIN_ZOOM); } }
      s.setMapLevel('files');
    },
    toggleFolder(id) {
      useStore.getState().toggleMapFolder(id);
    },
    focusNeighbor(from: string, dir: Dir) {
      const bx = boxesRef.current;
      const b = bx?.get(from);
      if (!bx || !b) return;
      const g = latest.current;
      const ids = g.level === 'folders' ? g.folders.map(f => f.id) : g.files.map(f => f.id);
      const to = nearestInDirection(b, ids.filter(i => i !== from && bx.has(i)).map(i => ({ id: i, box: bx.get(i)! })), dir);
      if (to) focusCard(to);
    },
    resetLayout() {
      pins.reset();
      mem.levels = blankLevels();
      overviewNext();
      setResetSeq(n => n + 1);
    },
    fitAll() {
      const bx = boxesRef.current;
      userMoved();
      if (bx) fitBox(boundsOf(bx.values()), 450);
    },
    spawnOf,
  }), [mem, pins, fitBox, focusCard, userMoved, spawnOf, overviewNext]);

  // A user pan or zoom pauses Follow; a press that leaves the camera where it was (a plain click) does not.
  const gesture = useRef<MoveGesture | null>(null);
  gesture.current ??= new MoveGesture();

  return (
    <MapContext.Provider value={actions}>
      <div className={['mapv', focus && 'focusing', switching && 'switching'].filter(Boolean).join(' ')} ref={wrap}>
        {/* Screen-space dot grid (prototype #gridbg): it stays crisp at every zoom. */}
        <div className="gridbg" aria-hidden="true" />
        <svg className="map-defs" width="0" height="0" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="gfresh" x1="0" x2="1">
              <stop offset="0" stopColor="#1fae55" />
              <stop offset="1" stopColor="#0a7cff" />
            </linearGradient>
          </defs>
        </svg>
        <div className="mv-canvas">
          <ReactFlow<MapFlowNode, LinkFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={(_, n) => dragStart(n.id)}
            onNodeDragStop={onNodeDragStop}
            onNodeMouseEnter={(_, n) => { if (n.type === 'file') setHover(n.id); }}
            onNodeMouseLeave={() => setHover(null)}
            onNodeDoubleClick={(_, n) => { if (n.type === 'folder' && latest.current.level === 'folders') actions.openFolder(n.id); }}
            // A real event and a changed viewport mean the user moved the camera (programmatic moves have no event).
            onMoveStart={(e, vp) => gesture.current!.begin(!!e, vp)}
            onMove={(e, vp) => { if (gesture.current!.step(!!e, vp)) userMoved(); }}
            onMoveEnd={(e, vp) => { mem.viewport = vp; if (gesture.current!.end(!!e, vp)) userMoved(); }}
            defaultViewport={mem.viewport ?? undefined}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            selectNodesOnDrag={false}
            nodeDragThreshold={3}
            panOnScroll
            zoomActivationKeyCode={ZOOM_KEYS}
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements={graph.files.length > VISIBLE_ONLY}
            minZoom={0.08}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            aria-label="Project map"
          >
            <ZoomControls fitAll={actions.fitAll} onZoom={userMoved} />
          </ReactFlow>
        </div>
        {graph.large && <div className="map-note glass" role="status">Large project: showing folders. Open a folder to see its files.</div>}
        <p className="cv-hint glass">Drag to pan · ⌘ + scroll to zoom · click a card to inspect</p>
      </div>
      {tools && createPortal(<MapTools followPaused={followPaused} />, tools)}
    </MapContext.Provider>
  );
}

/** The Map tab: every code file as a card in its folder's region, live, at three levels of detail. */
export function MapView({ run = workerRun, tools = null }: { run?: ElkRun; tools?: HTMLElement | null }) {
  const files = useStore(s => s.files);
  const count = useMemo(() => codeFileCount(files), [files]);
  if (!count) {
    return (
      <div className="viewph">
        <div className="feed-empty fi">
          <span className="fe-ic">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /><path d="M10 6.5h4a3 3 0 0 1 3 3V14" /></svg>
          </span>
          <b>No code files yet.</b>
          <p>The map fills in as files appear.</p>
        </div>
      </div>
    );
  }
  return (
    <MotionConfig reducedMotion="user">
      <ReactFlowProvider>
        <Canvas run={run} tools={tools} />
      </ReactFlowProvider>
    </MotionConfig>
  );
}

export default MapView;
