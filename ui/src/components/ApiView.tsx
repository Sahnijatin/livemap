import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import type { ApiRoute, DomainIndex } from '@shared/domain.js';
import { routeBaseKey, useStore } from '../store';
import { isNarrow } from '../media';
import { baseName } from '../recent';
import {
  LANE_KINDS, buildFlows, flowGraph, groupFlows, handlerKey, midTrunc, placeLanes, routeKey, serviceKey, tableKey,
  type Flow, type FlowGraph, type FlowGroup, type LaneKind,
} from '../api-flow';
import { MethodPill } from './MethodPill';
import { ApiIcon, Chevron, SearchIcon } from './icons';

/** Routes drawn before "Show all", first by path. */
export const CAP = 600;
/** Card height and vertical step between cards in a lane. */
const CARD_H = 44;
const PITCH = 58;
/** Group header height, the step from a header to its first route, and the extra space above every later header. */
const HEAD_H = 28;
const HEAD_PITCH = 38;
const GROUP_GAP = 14;
/** Below this pane width the lanes become one stacked chain per flow. */
const STACK_BELOW = 600;
/** Side padding of the scroll area (matches .ap-scroll and its narrower variant). */
const padFor = (width: number): number => (width < 900 ? 16 : 24);
/** The route file's font size (.ap-file reads it as --ap-file), and the characters that fit in a card this wide:
 * monospace glyphs advance a little over 0.6em, after the card's padding and border. */
const FILE_PX = 10.5;
const fileChars = (width: number): number => Math.max(12, Math.floor((width - 26) / (FILE_PX * 0.61)));
const LANES: [LaneKind, string][] = [['route', 'Routes'], ['handler', 'Handlers'], ['service', 'Services'], ['table', 'Tables']];

const FRAMEWORKS: Record<string, string> = {
  express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa', nest: 'NestJS', next: 'Next.js', sveltekit: 'SvelteKit',
  fastapi: 'FastAPI', flask: 'Flask', django: 'Django', go: 'Go net/http', gin: 'Gin', chi: 'chi', spring: 'Spring',
  rails: 'Rails', laravel: 'Laravel', 'expo-router': 'Expo Router', 'react-navigation': 'React Navigation', gorouter: 'GoRouter',
};
const frameworkName = (f: string): string => FRAMEWORKS[f] ?? f;

/** Open a file (and a line, where known) in the inspector. */
function open(path: string, line?: number): void {
  const s = useStore.getState();
  if (line) s.revealLine(path, line);
  else s.select(path);
  if (isNarrow()) s.setPanel('inspector');
}

/** Session memory (not storage): when each route card was first drawn, so the enter animation plays once. */
const firstShown = new Map<string, number>();

const byPath = (a: Flow, b: Flow): number =>
  a.route.fullPath < b.route.fullPath ? -1 : a.route.fullPath > b.route.fullPath ? 1 : a.route.method.localeCompare(b.route.method) || a.route.line - b.route.line;

/** A search matches one field at a time: method, path or file. */
const routeMatches = (q: string, r: ApiRoute): boolean => !q || [r.method, r.fullPath, r.file].some(p => p.toLowerCase().includes(q));

/**
 * Groups in drawing order under a search, how many routes match, how many of those are in open groups, and whether the
 * cap hid anything. Up to `cap` routes of open groups are drawn; once it is reached no further group is drawn, collapsed
 * headers included (the cap bar covers them).
 */
function drawGroups(all: FlowGroup[], q: string, collapsed: ReadonlySet<string>, cap: number): { rows: GroupRow[]; matched: number; drawable: number; hidden: boolean } {
  let room = cap;
  let hidden = false;
  let matched = 0;
  let drawable = 0;
  const rows: GroupRow[] = [];
  for (const gr of all) {
    const flows = gr.flows.filter(f => routeMatches(q, f.route));
    if (!flows.length) continue;
    matched += flows.length;
    const open = !collapsed.has(gr.key);
    if (open) drawable += flows.length;
    if (room <= 0) { hidden = true; continue; }
    const drawn = open ? flows.slice(0, room) : [];
    if (drawn.length < (open ? flows.length : 0)) hidden = true;
    room -= drawn.length;
    rows.push({ key: gr.key, flows: drawn, count: flows.length, open });
  }
  return { rows, matched, drawable, hidden };
}

