import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import type { ApiRoute, DomainIndex } from '@shared/domain.js';
import { routeBaseKey, useStore } from '../store';
import { isNarrow } from '../media';
import { baseName } from '../recent';
import {
  LANE_KINDS, buildFlows, flowGraph, handlerKey, placeLanes, routeKey, serviceKey, tableKey,
  type Flow, type FlowGraph, type LaneKind,
} from '../api-flow';
import { MethodPill } from './MethodPill';
import { ApiIcon, SearchIcon } from './icons';

/** Routes drawn before "Show all", first by path. */
export const CAP = 600;
/** Card height and vertical step between cards in a lane. */
const CARD_H = 44;
const PITCH = 58;
/** Below this pane width the lanes become one stacked chain per flow. */
const STACK_BELOW = 600;
/** Side padding of the scroll area (matches .ap-scroll and its narrower variant). */
const padFor = (width: number): number => (width < 900 ? 16 : 24);
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

const matches = (q: string, ...parts: string[]): boolean => !q || parts.join(' ').toLowerCase().includes(q);

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
        key: rk, kind: 'route', label: r.fullPath, title: `${r.method} ${r.fullPath}\n${r.file}:${r.line}${r.mountedVia?.length ? `\nMounted via ${r.mountedVia.join(', ')}` : ''}`,
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

function Lanes({ g, cards, hot, onHot, width }: { g: FlowGraph; cards: Map<string, CardData>; hot: string | null; onHot: (k: string | null) => void; width: number }) {
  const geo = laneGeometry(width);
  const { y, height } = useMemo(() => placeLanes(g, PITCH), [g]);
  // Card styles change only with layout, so hover re-renders only cards whose focus changed (memo(Card)).
  const styles = useMemo(() => {
    const lg = laneGeometry(width);
    const m = new Map<string, CSSProperties>();
    LANE_KINDS.forEach((_, li) => {
      for (const n of g.lanes[li]) m.set(n.key, { width: lg.w[li], transform: `translate(${lg.x[li]}px,${y.get(n.key)}px)` });
    });
    return m;
  }, [g, y, width]);
  const lane = (k: LaneKind) => LANE_KINDS.indexOf(k);

  // Tracing: hovering a route follows that flow; any other card follows every flow through it.
  const active = useMemo(() => {
    if (!hot) return null;
    const n = g.nodes.get(hot);
    if (!n) return null;
    return new Set(n.flows);
  }, [hot, g]);
  const lit = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>();
    for (const i of active) for (const k of g.flowKeys[i]) s.add(k);
    return s;
  }, [active, g]);
  const focusOf = (k: string): Focus => (lit ? (lit.has(k) ? 'on' : 'dim') : undefined);

  const h = height + CARD_H;
  return (
    <div className="ap-board" style={{ width: geo.total, height: h + 40 }}>
      {LANES.map(([k, label], i) => (
        <div className="lane-h" key={k} style={{ left: geo.x[i], width: geo.w[i] }}>
          <b>{label}</b><small>{g.lanes[i].length.toLocaleString()}</small>
        </div>
      ))}
      <div className="ap-cards">
        <svg className="ap-edges" width={geo.total} height={h} aria-hidden="true">
          {g.edges.map(e => {
            const a = g.nodes.get(e.from)!;
            const b = g.nodes.get(e.to)!;
            const la = lane(a.kind);
            const lb = lane(b.kind);
            const x1 = geo.x[la] + geo.w[la];
            const y1 = y.get(e.from)! + CARD_H / 2;
            const x2 = geo.x[lb];
            const y2 = y.get(e.to)! + CARD_H / 2;
            const mx = (x1 + x2) / 2;
            const on = active ? e.flows.some(f => active.has(f)) : false;
            return <path key={e.key} className={clsx('e', on && 'flow', active && !on && 'dim')} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
          })}
        </svg>
        {LANE_KINDS.map((k, li) => g.lanes[li].map(n => (
          <Card
            key={n.key}
            d={cards.get(n.key)!}
            focus={focusOf(n.key)}
            onHot={onHot}
            style={styles.get(n.key)}
          />
        )))}
      </div>
    </div>
  );
}

