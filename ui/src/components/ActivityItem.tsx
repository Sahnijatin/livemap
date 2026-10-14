import { memo, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AgentEvent, ChangeSummary, FileModel } from '@shared/types.js';
import { useStore } from '../store';
import { agentName } from '../agents';
import { changeFacts } from '../changes';
import { layerOf } from '../layers';
import { prefersReducedMotion } from '../scroll';
import type { FeedItem } from '../feed';
import { Avatar } from './Avatar';
import { Chevron, CheckIcon, CrossIcon, GitIcon, LayerTile } from './icons';

/** Message ids already typed out, so a remount (Show earlier, reconnect) never types twice. */
const typed = new Set<number>();
/** Long typing still finishes quickly. */
const TYPE_MS = 1200;
const CLAMP = 900;
const MAX_FACTS = 6;
const MAX_DIFF_LINES = 400;

const raf = (cb: FrameRequestCallback): number =>
  typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(cb) : window.setTimeout(() => cb(performance.now()), 16);
const caf = (id: number): void => (typeof window.cancelAnimationFrame === 'function' ? window.cancelAnimationFrame(id) : window.clearTimeout(id));

/** Text that clamps when long; `animate` types it out once (about 1.2 s whatever its length). */
function Prose({ id, text, animate, className }: { id: number; text: string; animate: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const limit = open || text.length <= CLAMP + 100 ? text.length : CLAMP;
  // Decided up front so a reduced-motion reader never sees an empty message for a frame.
  const [shown, setShown] = useState(() => (animate && !typed.has(id) && !prefersReducedMotion() ? 0 : Infinity));
  const typing = shown < limit;

  useEffect(() => {
    if (shown === Infinity) return;
    typed.add(id);
    const t0 = performance.now();
    let h = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / TYPE_MS);
      const eased = 1 - Math.pow(1 - p, 2);
      setShown(p >= 1 ? Infinity : Math.max(1, Math.round(limit * eased)));
      if (p < 1) h = raf(tick);
    };
    h = raf(tick);
    return () => caf(h);
    // Types once per mount; later text changes render directly.
  }, []);

  return (
    <div className={clsx('prose', className, typing && 'typing')}>
      <p>
        {text.slice(0, Math.min(shown, limit))}
        {typing && <span className="caret" aria-hidden="true" />}
        {!typing && limit < text.length && '…'}
      </p>
      {!typing && text.length > CLAMP + 100 && (
        <button type="button" className="linkbtn" onClick={() => setOpen(o => !o)}>{open ? 'Show less' : 'Show more'}</button>
      )}
    </div>
  );
}

function Prompt({ ev }: { ev: AgentEvent }) {
  return <div className="fi f-prompt"><Prose id={ev.id} text={ev.text ?? ''} animate={false} /></div>;
}

function Message({ ev, live }: { ev: AgentEvent; live: boolean }) {
  return (
    <div className={clsx('fi f-msg', ev.subagent && 'sub')}>
      <Avatar agent={ev.agent} />
      <Prose id={ev.id} text={ev.text ?? ''} animate={live} />
    </div>
  );
}

function Thinking({ ev }: { ev: AgentEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={clsx('fi f-think', open && 'open')}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Chevron /><span>Thinking</span>
      </button>
      {open && <p>{ev.text}</p>}
    </div>
  );
}

