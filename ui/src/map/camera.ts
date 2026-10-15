import type { Box } from './mapFlow';

/** The React Flow viewport (screen = flow * zoom + x) and the canvas size in pixels. */
export interface CameraView { x: number; y: number; zoom: number; width: number; height: number }
/** Where to center (flow coordinates), at which zoom, over how long. */
export interface CameraMove { x: number; y: number; zoom: number; duration: number }

export const FOLLOW_MIN_ZOOM = 0.6;
export const FOLLOW_MAX_ZOOM = 1.2;
/** Follow eases to the live file over this long (instant under reduced motion). */
export const FOLLOW_MS = 600;
/** A target inside the middle 60% of the viewport is already in view: no move. */
const BAND = 0.6;

/** True when `b` sits inside the middle band of the view (or, for a box bigger than the band, its center does). */
export function inMiddle(b: Box, v: CameraView): boolean {
  const mx = (v.width * (1 - BAND)) / 2, my = (v.height * (1 - BAND)) / 2;
  const sx = b.x * v.zoom + v.x, sy = b.y * v.zoom + v.y;
  const sw = b.w * v.zoom, sh = b.h * v.zoom;
  const inX = sw > v.width * BAND ? sx + sw / 2 >= mx && sx + sw / 2 <= v.width - mx : sx >= mx && sx + sw <= v.width - mx;
  const inY = sh > v.height * BAND ? sy + sh / 2 >= my && sy + sh / 2 <= v.height - my : sy >= my && sy + sh <= v.height - my;
  return inX && inY;
}

/** A hold for a pending programmatic move ends by itself after this long, in case that move never runs. */
export const HOLD_MAX_MS = 3000;

/**
 * Decides when the Follow camera moves, without touching React Flow (times are passed in).
 * At most one move per interval (the latest request wins and is flushed by `tick`). The interval is
 * `minIntervalMs`, but never shorter than a move's duration, so a move is never cut off by the next one.
 * Nothing for `userPauseMs` after the user pans or zooms, nothing while another camera move is pending
 * (`hold`), and nothing when the target is already well in view.
 */
export class FollowCamera {
  private readonly minIntervalMs: number;
  private readonly userPauseMs: number;
  private readonly reduced: () => boolean;
  private readonly view: () => CameraView | null;
  private enabled = true;
  /** No Follow move before this (the last move plus its interval). */
  private readyAt = -Infinity;
  private pausedUntil = -Infinity;
  private heldUntil = -Infinity;
  private pending: Box | null = null;

  constructor(opts: { minIntervalMs?: number; userPauseMs?: number; reduced: () => boolean; view: () => CameraView | null }) {
    this.minIntervalMs = opts.minIntervalMs ?? 400;
    this.userPauseMs = opts.userPauseMs ?? 8000;
    this.reduced = opts.reduced;
    this.view = opts.view;
  }

  /** Ask to bring `target` into view. Returns a move to make now, or null (none needed, paused, or held for `tick`). */
  request(target: Box | null, now: number): CameraMove | null {
    if (!this.enabled || !target || this.paused(now) || now < this.heldUntil) {
      this.pending = null;
      return null;
    }
    if (now < this.readyAt) {
      this.pending = target;
      return null;
    }
    this.pending = null;
    return this.move(target, now);
  }

  /** Flush a held request once the interval has passed. */
  tick(now: number): CameraMove | null {
    const p = this.pending;
    if (!p || now < this.readyAt) return null;
    this.pending = null;
    if (!this.enabled || this.paused(now) || now < this.heldUntil) return null;
    return this.move(p, now);
  }

  /** When a held request is due, or null when nothing is held. */
  due(): number | null {
    return this.pending ? this.readyAt : null;
  }

  /** The user panned or zoomed: hold off, and forget what was waiting. */
  userMoved(now: number): void {
    this.pausedUntil = now + this.userPauseMs;
    this.pending = null;
  }

  /** Another camera move (fit, overview, focus) just started, lasting `duration` ms: Follow waits until it ends. */
  moved(now: number, duration = 0): void {
    this.heldUntil = -Infinity;
    this.readyAt = Math.max(this.readyAt, now + Math.max(this.interval(), duration));
  }

  /** Another camera move is about to run (an overview waiting for its layout): drop requests until `moved` or `release`. */
  hold(now: number): void {
    this.heldUntil = now + HOLD_MAX_MS;
    this.pending = null;
  }

  release(): void {
    this.heldUntil = -Infinity;
  }

  paused(now: number): boolean {
    return now < this.pausedUntil;
  }

  /** When a user pause ends (in the past when not paused). */
  resumeAt(): number {
    return this.pausedUntil;
  }

  setEnabled(on: boolean): void {
    if (on && !this.enabled) this.pausedUntil = -Infinity;
    this.enabled = on;
    if (!on) this.pending = null;
  }

  private move(b: Box, now: number): CameraMove | null {
    const v = this.view();
    if (!v || v.width <= 0 || v.height <= 0 || inMiddle(b, v)) return null;
    this.readyAt = now + this.interval();
    return {
      x: b.x + b.w / 2,
      y: b.y + b.h / 2,
      zoom: Math.min(FOLLOW_MAX_ZOOM, Math.max(FOLLOW_MIN_ZOOM, v.zoom)),
      duration: this.reduced() ? 0 : FOLLOW_MS,
    };
  }

  /** Time between Follow moves: the minimum interval, or a whole move when moves animate (R8). */
  private interval(): number {
    return this.reduced() ? this.minIntervalMs : Math.max(this.minIntervalMs, FOLLOW_MS);
  }
}

type ViewXYZ = { x: number; y: number; zoom: number };
const sameView = (a: ViewXYZ, b: ViewXYZ): boolean => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

/**
 * Tells a real user pan or zoom from a press that leaves the camera where it was (d3-zoom starts a
 * gesture on every mousedown on the canvas, so a plain click would otherwise pause Follow).
 * `user` is whether the call came with an input event (programmatic moves come without one).
 */
export class MoveGesture {
  private start: ViewXYZ | null = null;
  private moved = false;

  begin(user: boolean, v: ViewXYZ): void {
    this.start = user ? { x: v.x, y: v.y, zoom: v.zoom } : null;
    this.moved = false;
  }

  /** True the first time, within a user gesture, that the camera actually moved. */
  step(user: boolean, v: ViewXYZ): boolean {
    if (!user || !this.start || this.moved || sameView(this.start, v)) return false;
    this.moved = true;
    return true;
  }

  /** True when the user gesture that ends here moved the camera. */
  end(user: boolean, v: ViewXYZ): boolean {
    const s = this.start;
    const moved = this.moved || (!!s && !sameView(s, v));
    this.start = null;
    this.moved = false;
    return user && !!s && moved;
  }
}
