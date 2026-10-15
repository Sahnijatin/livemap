import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';
import { LiveHead, LiveSession } from './LiveSession';
import { CollapseButton } from './Dock';
import { LEAVING, useGlide, useLeaving } from '../motion';
import { NARROW_QUERY, useMedia } from '../media';
import { INERT, focusOpener, shownLayout } from '../panels';

let Detail: typeof import('./FileDetail').FileDetail | undefined;
let loading: Promise<boolean> | undefined;
/** Where the file view comes from (tests swap in a failing loader). */
export const detailLoader = { load: () => import('./FileDetail') };
/**
 * Loads the file view (FileDetail.tsx, with the code view); resolves to whether it is in place. The Inspector starts
 * this on mount, right after first paint, so it is there before a file can be selected. A failed load shows a Retry
 * button and is tried again on the next selection of any file.
 */
export function loadDetail(): Promise<boolean> {
  loading ??= detailLoader.load().then(m => { Detail = m.FileDetail; return true; }, () => { loading = undefined; return false; });
  return loading;
}

const OVERVIEW = '__overview';
/** Content cross-fade when switching between the Live session and a file, or between files. Matches `.ins-scroll.in/.leave`. */
const SWAP_MS = 180;

/** One inspector page: a file's details, or the Live session. Section height changes animate (useGlide). */
type View = typeof import('./FileDetail').FileDetail;

function Pane({ id, entering, leaving, View, failed, retry }: { id: string; entering: boolean; leaving: boolean; View?: View; failed: boolean; retry(): void }) {
  const file = useStore(s => (id === OVERVIEW ? undefined : s.files[id]));
  const box = useRef<HTMLDivElement>(null);
  useGlide(box);
  return (
    <div className={clsx('ins-scroll', leaving ? 'leave' : entering && 'in')} ref={box} {...(leaving ? LEAVING : {})}>
      {!file ? <LiveSession /> : View ? <View file={file} /> : failed && (
        <div className="note err" role="alert">
          Could not load the file view. <button type="button" className="linkbtn" onClick={retry}>Retry</button>
        </div>
      )}
    </div>
  );
}

export function Inspector() {
  const id = useStore(s => s.selected ?? OVERVIEW);
  const hasFile = useStore(s => s.selected !== null && !!s.files[s.selected]);
  const panel = useStore(s => s.panel);
  const collapsed = useStore(s => shownLayout(s).collapsed.inspector);
  // Below 1080 px a closed slide-over is off screen, and wider a collapsed panel is hidden: keep it out of the tab order.
  const narrow = useMedia(NARROW_QUERY);
  // The old page stays mounted (keyed by id, so never rebuilt) while it fades out over the new one.
  const { prev, from } = useLeaving(id, SWAP_MS);
  const ids = prev !== null ? [prev, id] : [id];
  // Loads the file view on mount and, after a failure, again on each selection (it normally loaded long before). The
  // loaded view is state, so a file selected while it loads renders when it arrives.
  const selects = useStore(s => s.selects);
  const [View, setView] = useState<View | undefined>(() => Detail);
  const [failed, setFailed] = useState(false);
  const retry = () => {
    if (!Detail) void loadDetail().then(ok => { setFailed(!ok); setView(() => Detail); });
  };
  useEffect(retry, [selects]);

  // A peek that ends (back to the Live session, or the selected file deleted) hides a collapsed inspector. Focus that
  // was in it, including on a control that just went away, moves to the toolbar's Inspector button.
  const box = useRef<HTMLElement>(null);
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!collapsed || narrow) return;
    const a = document.activeElement;
    if (box.current?.contains(a) || (focused.current && (!a || a === document.body))) focusOpener('inspector');
    focused.current = false;
  }, [collapsed]);
  return (
    <aside
      id="inspector"
      className={clsx('insp glass', panel === 'inspector' && 'open')}
      aria-label="Inspector"
      data-panel="inspector"
      tabIndex={-1}
      ref={box}
      onFocus={() => { focused.current = true; }}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused.current = false; }}
      {...((narrow ? panel !== 'inspector' : collapsed) ? INERT : {})}
    >
      {/* The bar stays put above the scrolling view: its header and the hide button, so nothing scrolls under them. */}
      <div className="ins-bar">
        {hasFile ? <button type="button" className="backbtn" onClick={() => useStore.getState().select(null)}>‹ Live session</button> : <LiveHead />}
        <CollapseButton panel="inspector" />
      </div>
      <div className="ins-body">
        {ids.map(k => <Pane key={k} id={k} entering={from !== null && k === id} leaving={k === prev} View={View} failed={failed} retry={retry} />)}
      </div>
    </aside>
  );
}
