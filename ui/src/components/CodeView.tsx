import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import type { ChangeSummary, FileModel } from '@shared/types.js';
import { authHeaders } from '../connection';
import { changedLines } from '../changes';
import { highlight, MAX_HIGHLIGHT_LINES } from '../highlight';
import { useStore } from '../store';
import { lineScrollTop, prefersReducedMotion } from '../scroll';
import { LockIcon } from './icons';

type Load =
  | { state: 'loading' }
  | { state: 'ok'; content: string }
  | { state: 'error'; message: string };

/** Why a file's content is not shown, from its flags; null when it can be shown. */
export function notShownReason(file: FileModel): string | null {
  if (file.flags.secret) return 'This file may hold secrets. LiveMap lists key names only and never reads values.';
  if (file.flags.binary) return 'Binary file.';
  if (file.flags.tooLarge) return 'Larger than 1 MB, so it is listed but not read.';
  return null;
}

function NotShown({ reason }: { reason: string }) {
  return (
    <div className="notshown">
      <span className="ic" style={{ ['--lt' as string]: 'var(--hair)', ['--lc' as string]: 'var(--ink2)' }}><LockIcon /></span>
      <span><b>Not shown</b>{reason}</span>
    </div>
  );
}

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

function Tokens({ line }: { line: ThemedToken[] }) {
  return (
    <>
      {line.map((t, i) => (
        <span
          key={i}
          style={{
            color: t.color,
            fontStyle: t.fontStyle && t.fontStyle & FONT_ITALIC ? 'italic' : undefined,
            fontWeight: t.fontStyle && t.fontStyle & FONT_BOLD ? 600 : undefined,
          }}
        >
          {t.content}
        </span>
      ))}
    </>
  );
}

interface View { path: string; lines: string[]; tokens: ThemedToken[][] | null }

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');

export function CodeView({ file, change }: { file: FileModel; change: ChangeSummary | undefined }) {
  const reason = notShownReason(file);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [view, setView] = useState<View | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);
  const reveal = useStore(s => s.reveal);
  const version = `${file.path}|${file.size}|${file.lines}|${change?.id ?? 0}`;

  useEffect(() => {
    if (reason) return;
    const ctrl = new AbortController();
    setLoad(prev => (prev.state === 'ok' ? prev : { state: 'loading' }));
    fetch(`/api/file?path=${encodeURIComponent(file.path)}`, { headers: authHeaders(), signal: ctrl.signal })
      .then(async res => {
        if (res.status === 403) return setLoad({ state: 'error', message: 'This file cannot be shown.' });
        if (res.status === 404) return setLoad({ state: 'error', message: 'This file no longer exists.' });
        if (res.status === 401) return setLoad({ state: 'error', message: 'Open the link printed in your terminal to see code.' });
        if (!res.ok) return setLoad({ state: 'error', message: 'Could not load this file.' });
        const body = (await res.json()) as { content: string };
        setLoad({ state: 'ok', content: body.content });
      })
      .catch(e => { if ((e as Error).name !== 'AbortError') setLoad({ state: 'error', message: 'Could not load this file.' }); });
    return () => ctrl.abort();
  }, [version, reason, file.path]);

  // Reset when switching files so the previous file's code never shows under a new header.
  useEffect(() => { setLoad({ state: 'loading' }); }, [file.path]);

  const content = load.state === 'ok' ? load.content : null;

  // New content keeps showing the previous highlighted view of this file until its tokens arrive.
  useEffect(() => {
    if (content === null) return;
    const text = normalize(content);
    const lines = text.split('\n');
    const plain: View = { path: file.path, lines, tokens: null };
    if (lines.length > MAX_HIGHLIGHT_LINES) { setView(plain); return; }
    setView(v => (v && v.path === file.path ? v : plain));
    let live = true;
    highlight(text, file.lang, file.path).then(tokens => { if (live) setView({ path: file.path, lines, tokens }); });
    return () => { live = false; };
  }, [content, file.lang, file.path]);

  const hl = useMemo(() => changedLines(change), [change]);
  const firstChanged = useMemo(() => (hl.size ? Math.min(...hl) : null), [hl]);
  const shown = view && view.path === file.path && content !== null ? view : null;

  const scrollTo = (line: number, flash: boolean, intoView: boolean): boolean => {
    const box = boxRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!box || !el) return false;
    box.scrollTop = lineScrollTop(box, el);
    if (intoView) box.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    return true;
  };

  // Follow the latest change into view (once per new content, not when tokens arrive).
  const shownLines = shown?.lines;
  useEffect(() => {
    if (firstChanged !== null && shownLines) scrollTo(firstChanged, false, false);
  }, [firstChanged, shownLines]);

  // A symbol picked in the tree or the inspector; consumed once it has been shown.
  useEffect(() => {
    if (reveal && reveal.path === file.path && shownLines && scrollTo(reveal.line, true, true)) useStore.getState().clearReveal();
  }, [reveal, shownLines, file.path]);

  if (reason) return <NotShown reason={reason} />;
  if (load.state === 'error') return <NotShown reason={load.message} />;
  if (!shown) return <pre className="code" aria-busy="true"><div className="muted">Loading code</div></pre>;

  return (
    <pre className="code" ref={boxRef} tabIndex={0} aria-label={`Code of ${file.path}`}>
      {shown.lines.map((text, i) => {
        const n = i + 1;
        const toks = shown.tokens?.[i];
        return (
          <div key={n} data-line={n} className={hl.has(n) ? 'hl' : undefined}>
            <span className="n">{n}</span>
            {toks ? <Tokens line={toks} /> : text}
          </div>
        );
      })}
      {shown.lines.length === 1 && shown.lines[0] === '' && <div className="muted">Empty file</div>}
    </pre>
  );
}
