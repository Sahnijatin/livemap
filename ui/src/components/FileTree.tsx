import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { arrivals, useStore } from '../store';
import { NARROW_QUERY, isNarrow, useMedia } from '../media';
import { INERT, afterSelect, shownLayout } from '../panels';
import { prefersReducedMotion } from '../scroll';
import { useCurrentTarget } from '../live';
import { LAYERS } from '../layers';
import { latestChange, type SymbolTag } from '../changes';
import { useLiveRecent } from '../recent';
import {
  BIG_PROJECT, DIR_BATCH, NO_PATHS, ancestors, editSet as edit, buildTree, cachedTags, chainOpen, closedAbove, dirActivity, dirKey, loadTreeState, moreKey,
  saveTreeState, visibleItems, type Activity, type DirState, type Item, type Row,
} from '../treeModel';
import { FileRow, MidName } from './FileRow';
import { showPicked, toggleDir as toggleIn, treeKeyDown, type TreeContext } from './treeActions';
import { CollapseButton } from './Dock';
import { usePrefersReducedMotion } from '../motion';
import { Chevron, SearchIcon } from './icons';

const POP_MS = 700;
/** Auto-reveal pauses this long after the user scrolls the tree. */
const USER_SCROLL_HOLD_MS = 5000;
/** Scroll events this soon after our own scrollIntoView are the animation, not the user. */
const SELF_SCROLL_MS = 900;
/** A reveal whose row has not shown by then is dropped (a file the agent creates is indexed well within it). */
const REVEAL_WAIT_MS = 10_000;
/** Folder choices are saved this long after the last change, and right away when the page is hidden or closed. */
const SAVE_MS = 300;
const EMPTY_TAGS = new Map<string, SymbolTag>();
const NO_LIMITS: ReadonlyMap<string, number> = new Map();
/** A closed folder's activity dot label; its title reads "A file in this folder is <label>". */
const ACTIVITY: Record<Activity, string> = { now: 'being written', edited: 'edited', new: 'new' };
/**
 * This session's folder overrides, never saved: `picked` folders opened to show a file the user selected,
 * `closed` folders the user closed (the agent's reveals leave them shut), `agentAt` the agent file being shown, and
 * `blocked` an agent file that arrived under a folder the user closed (it opens nothing, even once that reopens).
 */
export type Session = { picked: ReadonlySet<string>; closed: ReadonlySet<string>; agentAt: string | null; blocked?: string | null };
export type Moving = { kind: 'fold' | 'unfold'; until: number; rows: Item[] };

