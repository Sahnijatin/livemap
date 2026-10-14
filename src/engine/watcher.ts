import { EventEmitter } from 'node:events';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { ChangeSummary, FileModel } from '../shared/types.js';
import type { ProjectModel, UpdateResult } from './project.js';
import { buildChange } from './differ.js';
import { isTempName } from './files.js';

type FileEvent = 'add' | 'change' | 'unlink';

export interface WatcherOptions {
  debounceMs?: number;
  /** Longest a deferred import re-resolution waits while jobs keep arriving (default 1000 ms). */
  maxDeferMs?: number;
}

/**
 * Turns filesystem events into ChangeSummaries. Events are debounced per path,
 * then processed one at a time; the model decides what happened from disk.
 * Emits 'change' (change: ChangeSummary, touched: FileModel[]), 'touched' (files: FileModel[]) for
 * import changes found after a burst, and 'error' (err: Error).
 *
 * While more jobs are queued, file-set changes defer the model's import re-resolution (O(files)),
 * so a burst (a checkout adding hundreds of files) re-resolves once when the queue drains.
 */
export class Watcher extends EventEmitter {
  private readonly model: ProjectModel;
  private readonly debounceMs: number;
  private readonly maxDeferMs: number;
  /** When the current run of deferred jobs began; null when nothing is deferred. */
  private deferSince: number | null = null;
  private fsw: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private queue: Promise<void> = Promise.resolve();
  /** Jobs whose debounce fired but that have not started running. */
  private waiting = 0;
  private nextId = 1;
  private stopped = false;

  constructor(model: ProjectModel, opts: WatcherOptions = {}) {
    super();
    this.model = model;
    this.debounceMs = opts.debounceMs ?? 150;
    this.maxDeferMs = opts.maxDeferMs ?? 1000;
  }

  start(): Promise<void> {
    this.stopped = false;
    const fsw = watch(this.model.root, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      ignored: (p: string, stats?: { isDirectory(): boolean }) => {
        const rel = this.rel(p);
        if (rel === null) return false;
        if (rel === '') return false;
        return this.model.ignored(rel, stats?.isDirectory() ?? false);
      },
    });
    this.fsw = fsw;
    for (const ev of ['add', 'change', 'unlink'] as const) fsw.on(ev, (p: string) => this.onFile(p, ev));
    fsw.on('unlinkDir', (p: string) => this.onDir(p));
    fsw.on('error', (e: unknown) => this.fail(e));
    return new Promise(resolve => fsw.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const fsw = this.fsw;
    this.fsw = null;
    if (fsw) await fsw.close();
    await this.queue; // let an in-flight job settle; its results are dropped because stopped is set
  }

  /** POSIX path relative to root; null when outside root. */
  private rel(p: string): string | null {
    const r = path.relative(this.model.root, p);
    if (r.startsWith('..') || path.isAbsolute(r)) return null;
    return r.split(path.sep).join('/');
  }

  private onFile(p: string, ev: FileEvent): void {
    const rel = this.rel(p);
    if (!rel || isTempName(rel) || this.model.ignored(rel)) return;
    this.schedule(`f:${rel}`, deferRelink => this.model.update(rel, ev, { deferRelink }).then(r => (r ? [r] : [])));
  }

  private onDir(p: string): void {
    const rel = this.rel(p);
    if (!rel || this.model.ignored(rel, true)) return;
    this.schedule(`d:${rel}`, () => this.model.removeDir(rel));
  }

  private schedule(key: string, job: (deferRelink: boolean) => Promise<UpdateResult[]>): void {
    if (this.stopped) return;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.waiting++;
      // catch: a throwing 'error'/'change' listener must not poison the queue for later jobs.
      this.queue = this.queue.then(() => this.run(job)).catch(() => {});
    }, this.debounceMs));
  }

  private async run(job: (deferRelink: boolean) => Promise<UpdateResult[]>): Promise<void> {
    this.waiting--;
    if (this.stopped) return;
    // Defer while jobs are waiting, but not past maxDeferMs, so steady churn still relinks.
    const now = Date.now();
    this.deferSince ??= now;
    const more = this.waiting > 0 && now - this.deferSince < this.maxDeferMs;
    if (!more) this.deferSince = null;
    try {
      this.report(await job(more));
    } catch (e) {
      this.fail(e);
    }
    if (more || this.stopped) return;
    try {
      const touched = await this.model.flushRelink();
      if (!this.stopped && touched.length) this.emit('touched', touched);
    } catch (e) {
      this.fail(e);
    }
  }

  private report(results: UpdateResult[]): void {
    if (this.stopped || results.length === 0) return;
    const touched = mergeTouched(results);
    results.forEach((u, i) => {
      try {
        const change: ChangeSummary = buildChange(u, this.nextId++);
        this.emit('change', change, i === results.length - 1 ? touched : []);
      } catch (e) {
        this.fail(e);
      }
    });
  }

  private fail(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}

function mergeTouched(results: UpdateResult[]): FileModel[] {
  const byPath = new Map<string, FileModel>();
  for (const r of results) for (const f of r.touched) byPath.set(f.path, f);
  return [...byPath.values()];
}
