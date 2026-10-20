import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import type { Ticks } from '@shared/history.js';
import { liveGeneration, useStore } from '../store';
import { clock } from '../agents';
import { bucketsFor, dominantKind, historySource, latestThrottle } from '../history';
import { PauseIcon, PlayIcon } from './icons';
import { BackToLive } from './Rewound';

export { BackToLive, RewoundBanner } from './Rewound';

/** Ticks refresh at most this often while recording. */
const TICKS_EVERY_MS = 5000;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The widest times this locale prints (two-digit hours, morning and evening): they size the reserved time slot. */
const WIDEST_TIMES = [clock(new Date(2000, 0, 1, 10, 58).getTime()), clock(new Date(2000, 0, 1, 22, 58).getTime())];

/**
 * An invisible copy of the REWOUND side (chip, widest time, Back to live) stacked under the shown side,
 * so the side is always as wide as its widest state: the track never shrinks when a drag rewinds. A replay
 * has no Back to live, so its copy leaves that out.
 */
function SideGhost({ back }: { back: boolean }) {
  return (
    <span className="tl-ghost" aria-hidden="true">
      <span className="g-state">REWOUND</span>
      <span className="g-time">{WIDEST_TIMES.map(t => <span key={t}>{t}</span>)}</span>
      {back && <span className="g-back">Back to live</span>}
    </span>
  );
}

/** The bucket index holding `seq` (the last bucket starting at or before it); -1 before the first. */
function bucketOf(t: Ticks, seq: number): number {
  let i = -1;
  while (i + 1 < t.buckets.length && t.buckets[i + 1].seq <= seq) i++;
  return i;
}

/**
 * The session timeline (prototype `.timeline`): play or pause, a track of colored activity ticks with
 * run separators and a draggable thumb, and the LIVE or REWOUND state. Dragging, the arrow keys, Home
 * and End rewind the whole UI; releasing at the right end or End returns to live.
 */
// ServiceNow filters, badge, diagnostics and the notices link: their own chunk, loaded from this one (itself lazy,
// right after first paint) so the main chunk carries none of it. A replay has no server to ask.
const SnHost = lazy(() => import('../sn/SnHost'));