/** A card's label, subtitle, icon and what clicking it opens; everything a lane card shows. */
interface CardData { key: string; kind: LaneKind; label: string; sub?: string; title: string; icon: ReactNode; go: () => void; isNew: boolean; enter: boolean }

const TableGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>
);

/** Card contents for every node of the graph. */
function cardData(flows: Flow[], domain: DomainIndex, base: Set<string>): Map<string, CardData> {
  const now = Date.now();
  const out = new Map<string, CardData>();
  const sources = new Map(domain.tables.map(t => [t.table.toLowerCase(), t.sources[0]]));
  for (const f of flows) {
    const r = f.route;
    const rk = routeKey(f);
    if (!out.has(rk)) {
      const bk = routeBaseKey(r);
      const isNew = !base.has(bk);
      if (!firstShown.has(bk)) firstShown.set(bk, now);
      out.set(rk, {
        key: rk, kind: 'route', label: r.fullPath, sub: r.file, title: `${r.method} ${r.fullPath}\n${r.file}:${r.line}${r.mountedVia?.length ? `\nMounted via ${r.mountedVia.join(', ')}` : ''}`,
        icon: <MethodPill method={r.method} />, go: () => open(r.file, r.line), isNew, enter: isNew && now - firstShown.get(bk)! < 1000,
      });
    }
    const h = f.handler;
    if (h && !out.has(handlerKey(h))) {
      out.set(handlerKey(h), {
        key: handlerKey(h), kind: 'handler', label: h.name, sub: h.line ? `:${h.line}` : undefined,
        title: `${h.name} in ${h.file}${h.line ? `:${h.line}` : ''}`, icon: <span className="kb k-fn">ƒ</span>, go: () => open(h.file, h.line), isNew: false, enter: false,
      });
    }
    for (const s of f.services) {
      const k = serviceKey(s.file);
      const prev = out.get(k);
      // A service used by several route files lists every symbol any of them uses.
      const syms = new Set([...(prev?.sub ? prev.sub.split(', ') : []), ...s.symbols]);
      out.set(k, {
        key: k, kind: 'service', label: baseName(s.file), sub: syms.size ? [...syms].join(', ') : undefined, title: s.file,
        icon: <span className="kb k-svc">ƒ</span>, go: () => open(s.file), isNew: false, enter: false,
      });
    }
    for (const t of f.tables) {
      const k = tableKey(t);
      if (out.has(k)) continue;
      const src = sources.get(t.toLowerCase());
      out.set(k, {
        key: k, kind: 'table', label: t, title: src ? `${t}, defined in ${src.file}:${src.line}` : t,
        icon: <span className="kb k-tbl"><TableGlyph /></span>, go: () => (src ? open(src.file, src.line) : undefined), isNew: false, enter: false,
      });
    }
  }
  return out;
}

type Focus = 'on' | 'dim' | undefined;

const Card = memo(function Card({ d, focus, style, onHot }: { d: CardData; focus: Focus; style?: CSSProperties; onHot: (k: string | null) => void }) {
  return (
    <button
      type="button"
      className={clsx('ap', `ap-${d.kind}`, focus, d.isNew && 'isnew', d.enter && 'enter')}
      data-kind={d.kind}
      data-key={d.key}
      style={style}
      title={d.title}
      onClick={d.go}
      onMouseEnter={() => onHot(d.key)}
      onMouseLeave={() => onHot(null)}
      onFocus={() => onHot(d.key)}
      onBlur={() => onHot(null)}
    >
      {d.icon}
      <span className="ap-t">{d.label}</span>
      {d.sub && <small className="ap-s">{d.sub}</small>}
      {d.isNew && <i className="newtag">NEW</i>}
    </button>
  );
});

/** A route row: picking it (click, Enter) traces its flow; its file (`sub`) under the path opens in the inspector. */
const RouteCard = memo(function RouteCard({ d, focus, picked, chars, style, onHot, onPick }: {
  d: CardData; focus: Focus; picked: boolean; chars: number; style?: CSSProperties; onHot: (k: string | null) => void; onPick: (k: string) => void;
}) {
  return (
    <div
      className={clsx('ap', 'ap-route', focus, picked && 'picked', d.isNew && 'isnew', d.enter && 'enter')}
      data-kind="route"
      data-key={d.key}
      style={style}
      title={d.title}
      onClick={() => onPick(d.key)}
      onMouseEnter={() => onHot(d.key)}
      onMouseLeave={() => onHot(null)}
      onFocus={() => onHot(d.key)}
      onBlur={() => onHot(null)}
    >
      <button type="button" className="ap-pick" aria-pressed={picked}>
        {d.icon}
        <span className="ap-t">{d.label}</span>
        {d.isNew && <i className="newtag">NEW</i>}
      </button>
      <button type="button" className="ap-file" onClick={e => { e.stopPropagation(); d.go(); }}>
        {midTrunc(d.sub!, chars)}
      </button>
    </div>
  );
});