/** Narrow panes: each flow as a route card with its handler, services and tables in an indented chain below it. */
function Chains({ flows, cards, onHot }: { flows: Flow[]; cards: Map<string, CardData>; onHot: (k: string | null) => void }) {
  return (
    <div className="ap-chains">
      {flows.map(f => {
        const keys = [f.handler && handlerKey(f.handler), ...f.services.map(s => serviceKey(s.file)), ...f.tables.map(tableKey)].filter((k): k is string => !!k);
        return (
          <div className="ap-chain" key={routeKey(f)}>
            <Card d={cards.get(routeKey(f))!} focus={undefined} onHot={onHot} />
            {keys.length > 0 && (
              <div className="ap-links">
                {keys.map(k => <Card key={k} d={cards.get(k)!} focus={undefined} onHot={onHot} />)}
              </div>
            )}
          </div>
        );
      })}
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
  const scroller = useRef<HTMLDivElement>(null);
  const width = useWidth(scroller);
  const stacked = width > 0 && width < STACK_BELOW;
  const onHot = useCallback((k: string | null) => setHot(k), []);

  const sorted = useMemo(() => buildFlows(domain, files, usedBy).sort(byPath), [domain, files, usedBy]);
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(() => sorted.filter(f => matches(needle, f.route.method, f.route.fullPath)), [sorted, needle]);
  const shown = useMemo(() => (all ? filtered : filtered.slice(0, CAP)), [filtered, all]);
  const g = useMemo(() => flowGraph(shown, domain.dataRefs), [shown, domain.dataRefs]);
  const cards = useMemo(() => cardData(shown, domain, base), [shown, domain, base]);
  // A card that left (filter, domain update) cannot stay hot.
  const liveHot = hot && g.nodes.has(hot) ? hot : null;
  useEffect(() => { if (hot && !liveHot) setHot(null); }, [hot, liveHot]);
  const pages = useMemo(() => domain.routes.filter(r => r.kind === 'page' && matches(needle, r.fullPath, r.framework)).sort((a, b) => a.fullPath.localeCompare(b.fullPath)), [domain.routes, needle]);
  const screens = useMemo(() => domain.routes.filter(r => r.kind === 'screen' && matches(needle, r.fullPath, r.framework)).sort((a, b) => a.fullPath.localeCompare(b.fullPath)), [domain.routes, needle]);
  const total = sorted.length;

  // Palette trace: show the route (clearing a filter that hides it, "Show all" beyond the cap), trace it like a
  // hover and scroll it into view. Requests made before this mount (another tab) are not replayed.
  const routeTrace = useStore(s => s.routeTrace);
  const traceSeq = useRef(routeTrace?.seq ?? 0);
  const pendingTrace = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    if (routeTrace && routeTrace.seq > traceSeq.current) {
      traceSeq.current = routeTrace.seq;
      const r = domain.routes.find(x => x.id === routeTrace.id);
      if (r) {
        pendingTrace.current = { id: r.id, at: Date.now() };
        const passes = r.kind === 'api' ? matches(needle, r.method, r.fullPath) : matches(needle, r.fullPath, r.framework);
        if (!passes) setQ('');
        if (r.kind === 'api' && !all && (passes ? filtered : sorted).findIndex(f => f.route.id === r.id) >= CAP) setAll(true);
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
    if (g.nodes.has(key)) setHot(key);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [routeTrace, domain.routes, needle, all, filtered, sorted, g]);

  return (
    <div className={clsx('apiv', stacked && 'stacked', !stacked && width > 0 && width < 900 && 'tight')}>
      <div className="ap-scroll" ref={scroller}>
        <div className="ap-bar">
          <label className="ap-filter glass">
            <SearchIcon />
            <input type="search" placeholder="Filter by path or method" aria-label="Filter routes" value={q} onChange={e => setQ(e.target.value)} />
          </label>
          <span className="ap-count">
            {needle ? `${filtered.length.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()} {total === 1 ? 'endpoint' : 'endpoints'}
          </span>
        </div>
        {total > 0 && filtered.length === 0 && <p className="ap-none">No routes match “{q.trim()}”.</p>}
        {shown.length > 0 && (stacked
          ? <Chains flows={shown} cards={cards} onHot={onHot} />
          : <Lanes g={g} cards={cards} hot={liveHot} onHot={onHot} width={width || 1000} />)}
        {filtered.length > CAP && (
          <div className="ap-cap glass">
            <span>{all ? `All ${filtered.length.toLocaleString()} routes` : `First ${CAP} of ${filtered.length.toLocaleString()} routes, by path`}</span>
            <button type="button" onClick={() => setAll(a => !a)}>{all ? `Show first ${CAP}` : `Show all ${filtered.length.toLocaleString()}`}</button>
          </div>
        )}
        {pages.length > 0 && <PageList title="Pages" routes={pages} />}
        {screens.length > 0 && <PageList title="Screens" routes={screens} />}
      </div>
      <p className="cv-hint">
        {stacked ? 'Tap a card to open it. Links between files are approximate.' : 'Hover a route to trace the request through the code. Links between files are approximate.'}
      </p>
    </div>
  );
}

/** The API tab: request-flow lanes (Routes, Handlers, Services, Tables), then pages and screens. */
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
