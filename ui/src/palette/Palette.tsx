import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Command } from 'cmdk';
import type { DomainIndex } from '@shared/domain.js';
import type { FileModel } from '@shared/types.js';
import { HISTORY_MAX, useStore } from '../store';
import { LAYERS } from '../layers';
import { fileMeta } from '../treeModel';
import { baseName, dirName } from '../recent';
import { isNarrow } from '../media';
import { KindBadge, LayerTile } from '../components/icons';
import { MethodPill } from '../components/MethodPill';
import { buildIndex, query, type Entry, type EntryKind, type IndexEntry } from './searchIndex';

const HEADINGS: Record<EntryKind, string> = { file: 'Files', symbol: 'Functions and components', route: 'Routes', table: 'Tables' };

/**
 * The index for the current files and domain, built once per change of either (not per keystroke). Building is
 * incremental (unchanged files and domain reuse their entries), so a live edit while open costs little.
 */
let cache: { files: Record<string, FileModel>; domain: DomainIndex; index: IndexEntry[] } | null = null;
function indexFor(files: Record<string, FileModel>, domain: DomainIndex): IndexEntry[] {
  if (!cache || cache.files !== files || cache.domain !== domain) cache = { files, domain, index: buildIndex(files, domain) };
  return cache.index;
}

const fileEntry = (f: FileModel): Entry => ({ kind: 'file', label: baseName(f.path), detail: dirName(f.path), path: f.path, layer: fileMeta(f).layer });

/** Recently opened files (most recent first), topped up with recently changed ones. */
function recentEntries(files: Record<string, FileModel>, history: string[], recent: Record<string, { at: number }>): Entry[] {
  const paths = history.filter(p => files[p]);
  if (paths.length < HISTORY_MAX) {
    const changed = Object.entries(recent).filter(([p]) => files[p] && !paths.includes(p)).sort((a, b) => b[1].at - a[1].at);
    for (const [p] of changed) {
      if (paths.length >= HISTORY_MAX) break;
      paths.push(p);
    }
  }
  return paths.map(p => fileEntry(files[p]));
}

/** The typed text, one animation frame later: fast typing runs one query per frame. */
function useFrameValue(text: string): string {
  const [value, setValue] = useState(text);
  useEffect(() => {
    if (text === value) return;
    const id = window.requestAnimationFrame(() => setValue(text));
    return () => window.cancelAnimationFrame(id);
  }, [text, value]);
  // Text that does not extend the last value (a reopened palette, a deletion) is never shown a stale frame.
  return text === '' || !text.startsWith(value) ? text : value;
}

interface Row { key: string; entry: Entry }
interface Group { heading: string; rows: Row[] }