/** A route group: the routes drawn (none when collapsed, fewer when the cap cuts it), how many match, whether it is open. */
interface GroupRow { key: string; flows: Flow[]; count: number; open: boolean }

function GroupHead({ row, style, onToggle }: { row: GroupRow; style?: CSSProperties; onToggle: (k: string) => void }) {
  return (
    <button type="button" className={clsx('ap-gh', row.open && 'open')} style={style} aria-expanded={row.open} onClick={() => onToggle(row.key)}>
      <Chevron />
      <code className="ap-gk">{row.key}</code>
      <span className="ap-gn">{row.open && row.flows.length < row.count ? `${row.flows.length.toLocaleString()} of ${row.count.toLocaleString()}` : row.count.toLocaleString()}</span>
    </button>
  );
}

/** The scroll area's width (padding included, scrollbar excluded), followed with ResizeObserver; 0 until measured. */
function useWidth(ref: RefObject<HTMLElement>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Lane widths relative to a unit: routes widest, tables narrowest. */
const WEIGHTS = [1.5, 0.9, 1.05, 0.85];
const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);

/** Lane x positions and widths for a pane width; gaps (where the curves run) scale with the pane. */
function laneGeometry(width: number): { x: number[]; w: number[]; total: number } {
  const avail = Math.max(0, width - padFor(width) * 2);
  const gap = Math.round(Math.min(84, Math.max(28, avail * 0.045)));
  const unit = Math.min(240, (avail - gap * 3) / WEIGHT_SUM);
  const w = WEIGHTS.map(k => Math.floor(unit * k));
  const x: number[] = [];
  let at = 0;
  for (const lw of w) { x.push(at); at += lw + gap; }
  return { x, w, total: at - gap };
}

/** The flows the hovered or picked card traces, and whether to draw its lines (routes only). */
function useTrace(g: FlowGraph, hot: string | null, picked: string | null): { active: Set<number> | null; lines: boolean } {
  return useMemo(() => {
    // A hovered route previews its flow; any other hovered card gives way to a pick.
    const h = hot && g.nodes.has(hot) ? hot : null;
    const p = picked && g.nodes.has(picked) ? picked : null;
    const k = h && (g.nodes.get(h)!.kind === 'route' || !p) ? h : p;
    if (!k) return { active: null, lines: false };
    return { active: new Set(g.nodes.get(k)!.flows), lines: g.nodes.get(k)!.kind === 'route' };
  }, [g, hot, picked]);
}

interface ViewProps { g: FlowGraph; groups: GroupRow[]; cards: Map<string, CardData>; hot: string | null; picked: string | null; onHot: (k: string | null) => void; onPick: (k: string) => void; onToggle: (k: string) => void; width: number }

