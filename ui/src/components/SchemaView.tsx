import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ReactFlow, ReactFlowProvider, applyNodeChanges, useNodesInitialized, useReactFlow,
  type NodeChange, type BuiltInEdge, type FitViewOptions, type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Table } from '@shared/domain.js';
import { fieldKey, tableKey, useStore, type DomainBase } from '../store';
import {
  BOTH_WAYS_MAX, FIT_PADDING, LARGE, MAX_ROWS, NARROW_PANE, NODE_W, bounds, fitZoom, layoutDirection, mainGroup, pickLayout, layoutTables, relationLinks, schemaGroups, settle, shownLinks, shownRows, workerRun,
  type Direction, type ElkRun, type Pos,
} from '../layout/schemaLayout';
import { MORE_HANDLE, TableNode, headHandle, rowHandle, type TableFlowNode, type TableNodeData } from './TableNode';
import { TableList } from './TableList';
import { MenuIcon, SchemaIcon } from './icons';

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
/** The pane direction `positions` were laid out for; a pane that turns the other way lays every card out again. */
let laidOut: Direction | null = null;
/** The direction ELK actually ran in: the pane's, or the other one when that fits the schema larger. */
let laidDir: Direction | null = null;
/** Whether the table list is open, once the user has opened or closed it. */
let listOpen: boolean | null = null;
/** Forget the list choice, as a new session would (tests). */
export function forgetListChoice(): void { listOpen = null; }
/** Resizes settle for this long before the direction is read again, so a drag-resize lays out once. */
export const TURN_DEBOUNCE = 250;
/** Canvas width the table list covers beside it (264 px, inset 12 px, and a 12 px gap); the CSS matches. */
const LIST_W = 288;
/** The smallest zoom a first fit uses; cards are unreadable below it. */
const MIN_FIT = 0.45;

/**
 * The layout direction for the pane, whether it is narrow, and its size (`w`x`h`), read before the first paint and
 * again after resizes settle.
 */
function usePaneDirection(): [RefObject<HTMLDivElement>, Direction | null, boolean, string] {
  const ref = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState<Direction | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [size, setSize] = useState('0x0');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      // Same value: React skips the render, so steady resizes never re-lay out.
      setDir(d => layoutDirection(r.width, r.height, d ?? laidOut ?? 'RIGHT'));
      setNarrow(r.width > 0 && r.width < NARROW_PANE);
      setSize(`${Math.round(r.width)}x${Math.round(r.height)}`);
    };
    read();
    if (typeof ResizeObserver !== 'function') return;
    let t = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(read, TURN_DEBOUNCE);
    });
    ro.observe(el);
    return () => { ro.disconnect(); window.clearTimeout(t); };
  }, []);
  return [ref, dir, narrow, size];
}

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

