import type { ApiRoute, DomainIndex } from '@shared/domain.js';
import type { UsedByEntry } from '@shared/protocol.js';
import type { CodeSymbol, FileModel } from '@shared/types.js';

/** One API request traced through the code: route, handler, the local modules it calls, and the tables they touch. */
export interface Flow {
  route: ApiRoute;
  handler: { name: string; file: string; line?: number } | null;
  services: { file: string; symbols: string[] }[];
  tables: string[];
}

function findLine(symbols: CodeSymbol[], name: string): number | undefined {
  for (const s of symbols) {
    if (s.name === name || s.qname === name) return s.line;
    const inner = findLine(s.children, name);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** The handler's line in the route file: by its full name, then by its last segment (`ctrl.list` → `list`). */
function handlerOf(r: ApiRoute, f: FileModel | undefined): Flow['handler'] {
  if (!r.handler) return null;
  if (r.handler === 'inline') return { name: r.handler, file: r.file, line: r.line };
  const syms = f?.symbols ?? [];
  const line = findLine(syms, r.handler) ?? (r.handler.includes('.') ? findLine(syms, r.handler.slice(r.handler.lastIndexOf('.') + 1)) : undefined);
  return line === undefined ? { name: r.handler, file: r.file } : { name: r.handler, file: r.file, line };
}

/**
 * Flows for every API route (pages and screens are listed separately). Services are the route file's local imports
 * that are neither route files nor schema files; tables are the dataRefs of the route file and those services.
 * Links come from imports and name matching, so they are approximate.
 */
export function buildFlows(domain: DomainIndex, files: Record<string, FileModel>, usedBy: UsedByEntry[]): Flow[] {
  const routeFiles = new Set(domain.routes.map(r => r.file));
  const refs = new Map(domain.dataRefs.map(d => [d.file, d.tables]));
  // Exported symbols used per (defining file, using file).
  const uses = new Map<string, string[]>();
  for (const e of usedBy) {
    for (const p of e.usedIn) {
      const k = `${e.file}\u0000${p}`;
      const l = uses.get(k);
      if (l) l.push(e.symbol); else uses.set(k, [e.symbol]);
    }
  }
  // Services and tables depend only on the route file, so compute them once per file.
  const perFile = new Map<string, Pick<Flow, 'services' | 'tables'>>();
  const servicesOf = (path: string): Pick<Flow, 'services' | 'tables'> => {
    let v = perFile.get(path);
    if (v) return v;
    const f = files[path];
    const services = (f?.imports.local ?? [])
      .filter(p => p !== path && !routeFiles.has(p) && !files[p]?.entities.length)
      .map(p => ({ file: p, symbols: uses.get(`${p}\u0000${path}`) ?? [] }));
    // Case-insensitive union, keeping the first spelling seen.
    const tables = new Map<string, string>();
    for (const t of [...(refs.get(path) ?? []), ...services.flatMap(s => refs.get(s.file) ?? [])]) if (!tables.has(t.toLowerCase())) tables.set(t.toLowerCase(), t);
    v = { services, tables: [...tables.values()] };
    perFile.set(path, v);
    return v;
  };
  return domain.routes
    .filter(r => r.kind === 'api')
    .map(r => {
      const { services, tables } = servicesOf(r.file);
      return { route: r, handler: handlerOf(r, files[r.file]), services, tables };
    });
}

export type LaneKind = 'route' | 'handler' | 'service' | 'table';
export const LANE_KINDS: LaneKind[] = ['route', 'handler', 'service', 'table'];

/** A deduplicated card: one per route, per (file, handler name), per service file and per table. */
export interface FlowNode { key: string; kind: LaneKind; flows: number[] }
/** A connector between two cards in neighboring lanes, shared by every flow that passes along it. */
export interface FlowEdge { key: string; from: string; to: string; flows: number[] }
export interface FlowGraph {
  lanes: FlowNode[][];
  nodes: Map<string, FlowNode>;
  edges: FlowEdge[];
  /** Card keys per flow, for tracing. */
  flowKeys: string[][];
}

export const routeKey = (f: Flow): string => `r:${f.route.id}`;
/** One card per (file, handler name); inline handlers have no name to share, so each keeps its own card (by line). */
export const handlerKey = (h: NonNullable<Flow['handler']>): string => `h:${h.file}\u0000${h.name}${h.name === 'inline' ? `@${h.line ?? 0}` : ''}`;
export const serviceKey = (file: string): string => `s:${file}`;
export const tableKey = (t: string): string => `t:${t.toLowerCase()}`;

/**
 * Cards and connectors for flows. A table links from each service that references it; a table referenced only by
 * the route file itself links from the handler (or the route when there is no handler).
 */
export function flowGraph(flows: Flow[], dataRefs: DomainIndex['dataRefs']): FlowGraph {
  const refs = new Map(dataRefs.map(d => [d.file, new Set(d.tables.map(t => t.toLowerCase()))]));
  const nodes = new Map<string, FlowNode>();
  const lanes: FlowNode[][] = [[], [], [], []];
  const edges = new Map<string, FlowEdge>();
  const flowKeys: string[][] = [];
  const node = (key: string, kind: LaneKind, i: number): void => {
    let n = nodes.get(key);
    if (!n) {
      nodes.set(key, n = { key, kind, flows: [] });
      lanes[LANE_KINDS.indexOf(kind)].push(n);
    }
    if (n.flows[n.flows.length - 1] !== i) n.flows.push(i);
  };
  const edge = (from: string, to: string, i: number): void => {
    const key = `${from}\u0001${to}`;
    let e = edges.get(key);
    if (!e) edges.set(key, e = { key, from, to, flows: [] });
    if (e.flows[e.flows.length - 1] !== i) e.flows.push(i);
  };
  flows.forEach((f, i) => {
    const keys: string[] = [];
    const r = routeKey(f);
    node(r, 'route', i);
    keys.push(r);
    let head = r;
    if (f.handler) {
      head = handlerKey(f.handler);
      node(head, 'handler', i);
      edge(r, head, i);
      keys.push(head);
    }
    for (const s of f.services) {
      const k = serviceKey(s.file);
      node(k, 'service', i);
      edge(head, k, i);
      keys.push(k);
    }
    for (const t of f.tables) {
      const k = tableKey(t);
      node(k, 'table', i);
      keys.push(k);
      const from = f.services.filter(s => refs.get(s.file)?.has(t.toLowerCase())).map(s => serviceKey(s.file));
      for (const src of from.length ? from : [head]) edge(src, k, i);
    }
    flowKeys.push(keys);
  });
  return { lanes, nodes, edges: [...edges.values()], flowKeys };
}

/**
 * Vertical positions: routes one per row; every other card sits at the average height of the cards linking into it,
 * pushed down so cards in a lane never overlap. Returns y per key and the total height.
 */
export function placeLanes(g: FlowGraph, pitch: number): { y: Map<string, number>; height: number } {
  const y = new Map<string, number>();
  const into = new Map<string, string[]>();
  for (const e of g.edges) {
    const l = into.get(e.to);
    if (l) l.push(e.from); else into.set(e.to, [e.from]);
  }
  let bottom = 0;
  g.lanes.forEach((lane, li) => {
    const want = lane.map((n, i) => {
      if (li === 0) return { n, at: i * pitch, i };
      const src = (into.get(n.key) ?? []).map(k => y.get(k)).filter((v): v is number => v !== undefined);
      return { n, at: src.length ? src.reduce((a, b) => a + b, 0) / src.length : 0, i };
    }).sort((a, b) => a.at - b.at || a.i - b.i);
    let next = 0;
    for (const w of want) {
      const at = Math.max(w.at, next);
      y.set(w.n.key, at);
      next = at + pitch;
      bottom = Math.max(bottom, at);
    }
  });
  return { y, height: bottom };
}