function Lanes({ g, groups, cards, hot, picked, onHot, onPick, onToggle, width }: ViewProps) {
  const geo = useMemo(() => laneGeometry(width), [width]);
  // Route rows under their group headers; the other lanes follow the routes.
  const { heads, routeY, end } = useMemo(() => {
    const heads = new Map<string, number>();
    const routeY = new Map<string, number>();
    let at = 0;
    groups.forEach((row, i) => {
      if (i) at += GROUP_GAP;
      heads.set(row.key, at);
      at += HEAD_PITCH;
      if (row.open) for (const f of row.flows) { routeY.set(routeKey(f), at); at += PITCH; }
    });
    return { heads, routeY, end: at };
  }, [groups]);
  const { y, height } = useMemo(() => placeLanes(g, PITCH, routeY), [g, routeY]);
  // Card styles change only with layout, so hover re-renders only cards whose focus changed (memo).
  const styles = useMemo(() => {
    const m = new Map<string, CSSProperties>();
    LANE_KINDS.forEach((_, li) => {
      for (const n of g.lanes[li]) m.set(n.key, { width: geo.w[li], transform: `translate(${geo.x[li]}px,${y.get(n.key)}px)` });
    });
    for (const [k, at] of heads) m.set(`g:${k}`, { width: geo.w[0], transform: `translate(${geo.x[0]}px,${at}px)` });
    return m;
  }, [g, y, heads, geo]);
  const lane = (k: LaneKind) => LANE_KINDS.indexOf(k);

  // Tracing: a route follows its flow; any other card follows every flow through it.
  const { active, lines } = useTrace(g, hot, picked);
  const lit = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>();
    for (const i of active) for (const k of g.flowKeys[i]) s.add(k);
    return s;
  }, [active, g]);
  const focusOf = (k: string): Focus => (lit ? (lit.has(k) ? 'on' : 'dim') : undefined);
  const chars = fileChars(geo.w[0]);

  const h = Math.max(height + CARD_H, end - HEAD_PITCH + HEAD_H);
  return (
    <div className="ap-board" style={{ width: geo.total, height: h + 40 }}>
      {LANES.map(([k, label], i) => (
        <div className="lane-h" key={k} style={{ left: geo.x[i], width: geo.w[i] }}>
          <b>{label}</b><small>{g.lanes[i].length.toLocaleString()}</small>
        </div>
      ))}
      <div className="ap-cards">
        <svg className="ap-edges" width={geo.total} height={h} aria-hidden="true">
          {lines && active && g.edges.filter(e => e.flows.some(f => active.has(f))).map(e => {
            const la = lane(g.nodes.get(e.from)!.kind);
            const lb = lane(g.nodes.get(e.to)!.kind);
            const x1 = geo.x[la] + geo.w[la];
            const y1 = y.get(e.from)! + CARD_H / 2;
            const x2 = geo.x[lb];
            const y2 = y.get(e.to)! + CARD_H / 2;
            const mx = (x1 + x2) / 2;
            return <path key={e.key} className="e flow" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
          })}
        </svg>
        {groups.map(row => (
          <Fragment key={row.key}>
            <GroupHead row={row} style={styles.get(`g:${row.key}`)} onToggle={onToggle} />
            {row.flows.map(f => {
              const k = routeKey(f);
              return <RouteCard key={k} d={cards.get(k)!} focus={focusOf(k)} picked={picked === k} chars={chars} onHot={onHot} onPick={onPick} style={styles.get(k)} />;
            })}
          </Fragment>
        ))}
        {g.lanes.slice(1).flat().map(n => (
          <Card key={n.key} d={cards.get(n.key)!} focus={focusOf(n.key)} onHot={onHot} style={styles.get(n.key)} />
        ))}
      </div>
    </div>
  );
}

