import { describe, it, expect } from 'vitest';
import { FollowCamera, MoveGesture, type CameraView } from './camera';

/** A 1000 x 600 viewport at zoom 1 showing flow x 0..1000, y 0..600 (middle 60%: x 200..800, y 120..480). */
const make = (opts: { reduced?: boolean; view?: Partial<CameraView> } = {}) => {
  const view: CameraView = { x: 0, y: 0, zoom: 1, width: 1000, height: 600, ...opts.view };
  return new FollowCamera({ reduced: () => !!opts.reduced, view: () => view });
};
const far = (x: number) => ({ x, y: 2000, w: 232, h: 64 });

describe('FollowCamera', () => {
  it('a first request returns a move centered on the target at the current zoom', () => {
    const cam = make();
    expect(cam.request({ x: 2000, y: 1000, w: 200, h: 100 }, 0)).toEqual({ x: 2100, y: 1050, zoom: 1, duration: 600 });
  });

  it('keeps the current zoom, clamped to 0.6..1.2', () => {
    expect(make({ view: { zoom: 0.3 } }).request(far(5000), 0)!.zoom).toBe(0.6);
    expect(make({ view: { zoom: 1.8 } }).request(far(5000), 0)!.zoom).toBe(1.2);
    expect(make({ view: { zoom: 0.9 } }).request(far(5000), 0)!.zoom).toBe(0.9);
  });

  it('coalesces requests while a 600 ms move runs; the held one flushes when it ends (R8)', () => {
    const cam = make();
    expect(cam.request(far(3000), 0)).not.toBeNull();
    expect(cam.request(far(4000), 100)).toBeNull();
    expect(cam.request(far(5000), 450)).toBeNull();
    // Never cut off a running move: the effective interval is max(400, 600).
    expect(cam.due()).toBe(600);
    expect(cam.tick(400)).toBeNull();
    expect(cam.tick(599)).toBeNull();
    expect(cam.tick(600)).toEqual({ x: 5116, y: 2032, zoom: 1, duration: 600 });
    // Flushed: nothing more pending.
    expect(cam.due()).toBeNull();
    expect(cam.tick(900)).toBeNull();
  });

  it('under reduced motion (instant moves) the interval stays 400 ms', () => {
    const cam = make({ reduced: true });
    expect(cam.request(far(3000), 0)).not.toBeNull();
    expect(cam.request(far(4000), 100)).toBeNull();
    expect(cam.due()).toBe(400);
    expect(cam.tick(400)).not.toBeNull();
  });

  it('a programmatic move counts toward the interval', () => {
    const cam = make();
    cam.moved(0);
    expect(cam.request(far(3000), 100)).toBeNull();
    expect(cam.tick(600)).not.toBeNull();
  });

  it('a programmatic move with a duration holds Follow until it ends', () => {
    const cam = make();
    cam.moved(1000, 450);
    expect(cam.request(far(3000), 1200)).toBeNull();
    expect(cam.due()).toBe(1600);
  });

  it('while a programmatic move is pending, requests are ignored (F3)', () => {
    const cam = make();
    cam.hold(0);
    expect(cam.request(far(3000), 0)).toBeNull();
    expect(cam.due()).toBeNull();
    cam.release();
    expect(cam.request(far(3000), 10)).not.toBeNull();
  });

  it('a hold ends with the programmatic move (which then holds Follow until it finishes), or by itself after 3 s', () => {
    const cam = make();
    cam.hold(0);
    cam.moved(100, 450);
    expect(cam.request(far(3000), 200)).toBeNull();
    expect(cam.due()).toBe(700);
    expect(cam.tick(700)).not.toBeNull();
    const lone = make();
    lone.hold(0);
    expect(lone.request(far(3000), 2999)).toBeNull();
    expect(lone.request(far(3000), 3000)).not.toBeNull();
  });

  it('ignores requests for 8 s after the user moves the camera, then resumes', () => {
    const cam = make();
    cam.userMoved(1000);
    expect(cam.paused(1000)).toBe(true);
    expect(cam.resumeAt()).toBe(9000);
    expect(cam.request(far(3000), 1000)).toBeNull();
    expect(cam.request(far(3000), 8999)).toBeNull();
    expect(cam.tick(8999)).toBeNull();
    expect(cam.paused(9000)).toBe(false);
    expect(cam.request(far(3000), 9000)).not.toBeNull();
  });

  it('a user move drops a pending request', () => {
    const cam = make();
    cam.request(far(3000), 0);
    cam.request(far(4000), 100);
    cam.userMoved(200);
    expect(cam.due()).toBeNull();
    expect(cam.tick(400)).toBeNull();
  });

  it('a target already in the middle 60% of the viewport returns null', () => {
    const cam = make();
    expect(cam.request({ x: 400, y: 250, w: 232, h: 64 }, 0)).toBeNull();
    // Just outside the middle band: moves.
    expect(cam.request({ x: 700, y: 250, w: 232, h: 64 }, 0)).not.toBeNull();
  });

  it('accounts for pan and zoom when deciding what is in view', () => {
    // Zoom 0.5, panned so flow (1000, 1000) is at the screen center.
    const cam = make({ view: { zoom: 0.5, x: 0, y: 0 } });
    expect(cam.request({ x: 900, y: 500, w: 200, h: 100 }, 0)).toBeNull();
    const moved = make({ view: { zoom: 0.5, x: -500, y: -200 } });
    expect(moved.request({ x: 900, y: 500, w: 200, h: 100 }, 0)).not.toBeNull();
  });

  it('a target larger than the middle band counts as in view when its center is', () => {
    const cam = make();
    expect(cam.request({ x: 100, y: 0, w: 800, h: 600 }, 0)).toBeNull();
  });

  it('reduced motion gives duration 0', () => {
    expect(make({ reduced: true }).request(far(3000), 0)!.duration).toBe(0);
  });

  it('disabled returns null, and drops a pending request', () => {
    const cam = make();
    cam.request(far(3000), 0);
    cam.request(far(4000), 100);
    cam.setEnabled(false);
    expect(cam.request(far(5000), 1000)).toBeNull();
    expect(cam.tick(1000)).toBeNull();
    cam.setEnabled(true);
    expect(cam.request(far(5000), 1000)).not.toBeNull();
  });

  it('turning Follow back on clears a user pause', () => {
    const cam = make();
    cam.userMoved(0);
    cam.setEnabled(false);
    cam.setEnabled(true);
    expect(cam.paused(1)).toBe(false);
    expect(cam.request(far(3000), 1)).not.toBeNull();
  });

  it('a null target or an unsized viewport returns null', () => {
    expect(make().request(null, 0)).toBeNull();
    expect(make({ view: { width: 0 } }).request(far(3000), 0)).toBeNull();
  });
});

describe('MoveGesture (F2: a press that does not move the camera is not a user move)', () => {
  const v = (x: number, y = 0, zoom = 1) => ({ x, y, zoom });

  it('a press and release without movement is not a user move', () => {
    const g = new MoveGesture();
    g.begin(true, v(10));
    expect(g.step(true, v(10))).toBe(false);
    expect(g.end(true, v(10))).toBe(false);
  });

  it('a drag reports the first real change once, and the end again', () => {
    const g = new MoveGesture();
    g.begin(true, v(10));
    expect(g.step(true, v(12))).toBe(true);
    expect(g.step(true, v(30))).toBe(false);
    expect(g.end(true, v(30))).toBe(true);
    // A new gesture starts fresh.
    g.begin(true, v(30));
    expect(g.end(true, v(30))).toBe(false);
  });

  it('a zoom change counts; programmatic moves (no event) never do', () => {
    const g = new MoveGesture();
    g.begin(true, v(0));
    expect(g.end(true, v(0, 0, 1.1))).toBe(true);
    g.begin(false, v(0));
    expect(g.step(false, v(50))).toBe(false);
    expect(g.end(false, v(50))).toBe(false);
  });
});
