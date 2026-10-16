import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { NARROW_QUERY, isNarrow, useMedia } from '../media';
import { INERT, afterSelect, shownLayout } from '../panels';
import { prefersReducedMotion } from '../scroll';
import { useCurrentTarget } from '../live';
import { LAYERS } from '../layers';
import { latestChange, type SymbolTag } from '../changes';
import { useLiveRecent } from '../recent';
import {
  BIG_PROJECT, DIR_BATCH, ancestors, buildTree, cachedTags, chainOpen, closedAbove, dirActivity, dirKey, loadTreeState, moreKey,
  saveTreeState, visibleItems, type Activity, type DirState, type Item, type Row,
} from '../treeModel';
import { FileRow, MidName } from './FileRow';
import type { KeyPress, TreeKeyContext } from './treeKeys';
import { CollapseButton } from './Dock';
import { usePrefersReducedMotion } from '../motion';
import { Chevron, SearchIcon } from './icons';

const POP_MS = 700;
/** Folder unfold and fold (height and fade), matching `.dgroup.unfold/.fold` in styles.css. */
const FOLD_MS = 360;
/** Auto-reveal pauses this long after the user scrolls the tree. */
const USER_SCROLL_HOLD_MS = 5000;
/** Scroll events this soon after our own scrollIntoView are the animation, not the user. */
const SELF_SCROLL_MS = 900;
/** Folder choices are saved this long after the last change (and right away when the page is hidden). */
const SAVE_MS = 300;
const EMPTY_TAGS = new Map<string, SymbolTag>();
const NO_LIMITS: ReadonlyMap<string, number> = new Map();
const NO_DIRS: ReadonlySet<string> = new Set();
/** `set` with `add` added and `del` removed, as a new set. */
const edit = (set: ReadonlySet<string>, add: readonly string[], del: readonly string[] = []): ReadonlySet<string> => {
  const next = new Set(set);
  for (const a of add) next.add(a);
  for (const d of del) next.delete(d);
  return next;
};
/** Own keys only: a file named `constructor` is not a stored entry. */
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** A closed folder's activity dot: its label, and the title as "A file in this folder <title>". */
const ACTIVITY: Record<Activity, [string, string]> = { now: ['being written', 'is being written'], edited: ['edited', 'was edited'], new: ['new', 'is new'] };
/**
 * This session's folder overrides, never saved: `picked` folders opened to show a file the user selected,
 * `closed` folders the user closed (the agent's reveals leave them shut), and `agentAt` the agent file being shown.
 */
type Session = { picked: ReadonlySet<string>; closed: ReadonlySet<string>; agentAt: string | null };
type Moving = { kind: 'fold' | 'unfold'; until: number; rows: Item[] };

type KeysModule = typeof import('./treeKeys');
/** The tree's key handling, a chunk of its own that loads after first paint. */
let keys: KeysModule | null = null;
let loading: Promise<KeysModule | null> | null = null;
/** How the key chunk is fetched (tests swap it), and `reset` to forget it. */
export const treeKeysLoader = {
  load: (): Promise<KeysModule> => import('./treeKeys'),
  reset(): void { keys = null; loading = null; },
};
/** The key handler, loading it once; a failed load resolves null and the next call tries again. */
export function loadTreeKeys(): Promise<KeysModule | null> {
  if (keys) return Promise.resolve(keys);
  return (loading ??= treeKeysLoader.load().then(m => (keys = m), () => { loading = null; return null; }));
}
/** Keys pressed while the handler loads, replayed in order once it has. */
const MAX_QUEUED = 20;

