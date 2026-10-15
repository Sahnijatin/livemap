import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { LiveSession } from './LiveSession';
import { LEAVING, useGlide, useLeaving } from '../motion';
import { NARROW_QUERY, useMedia } from '../media';
import { INERT, shownLayout } from '../panels';
import { CollapseButton } from './Dock';

let Detail: typeof import('./FileDetail').FileDetail | undefined;
let loading: Promise<void> | undefined;
/**
 * Loads the file view (FileDetail.tsx, with the code view). The Inspector starts this on mount, right after first
 * paint, so it is in place before a file can be selected; a failed load is tried again on the next selection.
 */
export function loadDetail(): Promise<void> {
  loading ??= import('./FileDetail').then(m => { Detail = m.FileDetail; }, () => { loading = undefined; });
  return loading;
}

const OVERVIEW = '__overview';
/** Content cross-fade when switching between the Live session and a file, or between files. Matches `.ins-scroll.in/.leave`. */
const SWAP_MS = 180;

/** One inspector page: a file's details, or the Live session. Section height changes animate (useGlide). */
function Pane({ id, entering, leaving }: { id: string; entering: boolean; leaving: boolean }) {
  const file = useStore(s => (id === OVERVIEW ? undefined : s.files[id]));
  const box = useRef<HTMLDivElement>(null);
  useGlide(box);
  return (
    <div className={clsx('ins-scroll', leaving ? 'leave' : entering && 'in')} ref={box} {...(leaving ? LEAVING : {})}>
      {file ? Detail && <Detail file={file} /> : <LiveSession />}
    </div>
  );
}

export function Inspector() {
  const id = useStore(s => s.selected ?? OVERVIEW);
  const panel = useStore(s => s.panel);
  const collapsed = useStore(s => shownLayout(s.layout, s.peek).collapsed.inspector);
  // Below 1080 px a closed slide-over is off screen, and wider a collapsed panel is hidden: keep it out of the tab order.
  const narrow = useMedia(NARROW_QUERY);
  // The old page stays mounted (keyed by id, so never rebuilt) while it fades out over the new one.
  const { prev, from } = useLeaving(id, SWAP_MS);
  const ids = prev !== null ? [prev, id] : [id];
  // Re-renders once the file view has loaded (it normally has, long before the first selection).
  const [, setReady] = useState(!!Detail);
  useEffect(() => { if (!Detail) void loadDetail().then(() => setReady(!!Detail)); }, [id]);
  return (
    <aside
      id="inspector"
      className={clsx('insp glass', panel === 'inspector' && 'open')}
      aria-label="Inspector"
      data-panel="inspector"
      tabIndex={-1}
      {...((narrow ? panel !== 'inspector' : collapsed) ? INERT : {})}
    >
      <CollapseButton panel="inspector" />
      {ids.map(k => <Pane key={k} id={k} entering={from !== null && k === id} leaving={k === prev} />)}
    </aside>
  );
}
