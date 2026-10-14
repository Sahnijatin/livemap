import { EventEmitter } from 'node:events';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { ChangeSummary, FileModel } from '../shared/types.js';
import type { ProjectModel, UpdateResult } from './project.js';
import { buildChange } from './differ.js';
import { isTempName, parentDir } from './files.js';

type FileEvent = 'add' | 'change' | 'unlink';

export interface WatcherOptions {
  debounceMs?: number;
  /** Longest a deferred import re-resolution waits while jobs keep arriving (default 1000 ms). */
  maxDeferMs?: number;
}

/**
 * Turns filesystem events into ChangeSummaries. Events are debounced per path,
 * then processed one at a time; the model decides what happened from disk.
 * Emits 'change' (change: ChangeSummary, touched: FileModel[]); 'touched' (files: FileModel[],
 * removed: string[]) for model updates without a change of their own (imports re-resolved after a
 * burst, files re-indexed after an ignore-rule change); and 'error' (err: Error).
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
  /** .gitignore files changed since the last rules reload. */
  private gitignores = new Set<string>();
  /** Jobs whose debounce fired but that have not started running. */
  private waiting = 0;
  private nextId = 1;
  private stopped = false;
  /** chokidar finished its initial crawl. */
  private ready = false;

  constructor(model: ProjectModel, opts: WatcherOptions = {}) {
    super();
    this.model = model;
    this.debounceMs = opts.debounceMs ?? 150;
    this.maxDeferMs = opts.maxDeferMs ?? 1000;
  }

  start(): Promise<void> {
    this.stopped = false;
    this.ready = false;
    const fsw = watch(this.model.root, {
      // Initial adds are dropped in onFile until 'ready' (the scan covers them). Leaving chokidar's
      // own ignoreInitial off means a later fsw.add() (a directory a .gitignore edit un-ignored)
      // reports the files its crawl finds, so none created during that crawl are missed.
      ignoreInitial: false,
      awaitWriteFinish: false,
      ignored: (p: string, stats?: { isDirectory(): boolean }) => {
        const rel = this.rel(p);
        if (rel === null) return false;
        if (rel === '') return false;
        const isDir = stats?.isDirectory() ?? false;
        if (!isDir && isGitignore(rel)) return this.gitignoreSkipped(rel);
        return this.model.ignored(rel, isDir);
      },
    });
    this.fsw = fsw;
    for (const ev of ['add', 'change', 'unlink'] as const) fsw.on(ev, (p: string) => this.onFile(p, ev));
    fsw.on('unlinkDir', (p: string) => this.onDir(p));
    fsw.on('error', (e: unknown) => this.fail(e));
    return new Promise(resolve => fsw.once('ready', () => { this.ready = true; resolve(); }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.gitignores.clear(); // their debounced job was just cancelled
    this.deferSince = null;
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

  /**
   * A .gitignore is watched unless its directory is ignored, even when its own rules match it
   * (`*`, as tool caches write), so editing it can reload the rules.
   */
  private gitignoreSkipped(rel: string): boolean {
    const dir = parentDir(rel);
    return dir !== '' && this.model.ignored(dir, true);
  }

  private onFile(p: string, ev: FileEvent): void {
    if (!this.ready && ev === 'add') return; // chokidar's initial crawl
    const rel = this.rel(p);
    if (!rel || isTempName(rel)) return;
    if (isGitignore(rel)) {
      if (this.gitignoreSkipped(rel)) return;
      // One debounced reload for every .gitignore touched together (a checkout can change dozens).
      this.gitignores.add(rel);
      this.schedule('ignores', async () => {
        const paths = [...this.gitignores].sort();
        this.gitignores.clear();
        if (paths.length === 0) return []; // an earlier queued job already took this batch
        const { files, removed, created } = await this.model.reloadIgnores(paths, {
          // Directories that were ignored when chokidar crawled were never watched; watch them
          // before the reload reads them (files appearing meanwhile come back in `created`).
          onIncluded: dirs => this.watchIncluded(dirs),
        });
        // A throwing listener must not lose the .gitignore files' own changes below.
        if (!this.stopped && (files.length || removed.length)) {
          try { this.emit('touched', files, removed); } catch (e) { this.fail(e); }
        }
        const own: UpdateResult[] = [...created];
        for (const p of paths) {
          // Deferred: run() relinks once after the job, not once per created/deleted .gitignore.
          const r = await this.model.update(p, 'change', { deferRelink: true }); // null while its own rules ignore it
          if (r) own.push(r);
        }
        return own;
      });
      return;
    }
    if (this.model.ignored(rel)) return;
    this.schedule(`f:${rel}`, deferRelink => this.model.update(rel, ev, { deferRelink }).then(r => (r ? [r] : [])));
  }

  private onDir(p: string): void {
    const rel = this.rel(p);
    if (!rel || this.model.ignored(rel, true)) return;
    this.schedule(`d:${rel}`, deferRelink => this.model.removeDir(rel, { deferRelink }));
  }

  /** Watches directories a reload newly includes (they were ignored when chokidar crawled). */
  private watchIncluded(dirs: string[]): void {
    if (dirs.length) this.fsw?.add(dirs.map(d => path.join(this.model.root, ...d.split('/'))));
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
    if (more || this.stopped || !this.model.relinkDeferred) return;
    try {
      const touched = await this.model.flushRelink();
      if (!this.stopped && touched.length) this.emit('touched', touched, []);
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

function isGitignore(rel: string): boolean {
  return rel === '.gitignore' || rel.endsWith('/.gitignore');
}

function mergeTouched(results: UpdateResult[]): FileModel[] {
  const byPath = new Map<string, FileModel>();
  for (const r of results) for (const f of r.touched) byPath.set(f.path, f);
  return [...byPath.values()];
}
