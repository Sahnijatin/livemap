import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../store';
import type { Level } from './mapModel';
import { useMapActions } from './MapContext';
import { PHONE_QUERY, useMedia } from '../media';

/** Every item in the options menu, for arrow-key movement. */
const ITEM = '[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]';

const LEVELS: { level: Level; label: string }[] = [
  { level: 'folders', label: 'Folders' },
  { level: 'files', label: 'Files' },
  { level: 'functions', label: 'Functions' },
];

/** Selection and toggles: a gentle spring (spec §10). */
const SPRING = { type: 'spring', stiffness: 380, damping: 32 } as const;

/** Folders / Files / Functions, with a knob that springs under the current level (prototype `.mini-seg#zoomSeg`). */
function LevelControl() {
  const level = useStore(s => s.mapLevel);
  const setLevel = useStore(s => s.setMapLevel);
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const b = el.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (b) setKnob({ left: b.offsetLeft, width: b.offsetWidth });
    };
    place();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [level]);

  return (
    <div className="mini-seg" role="group" aria-label="Detail" ref={ref}>
      {knob && (
        <motion.i
          className="knob"
          aria-hidden="true"
          initial={false}
          animate={{ left: knob.left, width: knob.width }}
          transition={SPRING}
        />
      )}
      {LEVELS.map(l => (
        <button key={l.level} type="button" aria-pressed={l.level === level} onClick={() => setLevel(l.level)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Follow (prototype `.toggle#followBtn`): a switch; "Paused" shows while a user pan or zoom holds it off.
 * The accessible name stays "Follow"; "Paused" is the description.
 */
function FollowToggle({ paused }: { paused: boolean }) {
  const follow = useStore(s => s.follow);
  const setFollow = useStore(s => s.setFollow);
  const sub = useId();
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={follow}
      aria-label="Follow"
      aria-describedby={paused ? sub : undefined}
      title="Keep the file the agent is writing in view"
      onClick={() => setFollow(!follow)}
    >
      <span className="sw" aria-hidden="true" />
      Follow
      {paused && <span className="tg-sub" id={sub}>Paused</span>}
    </button>
  );
}

const Check = ({ on }: { on: boolean }) => (
  <svg className="mt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ visibility: on ? 'visible' : 'hidden' }}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** The "⋯" menu: Reset layout and Fit to screen. On a phone (`compact`) it also holds the detail level and Follow. */
function MoreMenu({ compact = false, followPaused = false }: { compact?: boolean; followPaused?: boolean }) {
  const actions = useMapActions();
  const level = useStore(s => s.mapLevel);
  const setLevel = useStore(s => s.setMapLevel);
  const follow = useStore(s => s.follow);
  const setFollow = useStore(s => s.setFollow);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const sub = useId();

  // Close on a press outside, and give focus to the first item when it opens.
  useEffect(() => {
    if (!open) return;
    (wrap.current?.querySelector<HTMLElement>('[aria-checked="true"][role=menuitemradio]') ?? wrap.current?.querySelector<HTMLElement>(ITEM))?.focus();
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const run = (fn: () => void) => () => { close(); fn(); };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      className="mt-more"
      ref={wrap}
      onKeyDown={onKeyDown}
      // Tabbing (or clicking) out of the button and menu closes it.
      onBlur={e => { if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <button
        type="button"
        ref={button}
        className="mt-btn"
        aria-label="Map options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="mt-menu"
            role="menu"
            aria-label="Map options"
            initial={{ opacity: 0, scale: 0.92, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.15 } }}
            transition={SPRING}
          >
            {compact && (
              <>
                <div role="group" aria-label="Detail">
                  {LEVELS.map(l => (
                    <button key={l.level} type="button" role="menuitemradio" aria-checked={l.level === level} tabIndex={-1} onClick={run(() => setLevel(l.level))}>
                      <Check on={l.level === level} />{l.label}
                    </button>
                  ))}
                </div>
                <div className="mt-sep" role="separator" />
                <button
                  type="button" role="menuitemcheckbox" aria-checked={follow} tabIndex={-1} className="mt-follow"
                  aria-label="Follow" aria-describedby={followPaused ? sub : undefined} onClick={run(() => setFollow(!follow))}
                >
                  <span className="toggle-sw" aria-hidden="true"><span className="sw" /></span>Follow
                  {followPaused && <span className="tg-sub" id={sub}>Paused</span>}
                </button>
                <div className="mt-sep" role="separator" />
              </>
            )}
            <button type="button" role="menuitem" tabIndex={-1} onClick={run(actions.resetLayout)}>Reset layout</button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={run(actions.fitAll)}>Fit to screen</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The Map's tools in the center head (prototype `.c-tools`): detail level, Follow, and the options menu. */
export function MapTools({ followPaused = false }: { followPaused?: boolean }) {
  // On a phone the head has room for the tabs and one button: the level and Follow move into the menu.
  const phone = useMedia(PHONE_QUERY);
  if (phone) return <MoreMenu compact followPaused={followPaused} />;
  return (
    <>
      <LevelControl />
      <FollowToggle paused={followPaused} />
      <MoreMenu />
    </>
  );
}
