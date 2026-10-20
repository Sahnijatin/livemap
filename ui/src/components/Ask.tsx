import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { useStore } from '../store';
import { authHeaders } from '../connection';
import { baseName } from '../recent';

/* The Ask view: questions about the project, answered by the configured AI provider from the project map. */

export interface AskItem { id: number; question: string; path: string | null; answer?: string; error?: string }

interface AskState {
  items: AskItem[];
  /** The file the next question is about; the inspector's "Ask about this file" sets it. */
  about: string | null;
  draft: string;
  setAbout(path: string | null): void;
  setDraft(text: string): void;
  ask(question: string): void;
  clear(): void;
}

let nextId = 1;

/** Kept outside the view so the thread survives tab switches (the view unmounts). */
export const useAsk = create<AskState>((set, get) => ({
  items: [],
  about: null,
  draft: '',
  setAbout: about => set({ about }),
  setDraft: draft => set({ draft }),
  clear: () => set({ items: [] }),
  ask(question) {
    const q = question.trim();
    if (!q) return;
    const id = nextId++;
    const path = get().about;
    set({ items: [...get().items, { id, question: q, path }], draft: '' });
    const done = (patch: Partial<AskItem>) => set({ items: get().items.map(i => (i.id === id ? { ...i, ...patch } : i)) });
    fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(path ? { question: q, path } : { question: q }),
    })
      .then(async res => {
        let j: { answer?: unknown; error?: unknown } = {};
        try { j = await res.json(); } catch { /* not JSON: fall back to the status */ }
        if (res.ok && typeof j.answer === 'string') return done({ answer: j.answer });
        done({ error: typeof j.error === 'string' ? j.error : `request failed (${res.status})` });
      })
      .catch(() => done({ error: 'LiveMap is not reachable. Is it still running?' }));
  },
}));

/** Opens the Ask tab about a file (or the whole project with null) and focuses the question box. */
export function askAbout(path: string | null): void {
  useAsk.getState().setAbout(path);
  useStore.getState().setTab('ask');
  window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.ask-in textarea')?.focus(), 250);
}

/** `code` spans and file mentions become clickable when they name a project file. */
function Inline({ text }: { text: string }) {
  const files = useStore(s => s.files);
  const select = useStore(s => s.select);
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={i}>{p.slice(2, -2)}</b>;
        if (!(p.startsWith('`') && p.endsWith('`') && p.length > 2)) return p;
        const code = p.slice(1, -1);
        const file = code.split(':')[0];
        return files[file]
          ? <button type="button" key={i} className="ask-ref" title={`Open ${file}`} onClick={() => select(file)}>{code}</button>
          : <code key={i}>{code}</code>;
      })}
    </>
  );
}

/** A plain-text answer with light markdown: paragraphs, bullet and numbered lists, fenced code, `code`. */
function Answer({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list.map((l, i) => <li key={i}><Inline text={l} /></li>)}</ul>);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) body.push(lines[i]);
      out.push(<pre key={`c${out.length}`}>{body.join('\n')}</pre>);
      continue;
    }
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { list.push(item[1]); continue; }
    flush();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) out.push(<p key={`h${out.length}`} className="ask-h">{h[1]}</p>);
    else if (line.trim()) out.push(<p key={`p${out.length}`}><Inline text={line} /></p>);
  }
  flush();
  return <div className="ask-a">{out}</div>;
}

const EXAMPLES = ['What does this project do, and where does it start?', 'How do the main parts connect to each other?', 'Which files would I touch to add a new API route?'];
const FILE_EXAMPLES = ['What does this file do?', 'What depends on this file, and what would break if I changed it?', 'Walk me through the main function.'];

export function AskView() {
  const { items, about, draft, setAbout, setDraft, ask, clear } = useAsk();
  const state = useStore(s => s.summaries.status.state);
  const replay = useStore(s => s.replay);
  const selected = useStore(s => s.selected);
  const end = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const busy = items.some(i => i.answer === undefined && i.error === undefined);
  const last = items[items.length - 1];

  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [items.length, last?.answer, last?.error]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!busy) ask(draft);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  if (replay) {
    return <div className="askv"><div className="ask-off"><b>Ask needs a running LiveMap</b>This is an exported replay, so there is no project or AI provider to ask.</div></div>;
  }
  if (state === 'off') {
    const example = `${JSON.stringify({ summaries: { enabled: true, provider: 'anthropic', apiKey: 'your-api-key' } }, null, 2)}\n`;
    return (
      <div className="askv">
        <div className="ask-off">
          <b>AI is off</b>
          Asking questions about the project uses the same provider as AI summaries. Add this to <code>~/.livemap/config.json</code> (your home folder, not the project) and restart LiveMap:
          <pre>{example}</pre>
          <button type="button" className="linkbtn" onClick={() => navigator.clipboard.writeText(example).then(() => setCopied(true), () => undefined)}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
    );
  }

  const examples = about ? FILE_EXAMPLES : EXAMPLES;
  return (
    <div className="askv">
      <div className="ask-thread" aria-live="polite">
        {items.length === 0 && (
          <div className="ask-empty">
            <b><span aria-hidden="true">✦ </span>Ask about {about ? baseName(about) : 'this project'}</b>
            <p className="muted">Answers come from the project map: files and their symbols, how files import and use each other, routes, tables, recent changes and the source of the most relevant files.</p>
            <div className="ask-ex">
              {examples.map(q => <button type="button" key={q} className="chip" onClick={() => ask(q)} disabled={busy}><span>{q}</span></button>)}
            </div>
          </div>
        )}
        {items.map(i => (
          <div className="ask-turn" key={i.id}>
            <div className="ask-q">{i.question}{i.path && <small> · about {baseName(i.path)}</small>}</div>
            {i.answer !== undefined ? <Answer text={i.answer} />
              : i.error !== undefined ? <div className="ask-a err"><b>Could not answer:</b> {i.error}{/unauthori[sz]ed|401|403/.test(i.error) && <p className="muted">Check the API key in ~/.livemap/config.json.</p>}{/404|not found/.test(i.error) && <p className="muted">Check the model name in ~/.livemap/config.json.</p>}</div>
              : <div className="ai-wait" aria-busy="true" aria-label="Thinking"><i /><i /></div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="ask-in" onSubmit={submit}>
        <div className="ask-scope">
          {about
            ? <button type="button" className="chip" title="Ask about the whole project instead" onClick={() => setAbout(null)}><span>About {baseName(about)}</span><small aria-hidden="true">×</small></button>
            : <span className="muted">About the whole project</span>}
          {!about && selected && <button type="button" className="linkbtn" onClick={() => setAbout(selected)}>Ask about {baseName(selected)} instead</button>}
          {items.length > 0 && <button type="button" className="linkbtn ask-clear" onClick={clear} disabled={busy}>Clear</button>}
        </div>
        <div className="ask-box">
          <textarea
            rows={2}
            value={draft}
            maxLength={2000}
            placeholder={about ? `Ask about ${baseName(about)}…` : 'Ask anything about this codebase…'}
            aria-label="Question"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="submit" className="ask-send" disabled={busy || !draft.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
        </div>
      </form>
    </div>
  );
}

export default AskView;
