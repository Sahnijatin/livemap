import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, applyNodeChanges, useNodesInitialized, useReactFlow,
  type NodeChange, type BuiltInEdge, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Table } from '@shared/domain.js';
import { fieldKey, tableKey, useStore, type DomainBase } from '../store';
import { MAX_ROWS, NODE_W, layoutTables, relationLinks, settle, shownRows, workerRun, type ElkRun, type Pos } from '../layout/schemaLayout';
import { MORE_HANDLE, TableNode, headHandle, rowHandle, type TableFlowNode, type TableNodeData } from './TableNode';
import { SchemaIcon } from './icons';

/** Tables drawn before "Show all": the ones with the most relations. */
export const CAP = 150;
const nodeTypes = { table: TableNode };

/** The `CAP` tables with the most relations (in or out), in their original order; all of them when `all`. */
export function pickTables(tables: Table[], all: boolean): Table[] {
  if (all || tables.length <= CAP) return tables;
  const degree = new Map<string, number>(tables.map(t => [tableKey(t), 0]));
  for (const t of tables) {
    for (const r of t.relations) {
      const to = r.to.toLowerCase();
      if (!degree.has(to)) continue;
      degree.set(tableKey(t), degree.get(tableKey(t))! + 1);
      degree.set(to, degree.get(to)! + 1);
    }
  }
  const keep = new Set(
    tables.map((t, i) => ({ k: tableKey(t), d: degree.get(tableKey(t))!, i }))
      .sort((a, b) => b.d - a.d || a.i - b.i)
      .slice(0, CAP)
      .map(x => x.k),
  );
  return tables.filter(t => keep.has(tableKey(t)));
}

/** Session memory (not storage): card positions, viewport and first-render times survive tab switches. */
const positions = new Map<string, Pos>();
const firstShown = new Map<string, number>();
let savedViewport: Viewport | null = null;

/** Cards in a plain grid, for tables ELK could not place (the worker failed, crashed or timed out). */
function gridFallback(tables: Table[], prev: Map<string, Pos>): Map<string, Pos> {
  const out = new Map<string, Pos>();
  let i = 0;
  const bottom = Math.max(0, ...[...prev.values()].map(p => p.y + 400));
  for (const t of tables) {
    const p = prev.get(tableKey(t));
    if (p) { out.set(tableKey(t), p); continue; }
    out.set(tableKey(t), { x: (i % 4) * (NODE_W + 72), y: bottom + Math.floor(i / 4) * 420 });
    i++;
  }
  return out;
}

function fileCount(tables: Table[]): number {
  const s = new Set<string>();
  for (const t of tables) for (const src of t.sources) s.add(src.file);
  return s.size;
}

/** Animation length for zoom and fit; none under reduced motion. */
const motion = (ms: number): number => (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ms);

function ZoomControls() {
  const rf = useReactFlow();
  return (
    <div className="zoomctl glass" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => rf.zoomOut({ duration: motion(250) })}>−</button>
      <button type="button" aria-label="Zoom in" onClick={() => rf.zoomIn({ duration: motion(250) })}>+</button>
      <button type="button" aria-label="Fit to view" onClick={() => rf.fitView({ duration: motion(450), padding: 0.12, maxZoom: 1 })}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>
      </button>
    </div>
  );
}

