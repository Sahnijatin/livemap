import type { ElkNode } from 'elkjs/lib/elk-api.js';
import { createElkWorker } from './elkWorker';

/** Shared ELK plumbing: the layout worker, its start cache and failure handling, and the layout timeout. */

export type Pos = { x: number; y: number };
/** Runs one ELK layout. Tests pass real elkjs in-process; the app passes the worker (`workerRun`). */
export type ElkRun = (graph: ElkNode) => Promise<ElkNode>;

/** A layout that has not settled by now is treated as failed (the caller falls back to a grid). */
export const LAYOUT_TIMEOUT = 10_000;

/** `p`, or a rejection after `ms`; `onTimeout` runs first so a stuck worker can be dropped. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout?.(); reject(new Error(`layout timed out after ${ms} ms`)); }, ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

type ElkApi = { layout(g: ElkNode): Promise<ElkNode>; terminateWorker(): void };
type WorkerHandle = { elk: ElkApi; pending: Set<(e: unknown) => void>; fail: (e: unknown) => void };
let worker: WorkerHandle | null = null;
/** The worker being started or running; cached so concurrent first layouts share one start. Cleared on failure. */
let workerP: Promise<WorkerHandle> | null = null;

/** Start the ELK worker. A load error, crash or unreadable message rejects every call in flight and drops it. */
async function startWorker(): Promise<WorkerHandle> {
  const { default: ELK } = await import('elkjs/lib/elk-api.js');
  const pending = new Set<(e: unknown) => void>();
  let raw: Worker | null = null;
  const elk = new ELK({
    workerFactory: () => {
      raw = createElkWorker();
      raw.addEventListener('error', e => { e.preventDefault?.(); handle.fail(new Error('layout worker failed')); });
      raw.addEventListener('messageerror', () => handle.fail(new Error('layout worker sent an unreadable message')));
      return raw;
    },
  }) as unknown as ElkApi;
  const handle: WorkerHandle = {
    elk,
    pending,
    fail(e: unknown) {
      if (worker === handle) { worker = null; workerP = null; }
      for (const reject of pending) reject(e);
      pending.clear();
      try { elk.terminateWorker(); } catch { raw?.terminate(); }
    },
  };
  return handle;
}

/** ELK in a module worker, created on first use and kept for the session (and recreated after a failure). */
export const workerRun: ElkRun = async graph => {
  const w = await (workerP ??= startWorker().then(
    h => (worker = h),
    e => { workerP = null; throw e; },
  ));
  let rejectCall: (e: unknown) => void = () => {};
  const call = new Promise<ElkNode>((resolve, reject) => {
    rejectCall = reject;
    w.pending.add(reject);
    w.elk.layout(graph).then(resolve, reject);
  });
  try {
    // A worker that never answers is stuck: drop it so the next layout starts a fresh one.
    return await withTimeout(call, LAYOUT_TIMEOUT, () => w.fail(new Error('layout worker timed out')));
  } finally {
    w.pending.delete(rejectCall);
  }
};