export function FileTree() {
  const files = useStore(s => s.files);
  const projectRoot = useStore(s => s.root);
  const filter = useStore(s => s.filter);
  const setFilter = useStore(s => s.setFilter);
  const expanded = useStore(s => s.expanded);
  const selected = useStore(s => s.selected);
  const recent = useStore(s => s.recent);
  const changes = useStore(s => s.changes);
  const helloAt = useStore(s => s.helloAt);
  /** A row pops while its file has just arrived (after the hello's first second), never for a folder opening. */
  const popsAt = (path: string, now: number): boolean => {
    const t = arrivals.get(path);
    return t !== undefined && t > helloAt + 1000 && now - t < POP_MS;
  };
  const panel = useStore(s => s.panel);
  const collapsed = useStore(s => shownLayout(s).collapsed.files);
  // Below 1080 px a closed slide-over is off screen, and wider a collapsed panel is hidden: keep it out of the tab order.
  const narrow = useMedia(NARROW_QUERY);
  const live = useLiveRecent(recent);
  const target = useCurrentTarget();
  const targetPath = target?.path ?? null;
  const userScrolledAt = useRef(0);
  const selfScrollUntil = useRef(0);
  /** The file to scroll to once its row shows, when it was asked for, and under which filter. */
  const [reveal, setReveal] = useState<{ path: string; at: number; q: string } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  /** Mounted rows by nav key (ids can hold a NUL, which a CSS selector cannot match). */
  const rowEls = useRef(new Map<string, HTMLElement>());
  /** One stable ref callback per row id, so re-renders do not detach and re-attach rows. */
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const refFor = useCallback((k: string) => {
    let f = refs.current.get(k);
    if (!f) {
      f = el => {
        if (el) rowEls.current.set(k, el);
        else if (refs.current.get(k) === f) { rowEls.current.delete(k); refs.current.delete(k); } // not a remount's newer callback
      };
      refs.current.set(k, f);
    }
    return f;
  }, []);
  const [focused, setFocused] = useState<string | null>(null);
  // App keys this component by project, so every piece of state here belongs to one project.
  // Folders the user opened or closed, by full path, remembered per project. Folders without an entry follow the defaults.
  const [dirs, setDirs] = useState<DirState>(() => loadTreeState(projectRoot));
  const loaded = useRef(dirs);
  const [session, setSession] = useState<Session>({ picked: NO_PATHS, closed: NO_PATHS, agentAt: null });
  /** Folders closed while a filter is on; forgotten with the filter. */
  const [filterClosed, setFilterClosed] = useState<{ q: string; dirs: ReadonlySet<string> }>({ q: '', dirs: NO_PATHS });
  const reduced = usePrefersReducedMotion();
  /** Folders mid-animation: a folding one keeps its rows (inert) until its fold ends. */
  const [moving, setMoving] = useState<ReadonlyMap<string, Moving>>(() => new Map());
  const [limits, setLimits] = useState<{ q: string; byDir: ReadonlyMap<string, number> }>({ q: '', byDir: NO_LIMITS });

  const q = filter.trim().toLowerCase();
  const dirLimit = limits.q === q ? limits.byDir : NO_LIMITS;
  const closedNow = filterClosed.q === q ? filterClosed.dirs : NO_PATHS;
  const { root: tree, layers } = useMemo(() => buildTree(files, q), [files, q]);
  const fileCount = useMemo(() => Object.keys(files).length, [files]);
  // Big or not is decided once, at the first render with files (App keys the tree by project, so once per project).
  const [bigAt, setBigAt] = useState<boolean | null>(null);
  if (bigAt === null && fileCount > 0) setBigAt(fileCount >= BIG_PROJECT);
  const big = bigAt ?? fileCount >= BIG_PROJECT;

  const pending = useRef<DirState | null>(null);
  const flush = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    if (p) saveTreeState(projectRoot, p);
  }, [projectRoot]);
  useEffect(() => {
    if (dirs === loaded.current) return; // as read from storage: nothing to write back
    pending.current = dirs;
    const t = window.setTimeout(flush, SAVE_MS);
    return () => window.clearTimeout(t);
  }, [dirs, flush]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); }; // mobile browsers may not fire pagehide
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); flush(); };
  }, [flush]);
  const latest = useRef({ closed: session.closed, q });
  latest.current = { closed: session.closed, q };
  // The agent's file shows its folders until the agent moves on; folders the user closed this session stay shut.
  const agentDirs = useMemo(() => {
    const at = session.agentAt;
    // Nothing opens under a folder the user closed this session.
    if (at === null || at === session.blocked || ancestors(at).some(a => session.closed.has(a))) return NO_PATHS;
    return edit(NO_PATHS, closedAbove(at, dirs, big, session.picked));
  }, [session, dirs, big]);
  const revealed = useMemo(() => (agentDirs.size ? edit(session.picked, [...agentDirs]) : session.picked), [session.picked, agentDirs]);

  const activity = useMemo(() => dirActivity(live, targetPath), [live, targetPath]);
  const selectedDirs = useMemo(() => new Set(selected === null ? [] : ancestors(selected)), [selected]);
  const dirOpen = useCallback((paths: string[]): boolean => {
    // A filter shows every folder above a match, except those closed during it.
    if (q) return !paths.some(p => closedNow.has(p));
    return chainOpen(paths, dirs, big, revealed);
  }, [q, closedNow, dirs, big, revealed]);

  // Auto-reveal: open the target's folders, then scroll its row into view. Never selects or focuses.
  // The folders stay while the agent reads (no target) and change when it writes elsewhere or its session stops.
  // During the hold after a user scroll any such change waits, and applies when the hold ends.
  const agentWorking = useStore(s => Object.values(s.sessions).some(x => x.status === 'working'));
  const [holdEnded, setHoldEnded] = useState(0);
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    const want = agentWorking ? targetPath : null;
    if (want === null && agentWorking) return; // reading between writes: keep what is open
    const wait = userScrolledAt.current + USER_SCROLL_HOLD_MS - Date.now();
    if (wait > 0) {
      const t = window.setTimeout(() => setHoldEnded(n => n + 1), wait);
      return () => window.clearTimeout(t);
    }
    setSession(s => (s.agentAt === want ? s : { ...s, agentAt: want, blocked: want !== null && ancestors(want).some(a => s.closed.has(a)) ? want : null }));
    // No scroll to a file inside a folder the user closed (its row stays hidden), nor again to one in view.
    if (want === null || ancestors(want).some(a => latest.current.closed.has(a))) return;
    const r = rowEls.current.get(want)?.getBoundingClientRect();
    const box = treeRef.current?.getBoundingClientRect();
    if (want === lastShown.current && r && box && r.top >= box.top && r.bottom <= box.bottom) return;
    lastShown.current = want;
    setReveal({ path: want, at: Date.now(), q: latest.current.q });
  }, [targetPath, agentWorking, holdEnded]);
  // Each selection opens its folders, the same file again included. One made outside the tree (Map, palette,
  // Activity, inspector) also scrolls to its row; a file or symbol clicked here is already in view.
  const selects = useStore(s => s.selects);
  const ownSelect = useRef(-1);
  useEffect(() => {
    const path = useStore.getState().selected;
    if (path === null) return;
    showPicked(path, ctx.current!);
    if (selects !== ownSelect.current) setReveal({ path, at: Date.now(), q: latest.current.q });
  }, [selects]);
  const rowOpen = useCallback((row: Row) => row.forceOpen || !!expanded[row.file.path], [expanded]);
  const pins = useMemo(() => {
    const out = Object.keys(live);
    if (selected !== null) out.push(selected);
    if (targetPath !== null) out.push(targetPath);
    return out;
  }, [selected, targetPath, live]);
  const { items: openItems, navKeys } = useMemo(
    () => visibleItems(tree, dirOpen, rowOpen, dirLimit, pins),
    [tree, dirOpen, rowOpen, dirLimit, pins],
  );
  const dirItems = useMemo(() => {
    const byDir = new Map<string, Extract<Item, { kind: 'dir' }>>();
    for (const it of openItems) if (it.kind === 'dir') byDir.set(it.node.path, it);
    return byDir;
  }, [openItems]);
  // Rows of folding folders render until the fold ends, but are never part of keyboard navigation.
  // Every folding folder that is not open again draws closed, one inside a closing parent's saved rows too (with
  // no rows of its own there: see toggleDir in treeActions).
  const folding = useMemo(() => {
    const f = new Set<string>();
    for (const [d, m] of moving) if (m.kind === 'fold' && !dirItems.get(d)?.open) f.add(d);
    return f;
  }, [moving, dirItems]);
  // A folding folder's rows are the ones it showed when it closed; the other folders already show their new layout.
  const items = useMemo(() => {
    if (!folding.size) return openItems;
    const out: Item[] = [];
    for (const it of openItems) {
      out.push(it);
      if (it.kind === 'dir' && folding.has(it.node.path)) out.push(...moving.get(it.node.path)!.rows);
    }
    return out;
  }, [openItems, folding, moving]);
  useEffect(() => {
    if (!moving.size) return;
    const soonest = Math.min(...[...moving.values()].map(m => m.until));
    const t = window.setTimeout(() => {
      const now = Date.now();
      setMoving(m => new Map([...m].filter(([, v]) => v.until > now)));
    }, Math.max(0, soonest - Date.now()));
    return () => window.clearTimeout(t);
  }, [moving]);
  // A reveal waits for its row (a file the agent is creating shows once indexed), for up to 10 s. It goes when the
  // filter changes, when a user close hides the row, or when a newer one replaces it.
  useEffect(() => {
    if (reveal === null) return;
    if (Date.now() - reveal.at > REVEAL_WAIT_MS || reveal.q !== q || ancestors(reveal.path).some(a => (q ? closedNow : session.closed).has(a))) {
      setReveal(null);
      return;
    }
    const el = rowEls.current.get(reveal.path);
    if (!el) return;
    setReveal(null);
    selfScrollUntil.current = Date.now() + SELF_SCROLL_MS;
    el.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [reveal, items, q, closedNow, session.closed]);
  // Wheel and touch are always the user; a plain scroll event is the user unless it is our own smooth scroll.
  const markUser = () => { userScrolledAt.current = Date.now(); setReveal(null); };
  const onScroll = () => { if (Date.now() > selfScrollUntil.current) markUser(); };
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const end = () => { selfScrollUntil.current = 0; };
    el.addEventListener('scrollend', end);
    return () => el.removeEventListener('scrollend', end);
  }, []);
  const showMore = (k: string, shown: number) =>
    setLimits(l => ({ q, byDir: new Map(l.q === q ? l.byDir : NO_LIMITS).set(k, shown + DIR_BATCH) }));
  const navSet = useMemo(() => new Set(navKeys), [navKeys]);
  const wanted = focused ?? selected;
  const active = wanted !== null && navSet.has(wanted) ? wanted : navKeys[0] ?? null;

  const onSelect = useCallback((path: string) => {
    const s = useStore.getState();
    ownSelect.current = s.selects + 1;
    s.select(path);
    if (!s.expanded[path]) s.toggle(path);
    afterSelect();
  }, []);
  const onToggle = useCallback((path: string) => useStore.getState().toggle(path), []);
  const onSymbol = useCallback((path: string, line: number) => {
    const s = useStore.getState();
    ownSelect.current = s.selects + 1;
    s.revealLine(path, line);
    if (isNarrow()) s.setPanel('inspector');
  }, []);


  const typed = useRef({ text: '', at: 0 });
  const ctx = useRef<TreeContext | null>(null);
  ctx.current = {
    navKeys,
    navSet,
    items: openItems,
    dirItems,
    q,
    reduced,
    setFilterClosed,
    setDirs,
    setSession,
    setMoving,
    big,
    dirs,
    typed: typed.current,
    focus: k => rowEls.current.get(k)?.focus(),
    toggle: el => (el.dataset.dir !== undefined ? toggleDir(el.dataset.dir) : onToggle(el.dataset.file!)),
  };
  const toggleDir = (dir: string) => toggleIn(dir, ctx.current!);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => treeKeyDown(e, ctx.current!);

  const now = Date.now();
  const renderItem = (item: Item, kids: Block[]): ReactNode => {
    if (item.kind === 'more') {
      const k = moreKey(item.dir, item.part);
      return (
        <button type="button" key={k} ref={refFor(k)} className="more-rows" style={{ ['--d' as string]: item.level - 1 }} data-nav={k} data-up={item.up ?? undefined} tabIndex={active === k ? 0 : -1} onClick={() => showMore(k, item.shown)}>
          Show {Math.min(item.hidden, DIR_BATCH).toLocaleString()} more {item.part === 'dirs' ? 'folders' : 'files'} ({item.hidden.toLocaleString()} hidden)
        </button>
      );
    }
    if (item.kind === 'dir') {
      const { node, label, level, up } = item;
      const dir = node.path;
      // A folding folder lists its rows until the fold ends, but shows as closed.
      const open = item.open && !folding.has(dir);
      const k = dirKey(dir);
      const m = moving.get(dir);
      const fold = !open && m?.kind === 'fold';
      const act = open ? undefined : activity.get(dir);
      return (
        <Fragment key={k}>
        <button
          type="button"
          className={clsx('dir', open && 'open')}
          style={{ ['--c' as string]: LAYERS[node.layer].color, ['--d' as string]: level - 1 }}
          role="treeitem"
          aria-level={level}
          aria-expanded={open}
          aria-selected={false}
          ref={refFor(k)}
          data-nav={k}
          data-dir={dir}
          data-up={up ?? undefined}
          tabIndex={active === k ? 0 : -1}
          onClick={() => toggleDir(dir)}
          title={`${dir} · ${node.count.toLocaleString()} ${node.count === 1 ? 'file' : 'files'}`}
        >
          <Chevron className="dchev" /><i /><MidName name={label} kind="dir" />
          {act && <em className={clsx('dlive', act, act === 'now' && 'pulse')} role="img" aria-label={ACTIVITY[act]} title={`A file in this folder is ${ACTIVITY[act]}`} />}
          {!open && !act && selectedDirs.has(dir) && <em className="dlive" role="img" aria-label="contains the selected file" title="The selected file is in this folder" />}
          <b>{node.count.toLocaleString()}</b>
        </button>
        {kids.length > 0 && (
          <div role="group" className={clsx('dgroup', fold && 'fold', open && m?.kind === 'unfold' && 'unfold')} {...(fold ? { inert: '' } : {})}>
            <div>{kids.map(b => renderItem(b.item, b.kids))}</div>
          </div>
        )}
        </Fragment>
      );
    }
    const { row } = item;
    const path = row.file.path;
    const badge = live[path];
    const change = badge ? latestChange(changes, path) : undefined;
    return (
      <FileRow
        key={path}
        file={row.file}
        name={row.name}
        level={item.level}
        up={item.up}
        layer={row.meta.layer}
        total={row.meta.total}
        symbols={row.symbols}
        open={item.open}
        selected={selected === path}
        badge={badge}
        target={path === targetPath}
        pop={popsAt(path, now)}
        tags={change ? cachedTags(row.file, change) : EMPTY_TAGS}
        activeKey={active !== null && (active === path || active.startsWith(`${path}\0`)) ? active : null}
        onSelect={onSelect}
        onToggle={onToggle}
        onSymbol={onSymbol}
        refFor={refFor}
      />
    );
  };
  // Each open folder is followed by a group holding its rows, so opening and closing can animate its height.
  const blocks: Block[] = [];
  const stack: { level: number; kids: Block[] }[] = [{ level: 0, kids: blocks }];
  for (const item of items) {
    while (stack[stack.length - 1].level >= item.level) stack.pop();
    const b: Block = { item, kids: [] };
    stack[stack.length - 1].kids.push(b);
    if (item.kind === 'dir') stack.push({ level: item.level, kids: b.kids });
  }
  return (
    <aside
      id="sidebar"
      className={clsx('sidebar glass', panel === 'files' && 'open')}
      aria-label="Project files"
      data-panel="files"
      tabIndex={-1}
      {...((narrow ? panel !== 'files' : collapsed) ? INERT : {})}
    >
      <div className="sb-head"><h2>Project</h2><span>{fileCount.toLocaleString()} {fileCount === 1 ? 'file' : 'files'}</span><CollapseButton panel="files" /></div>
      <label className="filter">
        <SearchIcon />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter files and functions"
          aria-label="Filter files and functions"
          spellCheck={false}
        />
      </label>
      {layers.length > 0 && (
        <div className="legendrow" aria-hidden="true">
          {layers.map(l => <span key={l}><i style={{ ['--c' as string]: LAYERS[l].color }} />{LAYERS[l].name}</span>)}
        </div>
      )}
      <div
        className="tree"
        role="tree"
        aria-label="Files"
        ref={treeRef}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onWheel={markUser}
        onTouchMove={markUser}
        onFocus={e => { const k = (e.target as HTMLElement).dataset.nav; if (k) setFocused(k); }}
      >
        {blocks.map(b => renderItem(b.item, b.kids))}
        {fileCount > 0 && tree.count === 0 && <div className="tree-empty">No files or functions match “{filter}”.</div>}
      </div>
    </aside>
  );
}

type Block = { item: Item; kids: Block[] };
