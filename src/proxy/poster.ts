/**
 * Fire-and-forget delivery of capture events to running LiveMaps. It never blocks the caller and never
 * throws: events wait in a bounded queue (the oldest is dropped when full), each post has a short timeout,
 * and with no LiveMap running the event is dropped.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { runtimeDir, type RuntimeEntry } from '../agents/runtime.js';

export const QUEUE_MAX = 100;
export const POST_TIMEOUT_MS = 500;
/** Run files are re-read at most this often. */
const RUNS_TTL_MS = 2000;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Every live LiveMap's run entry in `dir` (default `~/.livemap/run`). Unreadable or stale files are skipped. */
export function liveRuntimes(dir: string = runtimeDir()): RuntimeEntry[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: RuntimeEntry[] = [];
  for (const n of names) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Record<string, unknown>;
      if (typeof e.root !== 'string' || typeof e.token !== 'string' || !Number.isInteger(e.port) || !Number.isInteger(e.pid)) continue;
      if ((e.pid as number) <= 0 || !pidAlive(e.pid as number)) continue;
      out.push({ root: e.root, port: e.port as number, token: e.token, pid: e.pid as number });
    } catch { /* being written, or not ours */ }
  }
  return out;
}

/** A LiveMap that serves a ServiceNow mirror (`livemap sn` runs on `<project>/.livemap/sn`). */
export const isServiceNowRun = (e: RuntimeEntry): boolean => /[\\/]\.livemap[\\/]sn$/.test(e.root);

export interface PosterOptions {
  /** Which runs get events (default: ServiceNow mirror runs). */
  accept?: (e: RuntimeEntry) => boolean;
  runtimes?: () => RuntimeEntry[];
  timeoutMs?: number;
  queueMax?: number;
}

export class HookPoster {
  private readonly queue: string[] = [];
  private busy = false;
  private runs: RuntimeEntry[] = [];
  private runsAt = -Infinity;
  private readonly accept: (e: RuntimeEntry) => boolean;
  private readonly runtimes: () => RuntimeEntry[];
  private readonly timeoutMs: number;
  private readonly queueMax: number;
  private idle: Array<() => void> = [];
  /** Events dropped because the queue was full. */
  dropped = 0;
  /** Posts that LiveMap answered 200. */
  delivered = 0;

  constructor(opts: PosterOptions = {}) {
    this.accept = opts.accept ?? isServiceNowRun;
    this.runtimes = opts.runtimes ?? (() => liveRuntimes());
    this.timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
    this.queueMax = opts.queueMax ?? QUEUE_MAX;
  }

  /** Queues one event and returns at once. */
  send(event: unknown): void {
    try {
      const body = JSON.stringify(event);
      this.queue.push(body);
      while (this.queue.length > this.queueMax) { this.queue.shift(); this.dropped++; }
      if (!this.busy) void this.drain();
    } catch { /* an event that does not serialize is dropped */ }
  }

  /** Resolves when the queue is empty and nothing is in flight (tests and shutdown). */
  flushed(): Promise<void> {
    if (!this.busy && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private targets(): RuntimeEntry[] {
    const now = Date.now();
    if (now - this.runsAt > RUNS_TTL_MS) {
      try { this.runs = this.runtimes().filter(this.accept); } catch { this.runs = []; }
      this.runsAt = now;
    }
    return this.runs;
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (this.queue.length) {
        const body = this.queue.shift() as string;
        const runs = this.targets();
        await Promise.all(runs.map((r) => this.post(r, body)));
      }
    } finally {
      this.busy = false;
      for (const f of this.idle.splice(0)) f();
    }
  }

  private post(r: RuntimeEntry, body: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(); };
      const req = http.request({
        host: '127.0.0.1', port: r.port, path: '/hook', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-livemap-token': r.token },
      }, (res) => {
        if (res.statusCode === 200) this.delivered++;
        res.resume();
        res.on('end', finish);
        res.on('error', finish);
      });
      const timer = setTimeout(finish, this.timeoutMs);
      timer.unref?.();
      req.on('error', finish);
      req.end(body);
    });
  }
}
