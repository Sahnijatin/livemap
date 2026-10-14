import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import { useStore } from '../store';
import type { MapGraph } from './mapModel';
import { FollowCamera, type CameraMove } from './camera';
import { prefersReducedMotion, type Box, type LinkFlowEdge, type MapFlowNode } from './mapFlow';

/** The live file's box, or at the folders level its folder's box. */
function targetBox(g: MapGraph, boxes: Map<string, Box> | null, target: string | null): Box | null {
  if (!target || !boxes) return null;
  const b = boxes.get(target);
  if (b) return b;
  if (g.level !== 'folders') return null;
  const f = g.folders.find(x => x.files.includes(target));
  return (f && boxes.get(f.id)) ?? null;
}

/**
 * Follow: while on, the camera eases to the file the agent is writing (also when that file's box first
 * appears or moves, e.g. in a folder added after the first fit). In a large project the target's
 * collapsed folder opens. A user pan or zoom pauses Follow for 8 s. Timers run only while a move is
 * held or a pause is counting down.
 */
export function useFollowCamera(graph: MapGraph, boxes: Map<string, Box> | null, target: string | null, initiallyHeld = false) {
  const rf = useReactFlow<MapFlowNode, LinkFlowEdge>();
  const storeApi = useStoreApi<MapFlowNode, LinkFlowEdge>();
  const follow = useStore(s => s.follow);
  const [paused, setPaused] = useState(false);

  const cam = useRef<FollowCamera | null>(null);
  cam.current ??= new FollowCamera({
    reduced: prefersReducedMotion,
    view: () => {
      const { width, height, transform } = storeApi.getState();
      return { x: transform[0], y: transform[1], zoom: transform[2], width, height };
    },
  });
  // A first overview is on its way: Follow waits for it rather than moving first.
  const initHold = useRef(initiallyHeld);
  if (initHold.current) { initHold.current = false; cam.current.hold(Date.now()); }

  const box = useMemo(() => targetBox(graph, boxes, target), [graph, boxes, target]);
  const boxRef = useRef(box);
  boxRef.current = box;

  const flushTimer = useRef<number | undefined>(undefined);
  const resumeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { window.clearTimeout(flushTimer.current); window.clearTimeout(resumeTimer.current); }, []);

  const apply = useCallback((m: CameraMove | null) => {
    if (m) void rf.setCenter(m.x, m.y, { zoom: m.zoom, duration: m.duration });
  }, [rf]);

  /** Wake for a held request once it is due. */
  const schedule = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    const due = cam.current!.due();
    if (due === null) return;
    flushTimer.current = window.setTimeout(() => {
      apply(cam.current!.tick(Date.now()));
      schedule();
    }, Math.max(0, due - Date.now()));
  }, [apply]);

  const request = useCallback((b: Box | null) => {
    apply(cam.current!.request(b, Date.now()));
    schedule();
  }, [apply, schedule]);

  // Turning Follow off, or back on (which clears a user pause), ends any "Paused" countdown.
  useEffect(() => {
    cam.current!.setEnabled(follow);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = undefined;
    setPaused(false);
  }, [follow]);

  // Ask again whenever the target, its box or the toggle changes; the camera skips what is already in view.
  useEffect(() => {
    if (follow) request(box);
  }, [follow, box?.x, box?.y, box?.w, box?.h, target, request]); // eslint-disable-line react-hooks/exhaustive-deps

  // A large project shows only opened folders: open the one the agent is writing in (once per target, so a user collapse sticks).
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!follow || !target || !graph.large || graph.level === 'folders' || opened.current === target) return;
    if (graph.files.some(f => f.id === target)) return;
    const folder = graph.folders.find(f => f.files.includes(target));
    if (!folder) return;
    opened.current = target;
    useStore.getState().expandMapFolder(folder.id);
  }, [follow, target, graph]);

  /** The user panned or zoomed: pause, then resume (and catch up with the target) after the quiet period. */
  const userMoved = useCallback(() => {
    const c = cam.current!;
    c.userMoved(Date.now());
    setPaused(true);
    window.clearTimeout(flushTimer.current);
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = undefined;
      setPaused(false);
      request(boxRef.current);
    }, Math.max(0, c.resumeAt() - Date.now()));
  }, [request]);

  /** An overview is about to run (first show, level switch, reset): Follow holds off until `moved` or `release`. */
  const hold = useCallback(() => {
    window.clearTimeout(flushTimer.current);
    cam.current!.hold(Date.now());
  }, []);

  /** The held overview did not run after all. */
  const release = useCallback(() => {
    cam.current!.release();
  }, []);

  /** The overview camera started (lasting `duration` ms): Follow waits for it to end, then catches up. */
  const moved = useCallback((duration = 0) => {
    cam.current!.moved(Date.now(), duration);
    request(boxRef.current);
  }, [request]);

  return { paused: follow && paused, userMoved, moved, hold, release };
}
