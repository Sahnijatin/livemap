import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { LAYERS } from '../layers';
import { latestChange, type SymbolTag } from '../changes';
import { dirName, useLiveRecent } from '../recent';
import { BIG_PROJECT, DIR_BATCH, buildGroups, cachedTags, dirKey, moreKey, visibleItems, type Row } from '../treeModel';
import { FileRow } from './FileRow';
import { Chevron, SearchIcon } from './icons';

const POP_MS = 700;
const EMPTY_TAGS = new Map<string, SymbolTag>();
const NO_LIMITS: Record<string, number> = {};
const attr = (s: string): string => s.replace(/["\\]/g, '\\$&');
const isNarrow = (): boolean => window.matchMedia?.('(max-width:1080px)').matches ?? false;

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
  const live = useLiveRecent(recent);
  const treeRef = useRef<HTMLDivElement>(null);
  const born = useRef(new Map<string, number>());
  const [focused, setFocused] = useState<string | null>(null);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
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
  const rowOpen = useCallback((row: Row) => row.forceOpen || !!expanded[row.file.path], [expanded]);
  const pinned = useCallback((path: string) => path === selected || live[path] !== undefined, [selected, live]);
  const { items, navKeys } = useMemo(
    () => visibleItems(groups, dirOpen, rowOpen, dirLimit, pinned),
    [groups, dirOpen, rowOpen, dirLimit, pinned],
  );
  const showMore = (dir: string, shown: number) =>
    setLimits(l => ({ q, byDir: { ...(l.q === q ? l.byDir : {}), [dir]: shown + DIR_BATCH } }));
  const navSet = useMemo(() => new Set(navKeys), [navKeys]);
  const wanted = focused ?? selected;
  const active = wanted !== null && navSet.has(wanted) ? wanted : navKeys[0] ?? null;

  const onSelect = useCallback((path: string) => {
    const s = useStore.getState();
    s.select(path);
    if (!s.expanded[path]) s.toggle(path);
    if (isNarrow()) s.setPanel('inspector');
  }, []);
  const onToggle = useCallback((path: string) => useStore.getState().toggle(path), []);
  const onSymbol = useCallback((path: string, line: number) => {
    const s = useStore.getState();
    s.revealLine(path, line);
    if (isNarrow()) s.setPanel('inspector');
  }, []);
  const toggleDir = (dir: string) => setOpenDirs(o => ({ ...o, [dir]: !dirOpen(dir) }));

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
  return (
    <aside className={clsx('sidebar glass', panel === 'files' && 'open')} aria-label="Project files">
      <div className="sb-head"><h2>Project</h2><span>{fileCount.toLocaleString()} {fileCount === 1 ? 'file' : 'files'}</span></div>
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
        onFocus={e => { const k = (e.target as HTMLElement).dataset.nav; if (k) setFocused(k); }}
      >
        {items.map(item => {
          if (item.kind === 'more') {
            const k = moreKey(item.dir);
            return (
              <button type="button" key={k} className="more-rows" data-nav={k} tabIndex={active === k ? 0 : -1} onClick={() => showMore(item.dir, item.shown)}>
                Show {Math.min(item.hidden, DIR_BATCH).toLocaleString()} more ({item.hidden.toLocaleString()} hidden)
              </button>
            );
          }
          if (item.kind === 'dir') {
            const { dir, layer, rows } = item.group;
            const k = dirKey(dir);
            return (
              <button
                type="button"
                key={k}
                className={clsx('dir', item.open && 'open')}
                style={{ ['--c' as string]: LAYERS[layer].color }}
                role="treeitem"
                aria-level={1}
                aria-expanded={item.open}
                data-nav={k}
                data-dir={dir}
                tabIndex={active === k ? 0 : -1}
                onClick={() => toggleDir(dir)}
                title={`${dir || 'project root'} · ${rows.length} files`}
              >
                <i /><span>{dir || 'project root'}</span>
                {!item.open && liveDirs.has(dir) && <em className="dlive pulse" role="img" aria-label="changed" title="A file in this folder changed" />}
                {!item.open && !liveDirs.has(dir) && dir === selectedDir && <em className="dlive" role="img" aria-label="contains the selected file" title="The selected file is in this folder" />}
                {(big || !item.open) && <><b>{rows.length}</b><Chevron className="dchev" /></>}
              </button>
            );
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
              layer={row.meta.layer}
              total={row.meta.total}
              symbols={row.symbols}
              open={item.open}
              selected={selected === path}
              badge={badge}
              pop={now - born.current.get(path)! < POP_MS}
              tags={change ? cachedTags(row.file, change) : EMPTY_TAGS}
              activeKey={active !== null && (active === path || active.startsWith(`${path}#`)) ? active : null}
              onSelect={onSelect}
              onToggle={onToggle}
              onSymbol={onSymbol}
            />
          );
        })}
        {fileCount > 0 && groups.length === 0 && <div className="tree-empty">No files or functions match “{filter}”.</div>}
      </div>
    </aside>
  );
}
