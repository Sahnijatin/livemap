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
  BIG_PROJECT, DIR_BATCH, ancestors, buildTree, cachedTags, chainOpen, closedAbove, dirActivity, loadTreeState, moreKey, saveTreeState,
  visibleItems, type Activity, type Item, type Row,
} from '../treeModel';
import { FileRow, MidName } from './FileRow';
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
/** Typed letters within this long of each other search as one prefix. */
const TYPEAHEAD_MS = 700;
const EMPTY_TAGS = new Map<string, SymbolTag>();
const NO_LIMITS: Record<string, number> = {};
const NO_CLOSED: Record<string, true> = {};
/** Folder state objects read from storage, which need no write back. */
const fromStorage = new WeakSet<object>();
const loadDirs = (root: string): Record<string, boolean> => {
  const open = loadTreeState(root);
  fromStorage.add(open);
  return open;
};
const ACTIVITY: Record<Activity, { label: string; title: string }> = {
  now: { label: 'agent is writing here', title: 'The agent is writing a file in this folder' },
  edited: { label: 'changed', title: 'A file in this folder changed' },
  new: { label: 'changed', title: 'A file in this folder is new' },
};

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
  const typed = useRef({ text: '', at: 0 });
  const [focused, setFocused] = useState<string | null>(null);
  // Open and closed folders by full path, remembered per project. Folders without an entry follow the defaults.
  const [dirs, setDirs] = useState(() => ({ root: projectRoot, open: loadDirs(projectRoot) }));
  if (dirs.root !== projectRoot) setDirs({ root: projectRoot, open: loadDirs(projectRoot) });
  /** Folders shown open as part of a compact chain: they stay open when the chain splits. */
  const seen = useRef(new Set<string>());
  /** Folders closed while a filter is on; forgotten with the filter. */
  const [filterClosed, setFilterClosed] = useState<{ q: string; byDir: Record<string, true> }>({ q: '', byDir: {} });
  const reduced = usePrefersReducedMotion();
  /** Folders mid-animation: a folding one keeps its rows (inert) until its fold ends. */
  const [moving, setMoving] = useState<Record<string, { kind: 'fold' | 'unfold'; until: number }>>({});
  const [limits, setLimits] = useState<{ q: string; byDir: Record<string, number> }>({ q: '', byDir: {} });

  const q = filter.trim().toLowerCase();
  const dirLimit = limits.q === q ? limits.byDir : NO_LIMITS;
  const closedNow = filterClosed.q === q ? filterClosed.byDir : NO_CLOSED;
  const { root: tree, layers } = useMemo(() => buildTree(files, q), [files, q]);
  const fileCount = useMemo(() => Object.keys(files).length, [files]);
  const big = fileCount >= BIG_PROJECT;
  const state = dirs.open;

  useEffect(() => { seen.current = new Set(); }, [projectRoot]);
  useEffect(() => {
    if (fromStorage.has(dirs.open)) return;
    saveTreeState(dirs.root, dirs.open);
  }, [dirs]);
  const latest = useRef({ tree, big });
  latest.current = { tree, big };
  /** Opens the closed folders above `path` (the user's state, so it is remembered). */
  const openAbove = useCallback((path: string) => {
    setDirs(d => {
      const need = closedAbove(latest.current.tree, path, d.open, latest.current.big, seen.current);
      if (!need.length) return d;
      const open = { ...d.open };
      for (const a of need) open[a] = true;
      return { root: d.root, open };
    });
  }, []);

  const activity = useMemo(() => dirActivity(live, targetPath), [live, targetPath]);
  const selectedDirs = useMemo(() => new Set(selected === null ? [] : ancestors(selected)), [selected]);
  const dirOpen = useCallback((paths: string[], level: number): boolean => {
    // A filter shows every folder above a match, except those closed during it.
    if (q) return !closedNow[paths[paths.length - 1]];
    return chainOpen(paths, level, state, big, seen.current);
  }, [q, closedNow, state, big]);

  // Auto-reveal: open the target's folders, then scroll its row into view. Never selects or focuses.
  // During the hold after a user scroll the latest target waits, and is revealed when the hold ends.
  const [holdEnded, setHoldEnded] = useState(0);
  useEffect(() => {
    if (targetPath === null) return;
    const wait = userScrolledAt.current + USER_SCROLL_HOLD_MS - Date.now();
    if (wait > 0) {
      const t = window.setTimeout(() => setHoldEnded(n => n + 1), wait);
      return () => window.clearTimeout(t);
    }
    openAbove(targetPath);
    setReveal(targetPath);
  }, [targetPath, holdEnded, openAbove]);
  // A file selected anywhere (Map, palette, Activity, inspector) is revealed here too.
  useEffect(() => {
    if (selected === null) return;
    openAbove(selected);
    setReveal(selected);
  }, [selected, openAbove]);
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
  useEffect(() => {
    if (q) return;
    for (const it of openItems) if (it.kind === 'dir' && it.open && it.chain.length > 1) for (const p of it.chain) seen.current.add(p);
  }, [openItems, q]);
  const dirItems = useMemo(() => {
    const m = new Map<string, Extract<Item, { kind: 'dir' }>>();
    for (const it of openItems) if (it.kind === 'dir') m.set(it.node.path, it);
    return m;
  }, [openItems]);
  // Rows of folding folders render until the fold ends, but are never part of keyboard navigation.
  const folding = useMemo(() => Object.keys(moving).filter(d => moving[d].kind === 'fold' && dirItems.get(d)?.open === false), [moving, dirItems]);
  const items = useMemo(() => {
    if (!folding.length) return openItems;
    const f = new Set(folding);
    return visibleItems(tree, (paths, level) => dirOpen(paths, level) || f.has(paths[paths.length - 1]), rowOpen, dirLimit, pins).items;
  }, [openItems, folding, tree, dirOpen, rowOpen, dirLimit, pins]);
  useEffect(() => {
    const ends = Object.values(moving).map(m => m.until);
    if (!ends.length) return;
    const t = window.setTimeout(() => {
      const now = Date.now();
      setMoving(m => Object.fromEntries(Object.entries(m).filter(([, v]) => v.until > now)));
    }, Math.max(0, Math.min(...ends) - Date.now()));
    return () => window.clearTimeout(t);
  }, [moving]);
  useEffect(() => {
    if (reveal === null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-file="${attr(reveal)}"]`);
    if (!el) { if (q) setReveal(null); return; } // a filter that hides the row cancels the reveal
    setReveal(null);
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
    setLimits(l => ({ q, byDir: { ...(l.q === q ? l.byDir : {}), [dir]: shown + DIR_BATCH } }));
  const navSet = useMemo(() => new Set(navKeys), [navKeys]);
  const wanted = focused ?? selected;
  const active = wanted !== null && navSet.has(wanted) ? wanted : navKeys[0] ?? null;

  const onSelect = useCallback((path: string) => {
    const s = useStore.getState();
    s.select(path);
    if (!s.expanded[path]) s.toggle(path);
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
        const byDir = { ...(f.q === q ? f.byDir : {}) };
        if (open) byDir[dir] = true; else delete byDir[dir];
        return { q, byDir };
      });
    } else {
      // A chain opens and closes as a whole, so each of its folders keeps the state when the chain splits.
      setDirs(d => {
        const next = { ...d.open };
        for (const p of chain) { delete next[p]; next[p] = !open; } // re-added last: the newest choices are kept longest
        return { root: d.root, open: next };
      });
    }
    if (!reduced) setMoving(m => ({ ...m, [dir]: { kind: open ? 'fold' : 'unfold', until: Date.now() + FOLD_MS } }));
  };

  /** Lowercase row names by nav key, for typeahead. */
  const labels = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of openItems) {
      if (it.kind === 'dir') m.set(`dir:${it.node.path}`, it.label.toLowerCase());
      else if (it.kind === 'file') m.set(it.row.file.path, it.row.name.toLowerCase());
    }
    return m;
  }, [openItems]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = document.activeElement as HTMLElement | null;
    const key = el?.dataset.nav;
    const i = key ? navKeys.indexOf(key) : -1;
    if (!el || i < 0) return;
    const focusKey = (j: number) => {
      const k = navKeys[Math.max(0, Math.min(navKeys.length - 1, j))];
      treeRef.current?.querySelector<HTMLElement>(`[data-nav="${attr(k)}"]`)?.focus();
    };
    const expandedAttr = el.getAttribute('aria-expanded');
    const toggleEl = () => (el.dataset.dir !== undefined ? toggleDir(el.dataset.dir) : onToggle(el.dataset.file!));
    const up = el.dataset.parent ?? el.dataset.up;
    switch (e.key) {
      case 'ArrowDown': focusKey(i + 1); break;
      case 'ArrowUp': focusKey(i - 1); break;
      case 'Home': focusKey(0); break;
      case 'End': focusKey(navKeys.length - 1); break;
      case 'ArrowRight':
        if (expandedAttr === 'false') toggleEl();
        else if (expandedAttr === 'true') focusKey(i + 1);
        else return;
        break;
      case 'ArrowLeft':
        if (expandedAttr === 'true') toggleEl();
        else if (up !== undefined && navSet.has(up)) focusKey(navKeys.indexOf(up));
        else return;
        break;
      default: {
        // Typeahead: letters and digits move to the next row whose name starts with what was typed.
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || !/^[\p{L}\p{N}._-]$/u.test(e.key)) return;
        const now = Date.now();
        const t = typed.current;
        t.text = now - t.at < TYPEAHEAD_MS ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
        t.at = now;
        const from = t.text.length > 1 ? i : i + 1;
        for (let n = 0; n < navKeys.length; n++) {
          const j = (from + n) % navKeys.length;
          if (labels.get(navKeys[j])?.startsWith(t.text)) { focusKey(j); break; }
        }
      }
    }
    e.preventDefault();
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
      const open = item.open && !folding.includes(dir);
      const k = `dir:${dir}`;
      const m = moving[dir];
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
          <Chevron className="dchev" /><i /><MidName name={label} />
          {act && <em className={clsx('dlive', act, act !== 'new' && 'pulse')} role="img" aria-label={ACTIVITY[act].label} title={ACTIVITY[act].title} />}
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
        pop={now - born.current.get(path)! < POP_MS}
        tags={change ? cachedTags(row.file, change) : EMPTY_TAGS}
        activeKey={active !== null && (active === path || active.startsWith(`${path}#`)) ? active : null}
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
