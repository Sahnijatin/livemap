import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { NARROW_QUERY, isNarrow, useMedia } from '../media';
import { INERT, afterSelect } from '../panels';
import { prefersReducedMotion } from '../scroll';
import { useCurrentTarget } from '../live';
import { LAYERS } from '../layers';
import { latestChange, type SymbolTag } from '../changes';
import { dirName, useLiveRecent } from '../recent';
import { BIG_PROJECT, DIR_BATCH, buildGroups, cachedTags, dirKey, moreKey, visibleItems, type Item, type Row } from '../treeModel';
import { FileRow } from './FileRow';
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
const EMPTY_TAGS = new Map<string, SymbolTag>();
const NO_LIMITS: Record<string, number> = {};
/** A string as a quoted CSS attribute value; any path (newlines included) yields a valid selector. */
const attr = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a '));

export function FileTree() {
  const files = useStore(s => s.files);
  const filter = useStore(s => s.filter);
  const setFilter = useStore(s => s.setFilter);
  const expanded = useStore(s => s.expanded);
  const selected = useStore(s => s.selected);
  const recent = useStore(s => s.recent);
  const changes = useStore(s => s.changes);
  const helloAt = useStore(s => s.helloAt);
  const panel = useStore(s => s.panel);
  const collapsed = useStore(s => s.layout.collapsed.files);
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
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const reduced = usePrefersReducedMotion();
  /** Folders mid-animation: a folding one keeps its rows (inert) until its fold ends. */
  const [moving, setMoving] = useState<Record<string, { kind: 'fold' | 'unfold'; until: number }>>({});
  const [limits, setLimits] = useState<{ q: string; byDir: Record<string, number> }>({ q: '', byDir: {} });

  const q = filter.trim().toLowerCase();
  const dirLimit = limits.q === q ? limits.byDir : NO_LIMITS;
  const { groups, layers } = useMemo(() => buildGroups(files, q), [files, q]);
  const fileCount = Object.keys(files).length;
  const big = fileCount > BIG_PROJECT;

  const liveDirs = useMemo(() => new Set(Object.keys(live).map(dirName)), [live]);
  const selectedDir = selected === null ? null : dirName(selected);
  const dirOpen = useCallback((dir: string): boolean => {
    if (q) return true;
    const explicit = openDirs[dir];
    if (explicit !== undefined) return explicit;
    return !big || dir === selectedDir || liveDirs.has(dir);
  }, [q, openDirs, big, selectedDir, liveDirs]);

  // Auto-reveal: open the target's folder, then scroll its row into view. Never selects or focuses.
  // During the hold after a user scroll the latest target waits, and is revealed when the hold ends.
  const [holdEnded, setHoldEnded] = useState(0);
  useEffect(() => {
    if (targetPath === null) return;
    const wait = userScrolledAt.current + USER_SCROLL_HOLD_MS - Date.now();
    if (wait > 0) {
      const t = window.setTimeout(() => setHoldEnded(n => n + 1), wait);
      return () => window.clearTimeout(t);
    }
    setOpenDirs(o => (o[dirName(targetPath)] === true ? o : { ...o, [dirName(targetPath)]: true }));
    setReveal(targetPath);
  }, [targetPath, holdEnded]);
  const rowOpen = useCallback((row: Row) => row.forceOpen || !!expanded[row.file.path], [expanded]);
  const pinned = useCallback((path: string) => path === selected || path === targetPath || live[path] !== undefined, [selected, targetPath, live]);
  const { items: openItems, navKeys } = useMemo(
    () => visibleItems(groups, dirOpen, rowOpen, dirLimit, pinned),
    [groups, dirOpen, rowOpen, dirLimit, pinned],
  );
  // Rows of folding folders render until the fold ends, but are never part of keyboard navigation.
  const folding = useMemo(() => Object.keys(moving).filter(d => moving[d].kind === 'fold' && !dirOpen(d)), [moving, dirOpen]);
  const items = useMemo(() => {
    if (!folding.length) return openItems;
    const f = new Set(folding);
    return visibleItems(groups, d => dirOpen(d) || f.has(d), rowOpen, dirLimit, pinned).items;
  }, [openItems, folding, groups, dirOpen, rowOpen, dirLimit, pinned]);
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
    const open = dirOpen(dir);
    setOpenDirs(o => ({ ...o, [dir]: !open }));
    if (!reduced) setMoving(m => ({ ...m, [dir]: { kind: open ? 'fold' : 'unfold', until: Date.now() + FOLD_MS } }));
  };

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
        else if (el.dataset.parent) focusKey(navKeys.indexOf(el.dataset.parent));
        else if (el.dataset.file !== undefined) focusKey(navKeys.indexOf(dirKey(dirName(el.dataset.file))));
        else return;
        break;
      default: return;
    }
    e.preventDefault();
  };

  const animateFrom = helloAt + 1000;
  const now = Date.now();
  const renderRow = (item: Item) => {
    if (item.kind === 'more') {
      const k = moreKey(item.dir);
      return (
        <button type="button" key={k} className="more-rows" data-nav={k} tabIndex={active === k ? 0 : -1} onClick={() => showMore(item.dir, item.shown)}>
          Show {Math.min(item.hidden, DIR_BATCH).toLocaleString()} more ({item.hidden.toLocaleString()} hidden)
        </button>
      );
    }
    if (item.kind === 'dir') return null;
    const { row } = item;
    const path = row.file.path;
    if (!born.current.has(path)) born.current.set(path, now < animateFrom ? 0 : now);
    const badge = live[path];
    const change = badge ? latestChange(changes, path) : undefined;
    return (
      <FileRow
        key={path}
        file={row.file}
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
  // Each folder header is followed by a group holding its rows, so opening and closing can animate its height.
  const blocks: { head: Extract<Item, { kind: 'dir' }>; rows: Item[] }[] = [];
  for (const item of items) {
    if (item.kind === 'dir') blocks.push({ head: item, rows: [] });
    else blocks[blocks.length - 1]?.rows.push(item);
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
        {blocks.map(({ head, rows }) => {
          const { dir, layer, rows: all } = head.group;
          const k = dirKey(dir);
          const open = dirOpen(dir);
          const m = moving[dir];
          const fold = !open && m?.kind === 'fold';
          return [
            <button
              type="button"
              key={k}
              className={clsx('dir', open && 'open')}
              style={{ ['--c' as string]: LAYERS[layer].color }}
              role="treeitem"
              aria-level={1}
              aria-expanded={open}
              data-nav={k}
              data-dir={dir}
              tabIndex={active === k ? 0 : -1}
              onClick={() => toggleDir(dir)}
              title={`${dir || 'project root'} · ${all.length} files`}
            >
              <i /><span>{dir || 'project root'}</span>
              {!open && liveDirs.has(dir) && <em className="dlive pulse" role="img" aria-label="changed" title="A file in this folder changed" />}
              {!open && !liveDirs.has(dir) && dir === selectedDir && <em className="dlive" role="img" aria-label="contains the selected file" title="The selected file is in this folder" />}
              {(big || !open) && <><b>{all.length}</b><Chevron className="dchev" /></>}
            </button>,
            rows.length > 0 && (
              <div key={`g:${dir}`} role="group" className={clsx('dgroup', fold && 'fold', open && m?.kind === 'unfold' && 'unfold')} {...(fold ? { inert: '' } : {})}>
                <div>{rows.map(renderRow)}</div>
              </div>
            ),
          ];
        })}
        {fileCount > 0 && groups.length === 0 && <div className="tree-empty">No files or functions match “{filter}”.</div>}
      </div>
    </aside>
  );
}
