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
/** A token LiveMap writes: header-safe printable ASCII. Anything else would make http.request throw. */
const TOKEN = /^[\x21-\x7e]{1,256}$/;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Every live LiveMap's run entry in `dir` (default `~/.livemap/run`). Unreadable, stale or malformed files are skipped. */
export function liveRuntimes(dir: string = runtimeDir()): RuntimeEntry[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: RuntimeEntry[] = [];
  for (const n of names) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Record<string, unknown>;
      if (typeof e.root !== 'string' || typeof e.token !== 'string' || !TOKEN.test(e.token)) continue;
      if (!Number.isInteger(e.port) || (e.port as number) < 1 || (e.port as number) > 65535) continue;
      if (!Number.isInteger(e.pid) || (e.pid as number) <= 0 || !pidAlive(e.pid as number)) continue;
      out.push({ root: e.root, port: e.port as number, token: e.token, pid: e.pid as number });
    } catch { /* being written, or not ours */ }
  }
  return out;
}

/** A LiveMap that serves a ServiceNow mirror (`livemap sn` runs on `<project>/.livemap/sn`). */
export const isServiceNowRun = (e: RuntimeEntry): boolean => /[\\/]\.livemap[\\/]sn$/.test(e.root);

/**
 * An instance name as one key: lowercased, without a scheme, path, port or the `.service-now.com` suffix,
 * so `DevTest`, `devtest.service-now.com` and `https://devtest.service-now.com/` agree.
 */
export function normalizeInstance(v: string): string {
  return v.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:].*$/, '').replace(/\.service-now\.com$/, '');
}

const manifestCache = new Map<string, { stamp: string; instances: string[] }>();

/**
 * The instances a `livemap sn` run mirrors, from the manifests in its root, normalized. Manifests are parsed
 * again only when one changes (by name and mtime). Empty when it cannot tell.
 */
export function runInstances(e: RuntimeEntry): string[] {
  try {
    const names = fs.readdirSync(e.root).filter((n) => n.endsWith('.manifest.json')).sort();
    const stamp = names.map((n) => { try { return `${n}:${fs.statSync(path.join(e.root, n)).mtimeMs}`; } catch { return n; } }).join('|');
    const hit = manifestCache.get(e.root);
    if (hit && hit.stamp === stamp) return hit.instances;
    const out = new Set<string>();
    for (const n of names) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(e.root, n), 'utf8')) as { instance?: unknown };
        if (typeof m.instance === 'string' && m.instance) out.add(normalizeInstance(m.instance));
      } catch { /* being rewritten: the next stamp differs */ }
    }
    const instances = [...out];
    manifestCache.set(e.root, { stamp, instances });
    return instances;
  } catch {
    return [];
  }
}

export interface PosterOptions {
  /** Which runs get events (default: ServiceNow mirror runs). */
  accept?: (e: RuntimeEntry) => boolean;
  runtimes?: () => RuntimeEntry[];
  /**
   * The instance the proxy serves: runs that mirror another instance get nothing. Unknown, or no run matches
   * it (an alias the manifests spell differently): every run.
   */
  instance?: string;
  /** The instances a run mirrors (default: read from its manifests). */
  instancesOf?: (e: RuntimeEntry) => string[];
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
  private readonly instance?: string;
  private readonly instancesOf: (e: RuntimeEntry) => string[];
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
    this.instance = opts.instance ? normalizeInstance(opts.instance) || undefined : undefined;
    this.instancesOf = opts.instancesOf ?? runInstances;
    this.timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
    this.queueMax = opts.queueMax ?? QUEUE_MAX;
  }

  /** Queues one event and returns at once. */
  send(event: unknown): void {
    try {
      const body = JSON.stringify(event);
      this.queue.push(body);
      while (this.queue.length > this.queueMax) { this.queue.shift(); this.dropped++; }
      if (!this.busy) this.drain().catch(() => { this.busy = false; });
    } catch { /* an event that does not serialize is dropped */ }
  }

  /** Resolves when the queue is empty and nothing is in flight (tests and shutdown). */
  flushed(): Promise<void> {
    if (!this.busy && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  /** The runs for this proxy's instance: those that mirror it or cannot tell; all of them when none matches. */
  private forInstance(runs: RuntimeEntry[]): RuntimeEntry[] {
    if (!this.instance) return runs;
    const mine = runs.filter((e) => {
      const theirs = this.instancesOf(e).map(normalizeInstance);
      return !theirs.length || theirs.includes(this.instance as string);
    });
    return mine.length ? mine : runs;
  }

  private targets(): RuntimeEntry[] {
    const now = Date.now();
    if (now - this.runsAt > RUNS_TTL_MS) {
      try { this.runs = this.forInstance(this.runtimes().filter((e) => this.accept(e))); } catch { this.runs = []; }
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
      let req: http.ClientRequest | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => { if (done) return; done = true; if (timer) clearTimeout(timer); try { req?.destroy(); } catch { /* gone */ } resolve(); };
      try {
        req = http.request({
          host: '127.0.0.1', port: r.port, path: '/hook', method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-livemap-token': r.token },
        }, (res) => {
          if (res.statusCode === 200) this.delivered++;
          res.resume();
          res.on('end', finish);
          res.on('error', finish);
        });
        timer = setTimeout(finish, this.timeoutMs);
        timer.unref?.();
        req.on('error', finish);
        req.end(body);
      } catch {
        // A bad port or token from a run file throws synchronously: skip that run.
        finish();
      }
    });
  }
}