const secs = (ms: number) => (ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

function Tool({ ev, end, working }: { ev: AgentEvent; end?: AgentEvent; working: boolean }) {
  const [open, setOpen] = useState(false);
  const tool = end?.tool ?? ev.tool;
  const label = ev.tool?.label || end?.tool?.label || tool?.name || 'Tool';
  const isEnd = ev.type === 'tool_end';
  const done = isEnd || !!end;
  const ok = isEnd ? ev.tool?.ok : end?.tool?.ok;
  const failed = ok === false;
  const output = (isEnd ? ev.tool?.output : end?.tool?.output) ?? '';
  const running = !done && working;
  const icon = running
    ? <span className="spinner" role="status" aria-label="Running" />
    : done
      ? failed
        ? <span className="bad" aria-label="Failed"><CrossIcon /></span>
        // Some agents never report success or failure: finished, without a verdict.
        : ok === true ? <span className="ok" aria-label="Done"><CheckIcon /></span> : <span className="fin" aria-label="Finished" />
      : <span className="stopped" aria-label="No result" />;
  const body = (
    <>
      {icon}
      <span className="lbl">{label}</span>
      {end && <span className="dur">{secs(end.at - ev.at)}</span>}
      {output && <Chevron />}
    </>
  );
  return (
    <div className={clsx('fi f-tool', running && 'running', failed && 'failed', open && 'open', ev.subagent && 'sub')}>
      {output
        ? <button type="button" className="trow" aria-expanded={open} onClick={() => setOpen(o => !o)}>{body}</button>
        : <div className="trow">{body}</div>}
      {open && output && <pre className="f-out">{output}</pre>}
    </div>
  );
}

function hunkLines(c: ChangeSummary): { cls: string; text: string }[] {
  const out: { cls: string; text: string }[] = [];
  for (const h of c.hunks) {
    out.push({ cls: 'h', text: `@@ -${h.oldStart} +${h.newStart} @@` });
    for (const l of h.lines) {
      if (out.length >= MAX_DIFF_LINES) return out;
      out.push({ cls: l[0] === '+' ? 'a' : l[0] === '-' ? 'r' : '', text: l });
    }
  }
  return out;
}

function Change({ change: c }: { change: ChangeSummary }) {
  const [open, setOpen] = useState(false);
  const select = useStore(s => s.select);
  const facts = changeFacts(c);
  const layer = layerOf(c.path, { lang: c.lang } as FileModel);
  const kind = c.kind === 'created' ? ['New', 't-add'] : c.kind === 'deleted' ? ['Deleted', 't-del'] : ['Edited', 't-chg'];
  const a = c.attribution;
  const lines = open ? hunkLines(c) : [];
  return (
    <article className={clsx('fi f-chg', open && 'open')}>
      <button type="button" className="ch" onClick={() => select(c.path)} title={`Open ${c.path}`}>
        <LayerTile layer={layer} className="ic" />
        <span className="p">{c.path}</span>
        <span className={clsx('tg', kind[1])}>{kind[0]}</span>
        {c.kind !== 'deleted' && (
          <span className="cntx"><span className="plus">+{c.lines.added}</span> <span className="minus">−{c.lines.removed}</span></span>
        )}
      </button>
      {facts.length > 0 && (
        <div className="facts">
          {facts.slice(0, MAX_FACTS).map((f, i) => (
            <div className="fact" key={i} style={{ animationDelay: `${120 + i * 90}ms` }}>
              <span className={clsx('tg', `t-${f.tone}`)}>{f.label}</span>{' '}
              <span className="fx"><code>{f.code}</code>{f.note && <small> {f.note}</small>}</span>
            </div>
          ))}
          {facts.length > MAX_FACTS && <div className="fact more">+{facts.length - MAX_FACTS} more</div>}
        </div>
      )}
      {(a || c.hunks.length > 0) && (
        <div className="chg-foot">
          {a && (
            <span className={clsx('ag-badge', a.confidence)} title={a.confidence === 'exact' ? 'Matched to the tool call that wrote this file' : 'The agent was active when this file changed'}>
              <Avatar agent={a.agent} />{agentName(a.agent)} · {a.confidence}
            </span>
          )}
          {c.hunks.length > 0 && (
            <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide diff' : 'Show diff'}</button>
          )}
        </div>
      )}
      {open && (
        <div className="diff">
          {lines.map((l, i) => <span key={i} className={l.cls}>{l.text || ' '}</span>)}
          {(c.truncated || lines.length >= MAX_DIFF_LINES) && <span className="h">Diff shortened. Open the file to see all of it.</span>}
        </div>
      )}
    </article>
  );
}

function Commit({ ev }: { ev: AgentEvent }) {
  const text = ev.text ?? '';
  const nl = text.indexOf('\n');
  const subject = nl < 0 ? text : text.slice(0, nl);
  const body = nl < 0 ? '' : text.slice(nl).trim();
  return (
    <div className="fi f-git">
      <span className="gic"><GitIcon /></span>
      <div className="gtx">
        <b>{subject || 'Commit'}</b>
        {body && <p>{body}</p>}
        <small>Committed by {ev.sessionId || 'someone'}</small>
      </div>
    </div>
  );
}

interface RowProps { item: FeedItem; live: boolean; working: boolean }

function Row({ item, live, working }: RowProps) {
  if (item.t === 'change') return <Change change={item.change} />;
  const ev = item.ev;
  switch (ev.type) {
    case 'prompt': return <Prompt ev={ev} />;
    case 'message': return <Message ev={ev} live={live} />;
    case 'thinking': return <Thinking ev={ev} />;
    case 'tool_start':
    case 'tool_end': return <Tool ev={ev} end={item.end} working={working} />;
    case 'commit': return <Commit ev={ev} />;
    default: return null;
  }
}

/** Feed rows are rebuilt per message, so compare what each row renders, not the wrapper object. */
export const ActivityItem = memo(Row, (a, b) =>
  a.live === b.live && a.working === b.working && a.item.t === b.item.t &&
  (a.item.t === 'change'
    ? a.item.change === (b.item as typeof a.item).change
    : a.item.ev === (b.item as typeof a.item).ev && a.item.end === (b.item as typeof a.item).end));
