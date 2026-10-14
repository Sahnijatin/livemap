import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { MotionConfig } from 'framer-motion';
import { prefersReducedMotion } from './scroll';

/*
 * Shared motion tokens (spec §10). framer-motion code (the lazy Map) uses these directly. The first-paint
 * chunk animates in CSS with the same curves (`--ease`, `--spring-gentle`, `--layout-glide` in styles.css),
 * because framer's `m` runtime alone would add about 14 kB gzip to Activity's first paint.
 */

/** Movement: cubic-bezier(.32,.72,0,1). */
export const EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];
/** Selection and toggles: a gentle spring. */
export const SPRING = { type: 'spring', stiffness: 380, damping: 32 } as const;
/** Layout moves: critically damped. */
export const LAYOUT = { type: 'spring', bounce: 0, duration: 0.45 } as const;

const DEFAULT_TRANSITION = { duration: 0.45, ease: EASE };
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia?.(QUERY);
  if (!mq?.addEventListener) return () => {};
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** True while the reader asks for reduced motion; follows changes to the setting. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}

/**
 * Motion context for the whole app: framer-motion honors the reduced-motion setting, and under it skips
 * every animation (opacity included), so each one becomes an instant state change.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  return (
    <MotionConfig reducedMotion="user" skipAnimations={reduced} transition={DEFAULT_TRANSITION}>
      {children}
    </MotionConfig>
  );
}

/**
 * For a view that swaps on `value`: `prev` is the value being replaced while its exit plays (`ms`), then
 * null; `from` is the value before the last change (null until the first change). Nothing leaves under
 * reduced motion.
 */
export function useLeaving<T>(value: T, ms: number): { prev: T | null; from: T | null } {
  const reduced = usePrefersReducedMotion();
  const [st, setSt] = useState<{ value: T; prev: T | null; from: T | null; seq: number }>({ value, prev: null, from: null, seq: 0 });
  if (!Object.is(st.value, value)) setSt({ value, prev: reduced ? null : st.value, from: st.value, seq: st.seq + 1 });
  const { prev, seq } = st;
  useEffect(() => {
    if (prev === null) return;
    const t = window.setTimeout(() => setSt(s => (s.seq === seq ? { ...s, prev: null } : s)), ms);
    return () => window.clearTimeout(t);
  }, [prev, seq, ms]);
  return { prev: st.prev, from: st.from };
}

/** Props for a view that is playing its exit: out of the tab order and the accessibility tree. */
export const LEAVING = { inert: '', 'aria-hidden': true } as Record<string, unknown>;

export interface Presence<T> { item: T; leaving: boolean }
interface Gone<T> { item: T; index: number; until: number }

/**
 * A list whose removed items stay in place, marked `leaving`, for `ms` so they can play an exit.
 * An item that comes back while leaving is simply present again. Nothing lingers under reduced motion.
 */
export function usePresenceList<T>(items: T[], key: (item: T) => string, ms: number): Presence<T>[] {
  const reduced = usePrefersReducedMotion();
  const sig = items.map(key).join('\n');
  const last = useRef(items);
  const [st, setSt] = useState<{ sig: string; gone: Gone<T>[] }>({ sig, gone: [] });
  if (st.sig !== sig) {
    const here = new Set(items.map(key));
    const kept = reduced ? [] : st.gone.filter(g => !here.has(key(g.item)));
    const lingering = new Set(kept.map(g => key(g.item)));
    const until = Date.now() + ms;
    const removed = reduced ? [] : last.current.flatMap((item, index) =>
      here.has(key(item)) || lingering.has(key(item)) ? [] : [{ item, index, until }]);
    setSt({ sig, gone: [...kept, ...removed] });
  }
  useEffect(() => { last.current = items; });
  const { gone } = st;
  useEffect(() => {
    if (!gone.length) return;
    const next = Math.min(...gone.map(g => g.until));
    const t = window.setTimeout(() => {
      const now = Date.now();
      setSt(s => ({ ...s, gone: s.gone.filter(g => g.until > now) }));
    }, Math.max(0, next - Date.now()));
    return () => window.clearTimeout(t);
  }, [gone]);

  const out: Presence<T>[] = items.map(item => ({ item, leaving: false }));
  for (const g of [...gone].sort((a, b) => a.index - b.index)) out.splice(Math.min(g.index, out.length), 0, { item: g.item, leaving: true });
  return out;
}