/** A string as a quoted CSS attribute value; any path (newlines included) yields a valid selector. */
const attr = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a '));

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
  const panel = useStore(s => s.panel);
  const collapsed = useStore(s => shownLayout(s).collapsed.files);
  // Below 1080 px a closed slide-over is off screen, and wider a collapsed panel is hidden: keep it out of the tab order.
  const narrow = useMedia(NARROW_QUERY);
  const live = useLiveRecent(recent);
  const target = useCurrentTarget();
  const targetPath = target?.path ?? null;
  const userScrolledAt = useRef(0);
  const selfScrollUntil = useRef(0);
  const [reveal, setReveal] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const born = useRef(new Map<string, number>());
  const [focused, setFocused] = useState<string | null>(null);
  // App keys this component by project, so every piece of state here belongs to one project.
  // Folders the user opened or closed, by full path, remembered per project. Folders without an entry follow the defaults.
  const [dirs, setDirs] = useState<DirState>(() => loadTreeState(projectRoot));
  const loaded = useRef(dirs);
  const [session, setSession] = useState<Session>({ picked: NO_DIRS, closed: NO_DIRS, agentAt: null });
  /** Folders closed while a filter is on; forgotten with the filter. */
  const [filterClosed, setFilterClosed] = useState<{ q: string; dirs: ReadonlySet<string> }>({ q: '', dirs: NO_DIRS });
  const reduced = usePrefersReducedMotion();
  /** Folders mid-animation: a folding one keeps its rows (inert) until its fold ends. */
  const [moving, setMoving] = useState<ReadonlyMap<string, Moving>>(() => new Map());
  const [limits, setLimits] = useState<{ q: string; byDir: ReadonlyMap<string, number> }>({ q: '', byDir: NO_LIMITS });

  const q = filter.trim().toLowerCase();
  const dirLimit = limits.q === q ? limits.byDir : NO_LIMITS;
  const closedNow = filterClosed.q === q ? filterClosed.dirs : NO_DIRS;
  const { root: tree, layers } = useMemo(() => buildTree(files, q), [files, q]);
  const fileCount = useMemo(() => Object.keys(files).length, [files]);
  // Big or not is decided once, when the first index has finished, so later growth leaves the folders alone.
  const indexing = useStore(s => s.indexing !== null);
  const [bigAt, setBigAt] = useState<boolean | null>(null);
  if (bigAt === null && !indexing && fileCount > 0) setBigAt(fileCount >= BIG_PROJECT);
  const big = bigAt ?? fileCount >= BIG_PROJECT;
  const state = dirs;

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
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [flush]);
  const latest = useRef({ state, big, closed: session.closed });
  latest.current = { state, big, closed: session.closed };
  /** Shows a file the user selected: opens the closed folders above it for this session, even ones they closed. */
  const showPicked = useCallback((path: string) => {
    const above = ancestors(path);
    setSession(s => {
      const need = closedAbove(path, latest.current.state, latest.current.big, s.picked);
      const unclose = above.filter(a => s.closed.has(a));
      if (!need.length && !unclose.length) return s;
      return { ...s, picked: edit(s.picked, need), closed: edit(s.closed, [], unclose) };
    });
    setFilterClosed(f => (above.some(a => f.dirs.has(a)) ? { q: f.q, dirs: edit(f.dirs, [], above) } : f));
  }, []);
  // The agent's file shows its folders until the agent moves on; folders the user closed this session stay shut.
  const agentDirs = useMemo(() => {
    const at = session.agentAt;
    if (at === null) return NO_DIRS;
    return edit(NO_DIRS, closedAbove(at, state, big, session.picked).filter(a => !session.closed.has(a)));
  }, [session, state, big]);
  const revealed = useMemo(() => (agentDirs.size ? edit(session.picked, [...agentDirs]) : session.picked), [session.picked, agentDirs]);

  const activity = useMemo(() => dirActivity(live, targetPath), [live, targetPath]);
  const selectedDirs = useMemo(() => new Set(selected === null ? [] : ancestors(selected)), [selected]);
  const dirOpen = useCallback((paths: string[]): boolean => {
    // A filter shows every folder above a match, except those closed during it.
    if (q) return !closedNow.has(paths[paths.length - 1]);
    return chainOpen(paths, state, big, revealed);
  }, [q, closedNow, state, big, revealed]);

  // Auto-reveal: open the target's folders, then scroll its row into view. Never selects or focuses.
  // During the hold after a user scroll the latest target waits, and is revealed when the hold ends.
  const [holdEnded, setHoldEnded] = useState(0);
  useEffect(() => {
    // An idle agent shows nothing: the folders only it opened close, as when it moves on.
    if (targetPath === null) { setSession(s => (s.agentAt === null ? s : { ...s, agentAt: null })); return; }
    const wait = userScrolledAt.current + USER_SCROLL_HOLD_MS - Date.now();
    if (wait > 0) {
      const t = window.setTimeout(() => setHoldEnded(n => n + 1), wait);
      return () => window.clearTimeout(t);
    }
    setSession(s => (s.agentAt === targetPath ? s : { ...s, agentAt: targetPath }));
    // No scroll to a file inside a folder the user closed: its row stays hidden.
    if (!ancestors(targetPath).some(a => latest.current.closed.has(a))) setReveal(targetPath);
  }, [targetPath, holdEnded]);
  // Each selection (Map, palette, Activity, inspector, or this tree) is revealed, the same file again included.
  const selects = useStore(s => s.selects);
  useEffect(() => {
    const path = useStore.getState().selected;
    if (path === null) return;
    showPicked(path);
    setReveal(path);
  }, [selects, showPicked]);
  const rowOpen = useCallback((row: Row) => row.forceOpen || (own(expanded, row.file.path) && expanded[row.file.path]), [expanded]);
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
  const folding = useMemo(() => {
    const f = new Set<string>();
    for (const [d, m] of moving) if (m.kind === 'fold' && dirItems.get(d)?.open === false) f.add(d);
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
  useEffect(() => {
    if (reveal === null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-file="${attr(reveal)}"]`);
    setReveal(null); // a row that did not show (hidden by a filter, or not in the tree) is not waited for
    if (!el) return;
    selfScrollUntil.current = Date.now() + SELF_SCROLL_MS;
    el.scrollIntoView?.({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [reveal, items, q]);
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
  const showMore = (dir: string, shown: number) =>
    setLimits(l => ({ q, byDir: new Map(l.q === q ? l.byDir : NO_LIMITS).set(dir, shown + DIR_BATCH) }));
  const navSet = useMemo(() => new Set(navKeys), [navKeys]);
  const wanted = focused ?? selected;
  const active = wanted !== null && navSet.has(wanted) ? wanted : navKeys[0] ?? null;

  const onSelect = useCallback((path: string) => {
    const s = useStore.getState();
    s.select(path);
    if (!(own(s.expanded, path) && s.expanded[path])) s.toggle(path);
    afterSelect();
  }, []);
  const onToggle = useCallback((path: string) => useStore.getState().toggle(path), []);
  const onSymbol = useCallback((path: string, line: number) => {
    const s = useStore.getState();
    s.revealLine(path, line);
    if (isNarrow()) s.setPanel('inspector');
  }, []);
  const toggleDir = (dir: string) => {
    const item = dirItems.get(dir);
    if (!item) return;
    const { open, chain } = item;
    if (q) {
      setFilterClosed(f => {
        const was = f.q === q ? f.dirs : NO_DIRS;
        return { q, dirs: open ? edit(was, [dir]) : edit(was, [], [dir]) };
      });
    } else {
      // A chain opens and closes as a whole, so each of its folders keeps the state when the chain splits.
      setDirs(d => {
        const next = new Map(d);
        for (const p of chain) { next.delete(p); next.set(p, !open); } // re-added last: the newest choices are kept longest
        return next;
      });
      // The user's choice replaces a reveal, and a close holds against the agent for the session.
      setSession(s => ({
        ...s,
        picked: edit(s.picked, [], chain),
        closed: open ? edit(s.closed, chain) : edit(s.closed, [], chain),
      }));
    }
    if (reduced) return;
    // A closing folder keeps the rows it shows now until its fold ends.
    const at = items.findIndex(it => it.kind === 'dir' && it.node.path === dir);
    let end = at + 1;
    while (at >= 0 && end < items.length && items[end].level > items[at].level) end++;
    const rows = open && at >= 0 ? items.slice(at + 1, end) : [];
    setMoving(m => new Map(m).set(dir, { kind: open ? 'fold' : 'unfold', until: Date.now() + FOLD_MS, rows }));
  };

  useEffect(() => { void loadTreeKeys(); }, []);
  const keyCtx = useRef<TreeKeyContext | null>(null);
  keyCtx.current = {
    navKeys,
    navSet,
    items: openItems,
    // Ids hold a NUL, which a CSS selector cannot match, so rows are found by comparing.
    focus: k => [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-nav]') ?? [])].find(e => e.dataset.nav === k)?.focus(),
    toggle: el => (el.dataset.dir !== undefined ? toggleDir(el.dataset.dir) : onToggle(el.dataset.file!)),
  };
  const queued = useRef<KeyPress[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (keys) return keys.treeKeyDown(e, keyCtx.current!);
    // Not loaded yet (or it failed: this retries): keep the key, and keep arrows from scrolling meanwhile.
    if (queued.current.push({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, preventDefault() {} }) > MAX_QUEUED) queued.current.shift();
    if (/^(Arrow|Home$|End$)/.test(e.key)) e.preventDefault();
    void loadTreeKeys().then(m => {
      const replay = queued.current.splice(0);
      // Replayed only while focus is still in the tree.
      if (m) for (const k of replay) if (treeRef.current?.contains(document.activeElement)) m.treeKeyDown(k, keyCtx.current!);
    });
  };

  const animateFrom = helloAt + 1000;
  const now = Date.now();
  const renderItem = (item: Item, kids: Block[]): ReactNode => {
    if (item.kind === 'more') {
      const k = moreKey(item.dir);
      return (
        <button type="button" key={k} className="more-rows" style={{ ['--d' as string]: item.level - 1 }} data-nav={k} tabIndex={active === k ? 0 : -1} onClick={() => showMore(item.dir, item.shown)}>
          Show {Math.min(item.hidden, DIR_BATCH).toLocaleString()} more ({item.hidden.toLocaleString()} hidden)
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
      return [
        <button
          type="button"
          key={k}
          className={clsx('dir', open && 'open')}
          style={{ ['--c' as string]: LAYERS[node.layer].color, ['--d' as string]: level - 1 }}
          role="treeitem"
          aria-level={level}
          aria-expanded={open}
          aria-selected={false}
          data-nav={k}
          data-dir={dir}
          data-up={up ?? undefined}
          tabIndex={active === k ? 0 : -1}
          onClick={() => toggleDir(dir)}
          title={`${dir} · ${node.count.toLocaleString()} ${node.count === 1 ? 'file' : 'files'}`}
        >
          <Chevron className="dchev" /><i /><MidName name={label} kind="dir" />
          {act && <em className={clsx('dlive', act, act === 'now' && 'pulse')} role="img" aria-label={ACTIVITY[act][0]} title={`A file in this folder ${ACTIVITY[act][1]}`} />}
          {!open && !act && selectedDirs.has(dir) && <em className="dlive" role="img" aria-label="contains the selected file" title="The selected file is in this folder" />}
          <b>{node.count.toLocaleString()}</b>
        </button>,
        kids.length > 0 && (
          <div key={`g:${dir}`} role="group" className={clsx('dgroup', fold && 'fold', open && m?.kind === 'unfold' && 'unfold')} {...(fold ? { inert: '' } : {})}>
            <div>{kids.map(b => renderItem(b.item, b.kids))}</div>
          </div>
        ),
      ];
    }
    const { row } = item;
    const path = row.file.path;
    if (!born.current.has(path)) born.current.set(path, now < animateFrom ? 0 : now);
    const badge = own(live, path) ? live[path] : undefined;
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
        pop={now - born.current.get(path)! < POP_MS}
        tags={change ? cachedTags(row.file, change) : EMPTY_TAGS}
        activeKey={active !== null && (active === path || active.startsWith(`${path}\0`)) ? active : null}
        onSelect={onSelect}
        onToggle={onToggle}
        onSymbol={onSymbol}
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