/** Narrow panes: route rows by group; the picked route shows its handler, services and tables in a chain below it. */
function Chains({ groups, cards, picked, onHot, onPick, onToggle, width }: ViewProps) {
  const chars = fileChars(width - 24);
  return (
    <div className="ap-chains">
      {groups.map(row => (
        <div className="ap-grp" key={row.key}>
          <GroupHead row={row} onToggle={onToggle} />
          {row.flows.map(f => {
            const k = routeKey(f);
            const keys = k === picked ? [f.handler && handlerKey(f.handler), ...f.services.map(s => serviceKey(s.file)), ...f.tables.map(tableKey)].filter((x): x is string => !!x) : [];
            return (
              <div className="ap-chain" key={k}>
                <RouteCard d={cards.get(k)!} focus={undefined} picked={k === picked} chars={chars} onHot={onHot} onPick={onPick} />
                {keys.length > 0 && (
                  <div className="ap-links">
                    {keys.map(x => <Card key={x} d={cards.get(x)!} focus={undefined} onHot={onHot} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PageList({ title, routes }: { title: string; routes: ApiRoute[] }) {
  return (
    <section className={clsx('ap-sec', title === 'Screens' && 'screens')}>
      <h4>{title} · {routes.length.toLocaleString()}</h4>
      <div className="pg-list">
        {routes.map(r => (
          <button type="button" className="pg-row" key={r.id} data-key={`r:${r.id}`} onClick={() => open(r.file, r.line)} title={`${r.file}:${r.line}`}>
            <code className="pg-p">{r.fullPath}</code>
            <span className="pg-fw">{frameworkName(r.framework)}</span>
            <span className="pg-f">{r.file}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Flows({ domain }: { domain: DomainIndex }) {
  const files = useStore(s => s.files);
  const usedBy = useStore(s => s.usedBy);
  const base = useStore(s => s.domainBase.routes);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const width = useWidth(scroller);
  const stacked = width > 0 && width < STACK_BELOW;
  const onHot = useCallback((k: string | null) => setHot(k), []);
  // Un-picking also clears the hover trace, so the row stays quiet until the next enter or focus.
  const unpick = useCallback(() => { setPicked(null); setHot(null); }, []);
  const onPick = useCallback((k: string) => {
    if (pickedRef.current === k) unpick();
    else setPicked(k);
  }, [unpick]);
  const onToggle = useCallback((k: string) => setCollapsed(c => {
    const n = new Set(c);
    if (!n.delete(k)) n.add(k);
    return n;
  }), []);

  const sorted = useMemo(() => buildFlows(domain, files, usedBy).sort(byPath), [domain, files, usedBy]);
  // Groups come from every route, so a filter narrows a group without regrouping.
  const allGroups = useMemo(() => groupFlows(sorted), [sorted]);
  const needle = q.trim().toLowerCase();
  // Collapsed groups whose routes all left are forgotten.
  useEffect(() => {
    const keys = new Set(allGroups.map(gr => gr.key));
    if ([...collapsed].some(k => !keys.has(k))) setCollapsed(new Set([...collapsed].filter(k => keys.has(k))));
  }, [allGroups, collapsed]);
  const { rows: groups, matched, drawable, hidden } = useMemo(() => drawGroups(allGroups, needle, collapsed, all ? Infinity : CAP), [allGroups, needle, collapsed, all]);
  // The cap bar shows whenever the cap hides a route or group (or would, with "Show all" on).
  const capHides = useMemo(() => (all ? drawGroups(allGroups, needle, collapsed, CAP).hidden : hidden), [all, allGroups, needle, collapsed, hidden]);
  const shown = useMemo(() => groups.flatMap(gr => gr.flows), [groups]);
  const g = useMemo(() => flowGraph(shown, domain.dataRefs), [shown, domain.dataRefs]);
  const cards = useMemo(() => cardData(shown, domain, base), [shown, domain, base]);
  // A card that left (filter, collapse, domain update) cannot stay hot.
  const liveHot = hot && g.nodes.has(hot) ? hot : null;
  useEffect(() => { if (hot && !liveHot) setHot(null); }, [hot, liveHot]);
  // Nor stay picked: a pick hidden by the search or a collapse is dropped, never brought back later.
  useEffect(() => { if (picked && !g.nodes.has(picked)) setPicked(null); }, [picked, g]);
  const pages = useMemo(() => domain.routes.filter(r => r.kind === 'page' && routeMatches(needle, r)).sort((a, b) => a.fullPath.localeCompare(b.fullPath)), [domain.routes, needle]);
  const screens = useMemo(() => domain.routes.filter(r => r.kind === 'screen' && routeMatches(needle, r)).sort((a, b) => a.fullPath.localeCompare(b.fullPath)), [domain.routes, needle]);
  const total = sorted.length;

  // Palette trace: show the route (clearing a filter that hides it, opening its group, "Show all" beyond the cap),
  // pick it and scroll it into view. Requests made before this mount (another tab) are not replayed.
  const routeTrace = useStore(s => s.routeTrace);
  const traceSeq = useRef(routeTrace?.seq ?? 0);
  const pendingTrace = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (routeTrace && routeTrace.seq > traceSeq.current) {
      traceSeq.current = routeTrace.seq;
      const r = domain.routes.find(x => x.id === routeTrace.id);
      if (r) {
        pendingTrace.current = { id: r.id, at: Date.now() };
        const passes = routeMatches(needle, r);
        if (!passes) setQ('');
        if (r.kind === 'api') {
          // Its place in the drawing order once its group is open, under the search that stays.
          const own = allGroups.find(gr => gr.flows.some(f => f.route.id === r.id))?.key;
          const open = new Set(collapsed);
          if (own && open.delete(own)) onToggle(own);
          const at = drawGroups(allGroups, passes ? needle : '', open, Infinity).rows.flatMap(gr => gr.flows).findIndex(f => f.route.id === r.id);
          if (!all && at >= CAP) setAll(true);
        }
      }
    }
    const pending = pendingTrace.current;
    if (!pending) return;
    // Not drawn within a few seconds (it left the domain meanwhile): give up rather than jump later.
    if (Date.now() - pending.at > 3000) { pendingTrace.current = null; return; }
    const key = `r:${pending.id}`;
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find(e => e.dataset.key === key);
    if (!el) return;
    pendingTrace.current = null;
    if (g.nodes.has(key)) setPicked(key);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [routeTrace, domain.routes, needle, all, allGroups, collapsed, onToggle, g]);

  // Esc clears the search, then the pick, and is left to the panels when neither is there; the arrow keys walk
  // the search box, group headers, route rows and their files.
  const escape = (): boolean => {
    if (q) setQ('');
    else if (picked) unpick();
    else return false;
    return true;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (escape()) e.preventDefault();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [input.current!, ...(scroller.current?.querySelectorAll<HTMLElement>('.ap-gh, .ap-pick, .ap-file') ?? [])];
    const i = items.indexOf(t);
    if (i < 0) return;
    const next = items[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  };

  // A mouse pick leaves focus on <body> in Safari and Firefox, so while a route is picked Esc from there clears it
  // too; in capture, so it runs ahead of the panels' window listener.
  const escapeRef = useRef(escape);
  escapeRef.current = escape;
  useEffect(() => {
    if (!picked) return;
    const onWinKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      // An open slide-over panel takes Esc first (the panels close it).
      if (useStore.getState().panel) return;
      if (escapeRef.current()) e.preventDefault();
    };
    window.addEventListener('keydown', onWinKey, true);
    return () => window.removeEventListener('keydown', onWinKey, true);
  }, [picked]);

  const view: ViewProps = { g, groups, cards, hot: liveHot, picked, onHot, onPick, onToggle, width: width || 1000 };
  return (
    <div className={clsx('apiv', stacked && 'stacked', !stacked && width > 0 && width < 900 && 'tight')} style={{ '--ap-file': `${FILE_PX}px` } as CSSProperties} onKeyDown={onKey}>
      <div className="ap-scroll" ref={scroller}>
        <div className="ap-bar">
          <label className="ap-filter glass">
            <SearchIcon />
            <input ref={input} type="search" placeholder="Filter by method, path or file" aria-label="Filter routes" value={q} onChange={e => setQ(e.target.value)} />
          </label>
          <span className="ap-count">
            {needle ? `${matched.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()} {total === 1 ? 'endpoint' : 'endpoints'}
          </span>
          {total > 0 && <p className="ap-hint">{stacked ? 'Tap a route to see its flow. Links are approximate.' : 'Hover or select a route to trace it. Links are approximate.'}</p>}
        </div>
        {total > 0 && matched === 0 && <p className="ap-none">No routes match “{q.trim()}”.</p>}
        {groups.length > 0 && (stacked ? <Chains {...view} /> : <Lanes {...view} />)}
        {capHides && (
          <div className="ap-cap glass">
            <span>{all ? `All ${drawable.toLocaleString()} routes` : drawable > CAP ? `First ${CAP} of ${drawable.toLocaleString()} routes, by path` : `First ${CAP} routes, by path`}</span>
            <button type="button" onClick={() => setAll(a => !a)}>{all ? `Show first ${CAP}` : drawable > CAP ? `Show all ${drawable.toLocaleString()}` : 'Show all'}</button>
          </div>
        )}
        {pages.length > 0 && <PageList title="Pages" routes={pages} />}
        {screens.length > 0 && <PageList title="Screens" routes={screens} />}
      </div>
    </div>
  );
}

/** The API tab: request-flow lanes (Routes by group, Handlers, Services, Tables), then pages and screens. */
export function ApiView() {
  const domain = useStore(s => s.domain);
  if (!domain.routes.length) {
    return (
      <div className="viewph">
        <div className="feed-empty fi">
          <span className="fe-ic"><ApiIcon /></span>
          <b>No routes yet.</b>
          <p>
            LiveMap reads Express, Fastify, Hono, Koa, NestJS, Next.js, SvelteKit, FastAPI, Flask, Django, Go net/http, gin, chi,
            Spring, Rails and Laravel routes, and Expo Router, React Navigation and GoRouter screens.
          </p>
        </div>
      </div>
    );
  }
  return <Flows domain={domain} />;
}