function Canvas({ tables, base, run }: { tables: Table[]; base: DomainBase; run: ElkRun }) {
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [pos, setPos] = useState<Map<string, Pos>>(() => new Map(positions));
  const [nodes, setNodes] = useState<TableFlowNode[]>([]);
  const rf = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef(savedViewport !== null);

  const visible = useMemo(() => pickTables(tables, all), [tables, all]);
  const latest = useRef(visible);
  latest.current = visible;
  // Layout runs when the drawn tables change or a card's height changes (fields added or removed).
  const shape = visible.map(t => `${tableKey(t)}:${shownRows(t.fields.length)}`).join('\u0000');

  // Existing cards never move (layoutTables), except to clear a card above them that grew.
  useEffect(() => {
    let live = true;
    const list = latest.current;
    const start = new Map(positions);
    layoutTables(list, start, run)
      .catch(() => gridFallback(list, settle(list, start)))
      .then(m => {
        // A newer layout started (the drawn tables changed again): this result is stale.
        if (!live) return;
        const next = new Map<string, Pos>();
        for (const [k, p] of m) {
          // A card dragged while the layout ran stays where the user put it.
          const now = positions.get(k);
          next.set(k, start.has(k) && now && now !== start.get(k) ? now : p);
        }
        // Forget tables no longer drawn, so one that comes back is placed fresh, not into a newcomer's spot.
        positions.clear();
        for (const [k, p] of next) positions.set(k, p);
        setPos(next);
      });
    return () => { live = false; };
  }, [shape, run]);

  const onToggle = useCallback((k: string) => setExpanded(e => ({ ...e, [k]: !e[k] })), []);
  const links = useMemo(() => relationLinks(visible), [visible]);
  const near = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const l of links) if (l.from === hover || l.to === hover) { s.add(l.from); s.add(l.to); }
    return s;
  }, [hover, links]);
  const focusClass = useCallback((k: string): string | undefined => (near ? (near.has(k) ? 'hl' : 'dim') : undefined), [near]);
  const focusRef = useRef(focusClass);
  focusRef.current = focusClass;

  // Card data changes only with the domain, the baseline or expansion; hover never rebuilds it,
  // so memo(TableNode) skips re-rendering.
  const data = useMemo(() => {
    const now = Date.now();
    const out = new Map<string, TableNodeData>();
    for (const t of visible) {
      const k = tableKey(t);
      if (!firstShown.has(k)) firstShown.set(k, now);
      const isNew = !base.tables.has(k);
      out.set(k, {
        table: t,
        isNew,
        animate: isNew && now - firstShown.get(k)! < 1000,
        newFields: new Set(t.fields.filter(f => !base.fields.has(fieldKey(t, f))).map(f => f.name.toLowerCase())),
        expanded: !!expanded[k],
        onToggle,
      });
    }
    return out;
  }, [visible, base, expanded, onToggle]);

  useEffect(() => {
    const next: TableFlowNode[] = [];
    for (const [k, d] of data) {
      const p = pos.get(k);
      if (!p) continue;
      next.push({ id: k, type: 'table', position: p, zIndex: d.expanded ? 2 : 0, data: d, className: focusRef.current(k) });
    }
    // Keep React Flow's measured sizes so cards do not blink while it measures again.
    setNodes(prev => {
      const old = new Map(prev.map(n => [n.id, n]));
      return next.map(n => {
        const o = old.get(n.id);
        return o?.measured ? { ...n, measured: o.measured } : n;
      });
    });
  }, [data, pos]);

  // Hover focus: patch only the wrapper class, keeping every node's data object.
  useEffect(() => {
    setNodes(ns => {
      let changed = false;
      const out = ns.map(n => {
        const c = focusClass(n.id);
        if (n.className === c) return n;
        changed = true;
        return { ...n, className: c };
      });
      return changed ? out : ns;
    });
  }, [focusClass]);

  const edges = useMemo<BuiltInEdge[]>(() => {
    const byKey = new Map(visible.map(t => [tableKey(t), t]));
    return links.flatMap(l => {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      if (!a || !b) return [];
      const t = byKey.get(l.from)!;
      const idx = t.fields.findIndex(f => f.name.toLowerCase() === l.field.toLowerCase());
      const hiddenRow = idx >= MAX_ROWS && !expanded[l.from];
      // Leave from the side facing the target; a target in the same column is reached around the right.
      const right = b.x > a.x + NODE_W / 2;
      const left = b.x + NODE_W / 2 < a.x;
      const out = left ? 'l' : 'r';
      const into = right ? 'l' : 'r';
      const fresh = !base.tables.has(l.from) || !base.fields.has(fieldKey(t, { name: l.field }));
      const focus = !!hover && (l.from === hover || l.to === hover);
      return [{
        id: l.id,
        source: l.from,
        target: l.to,
        sourceHandle: hiddenRow ? `${MORE_HANDLE}:${out}` : rowHandle(l.field, out),
        targetHandle: headHandle(into),
        type: 'smoothstep',
        pathOptions: { borderRadius: 14, offset: 22 },
        label: l.many ? 'many' : '1',
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 7,
        animated: fresh,
        className: ['rel', fresh && 'fresh', focus && 'hl', hover && !focus && 'dim'].filter(Boolean).join(' '),
        focusable: false,
      } satisfies BuiltInEdge];
    });
  }, [links, pos, visible, expanded, base, hover]);

  // Fit once, when the first cards have been measured; afterwards the user's pan and zoom are kept.
  useEffect(() => {
    if (fitted.current || !initialized || !nodes.length) return;
    fitted.current = true;
    // Never fit smaller than a readable zoom; a large schema is centered and panned from there.
    rf.fitView({ padding: 0.12, maxZoom: 1, minZoom: 0.45, duration: 0 });
  }, [initialized, nodes.length, rf]);

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    setNodes(ns => applyNodeChanges(changes, ns));
  }, []);

  const total = tables.length;
  const capped = total > CAP;
  const files = useMemo(() => fileCount(tables), [tables]);

  return (
    <>
      <div className="sv-canvas">
        <ReactFlow<TableFlowNode, BuiltInEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, n) => { positions.set(n.id, n.position); setPos(p => new Map(p).set(n.id, n.position)); }}
          onNodeMouseEnter={(_, n) => setHover(n.id)}
          onNodeMouseLeave={() => setHover(null)}
          onMoveEnd={(_, vp) => { savedViewport = vp; }}
          defaultViewport={savedViewport ?? undefined}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements={visible.length > CAP}
          minZoom={0.08}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--grid)" />
          <ZoomControls />
        </ReactFlow>
      </div>
      {capped && (
        <div className="sv-cap glass">
          <span>{all ? `All ${total.toLocaleString()} tables` : `${CAP} of ${total.toLocaleString()} tables, most related first`}</span>
          <button type="button" onClick={() => setAll(a => !a)}>{all ? `Show top ${CAP}` : `Show all ${total.toLocaleString()}`}</button>
        </div>
      )}
      <p className="cv-hint">Tables and relations, read from {files.toLocaleString()} {files === 1 ? 'file' : 'files'}. Links are approximate.</p>
    </>
  );
}

/** The Schema tab: every table as a card, with links from foreign key rows to the tables they reference. */
export function SchemaView({ run = workerRun }: { run?: ElkRun }) {
  const tables = useStore(s => s.domain.tables);
  const base = useStore(s => s.domainBase);
  if (!tables.length) {
    return (
      <div className="viewph">
        <div className="feed-empty fi">
          <span className="fe-ic"><SchemaIcon /></span>
          <b>No tables yet.</b>
          <p>LiveMap reads Prisma, Drizzle, TypeORM, Mongoose, SQLAlchemy, SQLModel, Django, Room, SwiftData and SQL migrations.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="schemav">
      <ReactFlowProvider>
        <Canvas tables={tables} base={base} run={run} />
      </ReactFlowProvider>
    </div>
  );
}

export default SchemaView;