/** Groups in the order of their best result; a unique cmdk value per row. */
function groupRows(entries: Entry[], recentMode: boolean): Group[] {
  const groups = new Map<string, Row[]>();
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const heading = recentMode ? 'Recent' : HEADINGS[entry.kind];
    let key = `${entry.kind}|${entry.id ?? entry.path}|${entry.line ?? ''}|${entry.label}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n) key += `|${n}`;
    const list = groups.get(heading);
    if (list) list.push({ key, entry });
    else groups.set(heading, [{ key, entry }]);
  }
  return [...groups].map(([heading, rows]) => ({ heading, rows }));
}

/** Open the entry in the inspector, and bring it into view in the active center tab. */
function choose(e: Entry): void {
  const s = useStore.getState();
  const tab = s.tab;
  s.setPalette(false);
  if (e.path) {
    s.select(e.path);
    if (e.line) s.revealLine(e.path, e.line);
  }
  let shown = false;
  if (tab === 'map' && e.path) { s.focusMap(e.path); shown = true; }
  else if (tab === 'schema' && e.kind === 'table' && e.id) { s.focusTable(e.id); shown = true; }
  else if (tab === 'api' && e.kind === 'route' && e.id) { s.traceRoute(e.id); shown = true; }
  if (!shown && e.path && isNarrow()) s.setPanel('inspector');
}

function RowIcon({ e }: { e: Entry }) {
  if (e.kind === 'symbol') return <KindBadge kind={e.symKind ?? 'variable'} />;
  if (e.kind === 'route') return <LayerTile layer="api" />;
  if (e.kind === 'table') return <LayerTile layer="data" />;
  return <LayerTile layer={e.layer ?? 'core'} />;
}

function RowLabel({ e }: { e: Entry }) {
  if (e.kind !== 'route' || !e.method) return <span className="pl">{e.label}</span>;
  return <span className="pl"><MethodPill method={e.method} /><span>{e.label.slice(e.method.length + 1)}</span></span>;
}

/**
 * Gives focus back to whatever had it before the palette opened. Radix returns focus only to a dialog
 * trigger, and the palette has none (⌘K, toolbar button). Mounted inside the dialog content: the layout
 * effect runs before Radix moves focus into the dialog. Focus goes back as soon as the dialog switches to
 * closed (not after its exit animation), so keys typed meanwhile do not land in the fading input.
 */
function FocusReturn({ open }: { open: boolean }) {
  const back = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  useEffect(() => {
    if (open) return;
    const restore = () => {
      const el = back.current;
      const now = document.activeElement;
      // Only take focus back from the palette itself (or from nowhere), never from something the user chose.
      if (el?.isConnected && (!now || now === document.body || now.closest('[cmdk-dialog]'))) el.focus({ preventScroll: true });
    };
    restore();
    // Radix's own close handling runs after this; check once more when it is done.
    const t = window.setTimeout(restore, 0);
    return () => window.clearTimeout(t);
  }, [open]);
  return null;
}

/** ⌘K: one search over files, functions and components, routes and tables. */
export default function Palette() {
  const open = useStore(s => s.paletteOpen);
  const setPalette = useStore(s => s.setPalette);
  const files = useStore(s => s.files);
  const domain = useStore(s => s.domain);
  const history = useStore(s => s.history);
  const recent = useStore(s => s.recent);
  const [text, setText] = useState('');
  const q = useFrameValue(text).trim();

  // Each opening starts from an empty query. Reset while rendering the opening (not in an effect), so a key
  // typed right after ⌘K is never wiped.
  // Each opening is also a fresh dialog: reopening while the last one still plays its exit animation would
  // otherwise revive that closing instance, which Radix then dismisses again (focus is already outside it).
  const [wasOpen, setWasOpen] = useState(open);
  const [generation, setGeneration] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText('');
      setGeneration(g => g + 1);
    }
  }

  const index = useMemo(() => (open ? indexFor(files, domain) : null), [open, files, domain]);
  const groups = useMemo(() => {
    if (!open) return [];
    if (!q) return groupRows(recentEntries(files, history, recent), true);
    return groupRows(index ? query(index, q).map(r => r.entry) : [], false);
  }, [open, q, index, files, history, recent]);
  const first = groups[0]?.rows[0]?.key ?? '';

  const byKey = useMemo(() => new Map(groups.flatMap(g => g.rows.map(r => [r.key, r.entry] as const))), [groups]);

  // A new query (or a new opening) starts from the first row; a live update keeps the row the user moved to while it still exists.
  const [picked, setPicked] = useState<{ q: string; gen: number; value: string }>({ q, gen: generation, value: first });
  const active = picked.q === q && picked.gen === generation && byKey.has(picked.value) ? picked.value : first;

  return (
    <Command.Dialog
      key={generation}
      open={open}
      onOpenChange={setPalette}
      label="Search"
      shouldFilter={false}
      vimBindings={false}
      loop
      value={active}
      onValueChange={v => setPicked({ q, gen: generation, value: v })}
      onKeyDown={e => {
        // Enter within a frame of typing: the results are a frame old, so open the best match for what is typed now.
        // Safari commits an IME conversion with an Enter that has isComposing false but keyCode 229.
        if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229 || !index) return;
        const now = text.trim();
        if (!now || now === q) return;
        e.preventDefault();
        const best = query(index, now, 1)[0];
        if (best) choose(best.entry);
      }}
      overlayClassName="pscrim"
      contentClassName="palette"
    >
      <FocusReturn open={open} />
      <Command.Input value={text} onValueChange={setText} placeholder="Search files, functions, routes, tables…" autoComplete="off" spellCheck={false} />
      <Command.List className="pres" label="Results">
        {groups.map(g => (
          <Command.Group key={g.heading} heading={g.heading}>
            {g.rows.map(({ key, entry }) => (
              <Command.Item key={key} value={key} className="pit" onSelect={v => choose(byKey.get(v) ?? entry)}>
                <RowIcon e={entry} />
                <RowLabel e={entry} />
                <small>
                  {entry.kind === 'file' && entry.layer && (
                    <i className="ldot" style={{ background: LAYERS[entry.layer].color }} title={LAYERS[entry.layer].name} aria-hidden="true" />
                  )}
                  {/* Clipped at the start, so the file name and line stay visible. */}
                  <span dir="rtl"><bdi>{entry.detail}</bdi></span>
                </small>
              </Command.Item>
            ))}
          </Command.Group>
        ))}
        {!groups.length && (
          <div className="pempty">{q ? `No matches for “${q}”` : 'Files you open show up here. Start typing to search.'}</div>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