/** A CSS easing token from :root (resolved, so browsers without `linear()` get the fallback curve). */
function cssEasing(name: string, fallback: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

const GLIDE_MS = 450;

type Size = { h: number; w: number };

/** An element's border-box size from its observer entry (no layout read), or from offset sizes where entries lack it. */
function entrySize(e: ResizeObserverEntry): Size {
  const b = e.borderBoxSize?.[0];
  if (b) return { h: b.blockSize, w: b.inlineSize };
  const t = e.target as HTMLElement;
  return { h: t.offsetHeight, w: t.offsetWidth };
}

/**
 * Layout glide for a column of sections: when a section's height changes (or a section appears), its
 * height animates from the old value to the new one with the critically damped layout curve, so the
 * sections below slide instead of jumping and nothing overlaps on the way. A change that comes with a new
 * width (the panel was resized, so text reflowed) is not animated. Sizes come from the ResizeObserver
 * entries, so the observer callback forces no layout.
 */
export function useGlide(box: RefObject<HTMLElement>): void {
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    const el = box.current;
    if (!el || reduced || typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return;
    const easing = cssEasing('--layout-glide', 'cubic-bezier(.32,.72,0,1)');
    const sizes = new Map<Element, Size>();
    const busy = new Set<Element>();
    /** Sections just added: their first observed size glides in from 0. */
    const added = new Set<Element>();
    const glide = (c: HTMLElement, from: number, to: number, fade = false) => {
      if (typeof c.animate !== 'function') return;
      busy.add(c);
      const a = c.animate(
        // flexShrink 0: in a scrolling flex column an overflow:hidden item would otherwise be squeezed.
        [{ height: `${from}px`, overflow: 'hidden', flexShrink: 0, ...(fade ? { opacity: 0 } : {}) }, { height: `${to}px`, overflow: 'hidden', flexShrink: 0 }],
        { duration: GLIDE_MS, easing },
      );
      // The animation has ended, so layout is settled: this read forces nothing.
      const done = () => { busy.delete(c); sizes.set(c, { h: c.offsetHeight, w: c.offsetWidth }); };
      a.onfinish = done;
      a.oncancel = done;
    };
    const ro = new ResizeObserver(entries => {
      // Off-screen-sized jumps are not worth animating.
      let limit = -1;
      for (const e of entries) {
        const c = e.target as HTMLElement;
        if (busy.has(c) || !c.isConnected) continue;
        const now = entrySize(e);
        const was = sizes.get(c);
        sizes.set(c, now);
        if (limit < 0) limit = el.clientHeight;
        if (added.delete(c)) {
          if (now.h > 0 && now.h < limit) glide(c, 0, now.h, true);
          continue;
        }
        // Tiny changes are rounding; a width change is a resize, not new content.
        if (!was || Math.abs(now.w - was.w) >= 1 || Math.abs(now.h - was.h) < 1 || Math.abs(now.h - was.h) >= limit * 1.5) continue;
        glide(c, was.h, now.h);
      }
    });
    for (const c of el.children) ro.observe(c);
    const mo = new MutationObserver(records => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || n.parentElement !== el) continue;
          added.add(n);
          ro.observe(n);
        }
        for (const n of r.removedNodes) { sizes.delete(n as Element); added.delete(n as Element); ro.unobserve(n as Element); }
      }
    });
    mo.observe(el, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [box, reduced]);
}