function ZoomControls({ padding }: { padding: FitViewOptions['padding'] }) {
  const rf = useReactFlow();
  return (
    <div className="zoomctl glass" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => rf.zoomOut({ duration: motion(250) })}>−</button>
      <button type="button" className="zfit" aria-label="Fit to screen" onClick={() => rf.fitView({ duration: motion(450), padding, maxZoom: 1 })}>Fit</button>
      <button type="button" aria-label="Zoom in" onClick={() => rf.zoomIn({ duration: motion(250) })}>+</button>
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
  /** The first fit until React Flow has run it. */
  const fitting = useRef<Promise<unknown>>(Promise.resolve());
  const [paneRef, dir, narrow, paneSize] = usePaneDirection();
  const [focused, setFocused] = useState<string | null>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const [showList, setShowList] = useState(() => listOpen ?? tables.length > LARGE);
  const toggleList = useCallback((on: boolean) => { listOpen = on; setShowList(on); }, []);
  // A schema that grows past LARGE while shown opens the list, once, unless the user has chosen.
  const opened = useRef(tables.length > LARGE);
  useEffect(() => {
    // Not on a narrow pane, where the list would cover the diagram mid-use.
    if (opened.current || listOpen !== null || tables.length <= LARGE || narrow) return;
    opened.current = true;
    setShowList(true);
  }, [tables.length, narrow]);
  const [q, setQ] = useState('');
  // Esc clears the list's search, then the focus: from inside the view, or from the page body unless an open
  // slide-over panel takes it first. In capture, so it runs ahead of the panels' window listener.
  const escape = (): boolean => {
    if (showList && q) setQ('');
    else if (focused) setFocused(null);
    else return false;
    return true;
  };
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      const body = !a || a === document.body;
      if (!body && !paneRef.current?.parentElement?.contains(a)) return;
      if (body && useStore.getState().panel) return;
      if (escapeRef.current()) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [paneRef]);
  // The list sits beside the canvas on a wide pane, so fits and focus keep clear of it.
  const beside = showList && !narrow;
  const padding = useMemo<FitViewOptions['padding']>(() => (beside ? { ...FIT_PADDING, left: `${LIST_W + 24}px` as const } : FIT_PADDING), [beside]);

  const visible = useMemo(() => pickTables(tables, all), [tables, all]);
  const latest = useRef(visible);
  latest.current = visible;
  const links = useMemo(() => relationLinks(visible), [visible]);
  // A large schema's groups, shared by the layout, the drawn lines and the first fit.
  const groups = useMemo(() => (visible.length > LARGE ? schemaGroups(visible, links) : null), [visible, links]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  // Layout runs when the drawn tables change or a card's height changes (fields added or removed).
  const shape = visible.map(t => `${tableKey(t)}:${shownRows(t.fields.length)}`).join('\u0000');

  // Existing cards never move (layoutTables), except to clear a card above them that grew.
  // A pane that turned (wide to tall or back) lays every card out again in the new direction and fits.
  useEffect(() => {
    if (!dir) return;
    let live = true;
    const list = latest.current;
    const g = groupsRef.current;
    const turned = laidOut !== dir;
    const start = turned ? new Map<string, Pos>() : new Map(positions);
    const pane = paneRef.current?.getBoundingClientRect();
    // A fresh layout tries both directions and keeps the one that fits the pane larger
    // (a few tables in a chain read better stacked even in a pane slightly wider than tall).
    const fresh = async (): Promise<{ dir: Direction; value: Map<string, Pos> }> => {
      const own = await layoutTables(list, start, run, dir, g);
      if (!pane || !(pane.width > 0) || list.length < 2 || list.length > BOTH_WAYS_MAX) return { dir, value: own };
      const otherDir: Direction = dir === 'RIGHT' ? 'DOWN' : 'RIGHT';
      const other = await layoutTables(list, start, run, otherDir, g).catch(() => null);
      if (!other) return { dir, value: own };
      return pickLayout(
        { dir, zoom: fitZoom(list, own, pane.width, pane.height), value: own },
        { dir: otherDir, zoom: fitZoom(list, other, pane.width, pane.height), value: other },
      );
    };
    // Nothing placed yet (the first tables, or all new ones) is a fresh layout too.
    const placedNone = list.every(t => !start.has(tableKey(t)));
    const job = turned || placedNone ? fresh() : layoutTables(list, start, run, laidDir ?? dir, g).then(value => ({ dir: laidDir ?? dir, value }));
    job
      .catch(() => ({ dir: laidDir ?? dir, value: gridFallback(list, settle(list, start)) }))
      .then(({ dir: used, value: m }) => {
        // A newer layout started (the drawn tables changed again): this result is stale.
        if (!live) return;
        if (turned) {
          if (laidOut !== null) {
            savedViewport = null;
            // A focused table is framed again in the new layout; otherwise everything is fitted again.
            if (focusedRef.current) target.current = { key: focusedRef.current, at: null };
            else fitted.current = false;
          }
          laidOut = dir;
        }
        laidDir = used;
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
  }, [shape, run, dir, paneRef]);

  const onToggle = useCallback((k: string) => setExpanded(e => ({ ...e, [k]: !e[k] })), []);
  // The hovered and the focused table light their direct relations and dim the rest.
  const near = useMemo(() => {
    const lit = [hover, focused].filter((k): k is string => !!k);
    if (!lit.length) return null;
    const s = new Set(lit);
    for (const l of links) if (lit.includes(l.from) || lit.includes(l.to)) { s.add(l.from); s.add(l.to); }
    return s;
  }, [hover, focused, links]);
  // A table just focused pulses for a moment.
  const [pulse, setPulse] = useState<string | null>(null);
  const focusClass = useCallback((k: string): string | undefined => {
    const c = [k === pulse && 'pulse', k === focused && 'focus', near && (near.has(k) ? 'hl' : 'dim')].filter(Boolean).join(' ');
    return c || undefined;
  }, [near, pulse, focused]);
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

  // A large schema draws the links inside linked groups, plus the hovered and focused tables' own.
  const always = useMemo(() => new Set(shownLinks(visible, links, null, groups ?? undefined)), [visible, links, groups]);
  const edges = useMemo<BuiltInEdge[]>(() => {
    const byKey = new Map(visible.map(t => [tableKey(t), t]));
    return links.flatMap(l => {
      const touches = (k: string | null) => !!k && (l.from === k || l.to === k);
      if (!always.has(l) && !touches(hover) && !touches(focused)) return [];
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
      const focus = touches(hover) || touches(focused);
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
        className: ['rel', fresh && 'fresh', focus && 'hl', (hover || focused) && !focus && 'dim'].filter(Boolean).join(' '),
        focusable: false,
      } satisfies BuiltInEdge];
    });
  }, [links, always, pos, visible, expanded, base, hover, focused]);

  // Focus (the table list or the palette): mark the table, zoom to it and its direct relations, and pulse it; one
  // beyond the cap turns on "Show all" first. Requests made before this mount (another tab) are not replayed.
  // The framing waits for the table's position and is done again whenever the pane settles at another size (the
  // full-screen list closing, a phone's toolbar), until the user moves the camera; the first fit never overrides it.
  const tableFocus = useStore(s => s.tableFocus);
  const focusSeq = useRef(tableFocus?.seq ?? 0);
  /** The table to keep framed, and the pane it was last framed in (null: not framed yet). */
  const target = useRef<{ key: string; at: string | null } | null>(null);
  useEffect(() => {
    if (tableFocus && tableFocus.seq > focusSeq.current) {
      focusSeq.current = tableFocus.seq;
      const k = tableFocus.key;
      if (tables.some(t => tableKey(t) === k)) {
        target.current = { key: k, at: null };
        setFocused(k);
        if (!all && !latest.current.some(t => tableKey(t) === k)) setAll(true);
        // On a narrow pane the list covers the canvas: show the canvas, for this view only.
        if (narrow) setShowList(false);
      }
    }
    const t = target.current;
    const p = t ? pos.get(t.key) : undefined;
    const at = `${paneSize}:${beside}`;
    if (!t || !p || t.at === at) return;
    const k = t.key;
    const first = t.at === null;
    t.at = at;
    fitted.current = true;
    const h = (key: string) => rf.getNode(key)?.measured?.height ?? 160;
    const pane = paneRef.current?.getBoundingClientRect();
    if (!pane || !(pane.width > 0)) {
      // No size yet: center the table, also only after a first fit still queued in React Flow.
      void fitting.current.then(() => {
        if (target.current !== t) return;
        const zoom = Math.min(1.5, Math.max(0.8, rf.getViewport().zoom));
        void rf.setCenter(p.x + NODE_W / 2, p.y + h(k) / 2, { zoom, duration: motion(first ? 500 : 0) });
      });
    } else {
      // The table with its direct relations when they fit at a readable zoom, else the table alone.
      const left = beside ? LIST_W : 0;
      const w = pane.width - left - 48;
      const ht = pane.height - 96;
      const frame = (keys: string[]) => {
        const { x0, y0, x1, y1 } = bounds(keys, pos, h);
        return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom: Math.min(1, w / (x1 - x0), ht / (y1 - y0)) };
      };
      let f = frame([k, ...links.flatMap(l => (l.from === k ? [l.to] : l.to === k ? [l.from] : []))]);
      if (f.zoom < 0.55) f = { ...frame([k]), zoom: 0.8 };
      const vp = { x: left + 24 + w / 2 - f.cx * f.zoom, y: 24 + ht / 2 - f.cy * f.zoom, zoom: f.zoom };
      // After a first fit still queued in React Flow, which would otherwise land on top of this.
      void fitting.current.then(() => { if (target.current === t) void rf.setViewport(vp, { duration: motion(first ? 500 : 0) }); });
    }
    if (first) setPulse(k);
  }, [tableFocus, pos, tables, all, rf, links, beside, paneRef, narrow, paneSize]);
  // Without a focus there is nothing to keep framed.
  useEffect(() => {
    if (!focused) target.current = null;
  }, [focused]);
  // A focused table no longer drawn (it left the schema, or "Show top 150" hid it) is no longer focused.
  useEffect(() => {
    const waiting = target.current?.key === focused && target.current.at === null;
    if (focused && !waiting && !visible.some(t => tableKey(t) === focused)) setFocused(null);
  }, [focused, visible]);
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(null), 1600);
    return () => window.clearTimeout(t);
  }, [pulse]);

  // Fit once, when the first cards have been measured (and again after the pane turns); afterwards the
  // user's pan and zoom are kept. React Flow runs a fitView at its next node update, so `fitting` lets a focus
  // made meanwhile wait for it instead of being undone by it.
  useEffect(() => {
    if (fitted.current || !initialized || !nodes.length) return;
    fitted.current = true;
    if (target.current) return;
    // Never fit smaller than a readable zoom; a large schema that would fit smaller starts on its biggest linked group.
    const pane = paneRef.current?.getBoundingClientRect();
    let only: { id: string }[] | undefined;
    if (visible.length > LARGE && pane && pane.width > 0 && fitZoom(visible, pos, pane.width - (beside ? LIST_W : 0), pane.height) < MIN_FIT) {
      only = mainGroup(groups ?? schemaGroups(visible, links)).map(id => ({ id }));
    }
    fitting.current = rf.fitView({ nodes: only, padding, maxZoom: 1, minZoom: MIN_FIT, duration: 0 }).catch(() => false);
  }, [initialized, nodes, rf, paneRef, beside, visible, pos, padding, groups, links]);

  const onNodesChange = useCallback((changes: NodeChange<TableFlowNode>[]) => {
    setNodes(ns => applyNodeChanges(changes, ns));
  }, []);

  const total = tables.length;
  const capped = total > CAP;
  const files = useMemo(() => fileCount(tables), [tables]);
  // Relations per table, over every table drawn or not, for the list.
  const relations = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of visible === tables ? links : relationLinks(tables)) {
      m.set(l.from, (m.get(l.from) ?? 0) + 1);
      if (l.to !== l.from) m.set(l.to, (m.get(l.to) ?? 0) + 1);
    }
    return m;
  }, [tables, visible, links]);
  // The source note sits under the list when it is open, so it never runs over cards beside it.
  const hint = <p className="cv-hint">Tables and relations, read from {files.toLocaleString()} {files === 1 ? 'file' : 'files'}. Links are approximate.</p>;
  const pick = useCallback((k: string) => useStore.getState().focusTable(k), []);

  return (
    <>
      <div className="sv-canvas" ref={paneRef} data-direction={dir ?? undefined} data-list={beside ? 'beside' : undefined}>
        {/* Screen-space dot grid (prototype #gridbg): it stays crisp at every zoom. */}
        <div className="gridbg" aria-hidden="true" />
        <ReactFlow<TableFlowNode, BuiltInEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, n) => { positions.set(n.id, n.position); setPos(p => new Map(p).set(n.id, n.position)); }}
          onNodeMouseEnter={(_, n) => setHover(n.id)}
          onNodeMouseLeave={() => setHover(null)}
          onPaneClick={() => setFocused(null)}
          // A camera the user moves (pan, zoom, pinch) is theirs: the focus is no longer framed again.
          onMoveStart={e => { if (e) target.current = null; }}
          onMoveEnd={(_, vp) => { savedViewport = vp; }}
          defaultViewport={savedViewport ?? undefined}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          onlyRenderVisibleElements={visible.length > CAP}
          minZoom={0.04}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <ZoomControls padding={padding} />
        </ReactFlow>
      </div>
      {(!showList || capped) && (
        <div className="sv-top">
          {!showList && <button type="button" className="sv-open glass" onClick={() => toggleList(true)}><MenuIcon />Tables</button>}
          {capped && (
            <div className="sv-cap glass">
              <span>{all ? `All ${total.toLocaleString()} tables` : `${CAP} of ${total.toLocaleString()} tables, most related first`}</span>
              <button type="button" onClick={() => setAll(a => !a)}>{all ? `Show top ${CAP}` : `Show all ${total.toLocaleString()}`}</button>
            </div>
          )}
        </div>
      )}
      {showList && (
        <TableList
          tables={tables}
          relations={relations}
          focused={focused}
          narrow={narrow}
          onPick={pick}
          q={q}
          onQuery={setQ}
          onClose={() => toggleList(false)}
          footer={hint}
        />
      )}
      {!showList && hint}
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