export function Timeline() {
  const status = useStore(s => s.historyStatus);
  const rewound = useStore(s => s.rewound);
  const playing = useStore(s => s.playing);
  const replay = useStore(s => s.replay);

  const trackRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ticks, setTicks] = useState<Ticks | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  /** The seq a key press or click asked for, shown until its state arrives. */
  const [aim, setAim] = useState<number | null>(null);
  const stopPlay = useRef<(() => void) | null>(null);
  /** Bumped by every start and stop: a start that awaited (state, engine) gives up when it changed. */
  const playToken = useRef(0);
  /** A Play is loading the engine or the first state: the button shows Pause, and a click cancels. */
  const [starting, setStarting] = useState(false);

  // Track width, for the bucket count. The center pane's width follows the window (its breakpoints).
  useLayoutEffect(() => {
    const measure = () => setWidth(trackRef.current!.clientWidth);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Ticks: on first show, then on resize or when recording moves on, while the timeline is idle (at most every 5 s).
  const idle = !rewound && drag === null && !playing;
  const fetchedAt = useRef(-Infinity);
  const buckets = width > 0 ? bucketsFor(width) : 0;
  const none = !ticks;
  useEffect(() => {
    if (!status.enabled || !buckets || !status.last || (!none && !idle)) return;
    let live = true;
    const load = () => {
      fetchedAt.current = Date.now();
      historySource().ticks(buckets).then(t => { if (live) setTicks(t); }, () => undefined);
    };
    // The first load is immediate (also while rewound); refreshes wait for the 5 s spacing.
    const wait = none ? 0 : fetchedAt.current + TICKS_EVERY_MS - Date.now();
    const timer = wait > 0 ? window.setTimeout(load, wait) : (load(), undefined);
    return () => { live = false; window.clearTimeout(timer); };
  }, [status.enabled, status.last, buckets, idle, none]);

  const rewind = useStore(s => s.rewind);
  // A past state asked for before a return to live (from any Back to live button) never rewinds again:
  // the live generation is taken when the seek is asked for, not when the throttle gets to it.
  const throttle = useMemo(() => latestThrottle(
    ({ seq, gen }: { seq: number; gen: number }) => historySource().stateAt(seq).then(st => ({ st, gen })),
    ({ st, gen }) => { if (gen === liveGeneration()) rewind(st); },
    undefined,
    // A failed request leaves the view where it was: drop the aim so the thumb shows it again.
    () => setAim(null),
  ), [rewind]);
  // Unmount: drop pending state requests and stop playback (stop only touches refs and the store).
  useEffect(() => () => { throttle.cancel(); stop(); }, [throttle]); // eslint-disable-line react-hooks/exhaustive-deps
  // Playback ends when anything stops it (Back to live, a drag, Pause).
  useEffect(() => { if (!playing) stop(); }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const from = ticks?.from ?? status.first;
  const to = ticks?.to ?? status.last;
  const span = Math.max(0, to - from);
  const fracOf = (seq: number) => (span ? clamp01((seq - from) / span) : 1);
  const seqAt = (frac: number) => Math.round(from + frac * span);

  // The aim holds until its state arrives, or until the view returns to live (rewound set to null);
  // while a first rewind from live is pending, rewound is still null and the aim must stay.
  const wasRewound = useRef(rewound !== null);
  useEffect(() => {
    if (rewound ? rewound.seq === aim : wasRewound.current) setAim(null);
    wasRewound.current = rewound !== null;
  }, [rewound, aim]);

  const stop = () => {
    playToken.current++;
    setStarting(false);
    stopPlay.current?.();
    stopPlay.current = null;
    if (useStore.getState().playing) useStore.getState().setPlaying(false);
  };

  const goLive = () => {
    stop();
    throttle.cancel();
    setAim(null);
    void useStore.getState().backToLive();
  };

  const request = (seq: number) => throttle.request({ seq, gen: liveGeneration() });

  const seek = (seq: number) => {
    stop();
    setAim(seq);
    request(seq);
  };

  const disabled = !status.enabled || !status.last;

  // Pointer: press and drag anywhere on the track; release at the right end returns to live.
  const atEnd = (frac: number) => frac >= 1 || (width > 0 && (1 - frac) * width < 2);
  const fracFrom = (x: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return r.width ? clamp01((x - r.left) / r.width) : 1;
  };
  const move = (frac: number) => {
    setDrag(frac);
    if (!atEnd(frac)) request(seqAt(frac));
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    stop();
    trackRef.current?.setPointerCapture?.(e.pointerId);
    move(fracFrom(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) move(fracFrom(e.clientX));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const frac = fracFrom(e.clientX);
    setDrag(null);
    if (atEnd(frac)) goLive();
    else setAim(seqAt(frac));
  };

  const shownSeq = drag !== null ? (atEnd(drag) ? null : seqAt(drag)) : aim ?? rewound?.seq ?? null;
  const frac = drag ?? (shownSeq === null ? 1 : fracOf(shownSeq));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'End') { e.preventDefault(); goLive(); return; }
    if (e.key === 'Home') { e.preventDefault(); seek(status.first); return; }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step || !ticks?.buckets.length) return;
    e.preventDefault();
    const n = ticks.buckets.length;
    const cur = shownSeq === null ? n : Math.max(0, bucketOf(ticks, shownSeq));
    const next = cur + step * (e.shiftKey ? 10 : 1);
    if (next >= n) goLive();
    else seek(ticks.buckets[Math.max(0, next)].seq);
  };

  const togglePlay = async () => {
    if (useStore.getState().playing || starting) return stop();
    // Any stop while this start awaits makes it give up (one engine at a time).
    const token = ++playToken.current;
    const current = () => token === playToken.current;
    setStarting(true);
    throttle.cancel();
    setAim(null);
    const { startPlayback } = await import('../play');
    if (!current()) return;
    const stopper = await startPlayback(current, stop);
    if (!current()) return stopper?.();
    stopPlay.current = stopper;
    setStarting(false);
  };

  // Ticks: colored by their dominant kind, bar height by activity.
  const sums = useMemo(() => ticks?.buckets.map(b => Object.values(b.counts).reduce((a, n) => a + n, 0)) ?? [], [ticks]);
  const max = Math.max(1, ...sums);

  // Slider value: the seq on show (the newest at live), its time and the events in its bucket.
  const valueNow = shownSeq ?? status.last;
  const bi = ticks ? bucketOf(ticks, valueNow) : -1;
  const bucket = ticks?.buckets[bi];
  const events = sums[bi] ?? 0;
  const past = shownSeq !== null;
  const at = (past && rewound?.seq === shownSeq ? rewound.at : bucket?.at) ?? status.lastAt;
  const valueText = `${past ? '' : 'Live, '}${clock(at)}, ${events} event${events === 1 ? '' : 's'}`;
  const pct = `${frac * 100}%`;
  const busy = playing || starting;
  const playLabel = busy ? 'Pause playback' : 'Play history';

  return (
    <div className={clsx('timeline', !status.enabled && 'off', past && 'past')} role="group" aria-label="Session timeline">
      {/* Renders only portals (into the toolbar, the center and the inspector), never inside the timeline. */}
      {!replay && import.meta.env.MODE !== 'export' && <Suspense fallback={null}><SnHost /></Suspense>}
      <button
        type="button"
        className="play"
        aria-label={playLabel}
        title={playLabel}
        onClick={() => void togglePlay()}
        disabled={disabled}
      >
        {busy ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div
        className={clsx('track', drag !== null && 'drag')}
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="rail" />
        <div className="fill" style={{ width: pct }} />
        <div className="tl-ticks" aria-hidden="true">
          {ticks?.buckets.map((b, i) => {
            const kind = dominantKind(b.counts);
            const f = fracOf(b.seq);
            return kind && (
              <i key={b.seq} className={clsx('tick', f > frac && 'ahead')} data-kind={kind} style={{ left: `${f * 100}%`, '--h': Math.sqrt(sums[i] / max) } as CSSProperties} />
            );
          })}
        </div>
        {ticks?.runStarts.map(r => r > from && <i key={r} className="tl-run" title="LiveMap restarted" style={{ left: `${fracOf(r) * 100}%` }} />)}
        <div
          className="thumb"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Time"
          aria-valuemin={status.first}
          aria-valuemax={status.last}
          aria-valuenow={valueNow}
          aria-valuetext={valueText}
          style={{ left: pct }}
          onKeyDown={onKeyDown}
        />
      </div>
      {!status.enabled ? (
        <span className="tl-msg" role="status">{status.off ? 'History is off' : `History is unavailable: ${status.error ?? 'recording is off'}`}</span>
      ) : past ? (
        <span className="tl-side">
          <span className="tl-face">
            <span className="tl-state past">REWOUND</span>
            <span className="tl-time">{clock(at)}</span>
            <BackToLive className="tl-back-inline" onClick={goLive} />
          </span>
          <SideGhost back={!replay} />
        </span>
      ) : (
        <span className="tl-side">
          <span className="tl-face">
            <span className="tl-state live"><i className="dot live" aria-hidden="true" />LIVE</span>
          </span>
          <SideGhost back={!replay} />
        </span>
      )}
    </div>
  );
}
