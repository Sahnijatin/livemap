import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeSymbol, FileModel, Mount } from '../shared/types.js';
import { langOf } from './languages.js';
import { fileSymbols } from './symbols/index.js';
import { scriptBlock } from './symbols/markup.js';
import { buildIndex, extractImports, indexUpdate, readTsconfigAliases, resolveSpecifier, type FileIndex, type ImportCtx } from './imports.js';
import { ANALYZERS, analyzeFile, type Analyzer } from './domain/index.js';
import { createIgnore, insideRoot, parentDir, walk, readForModel, type IgnoreFn, type ReadResult } from './files.js';

export interface UpdateResult {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  before: FileModel | null;
  after: FileModel | null;
  beforeText: string | null;
  afterText: string | null;
  /** Other files whose resolved local imports or mount targets changed because of this update. */
  touched: FileModel[];
}

const CONFIG_FILES = new Set(['tsconfig.json', 'jsconfig.json', 'go.mod']);
/** The directories in `dirs` that have no ancestor in `dirs` ('' covers everything). */
function topmost(dirs: string[]): string[] {
  const set = new Set(dirs);
  if (set.has('')) return [''];
  return [...set].filter(d => {
    for (let p = parentDir(d); p; p = parentDir(p)) if (set.has(p)) return false;
    return true;
  }).sort(cmp);
}

/** Files read (or stat-ed) concurrently during a scan or removeDir. */
const READ_AHEAD = 32;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameTargets = (a: Mount[], b: Mount[]): boolean => a.length === b.length && a.every((m, i) => m.target === b[i].target);

export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Live, in-memory structure of every indexed file in a project. */
export class ProjectModel {
  readonly root: string;
  readonly limit: number;
  truncated = false;
  private files = new Map<string, FileModel>();
  private texts = new Map<string, string>();
  /** Last clean-parse symbols per file; null until a file first parses cleanly. */
  private lastGood = new Map<string, CodeSymbol[] | null>();
  private isIgnored: IgnoreFn;
  private ctx: ImportCtx;
  private analyzers: Analyzer[];
  private queue: Promise<unknown> = Promise.resolve();
  /** Parsed JS/TS import specifiers per file (see ImportCtx.specCache). */
  private specCache: NonNullable<ImportCtx['specCache']> = new Map();
  /** The live ctx's directory index during a deferred burst (see liveCtx). */
  private liveIndex: FileIndex | null = null;
  /** A deferred update changed the file set; imports need re-resolving (see update). */
  private relinkPending = false;

  constructor(root: string, opts: { limit?: number; analyzers?: Analyzer[] } = {}) {
    this.root = root;
    this.limit = opts.limit ?? 25000;
    this.analyzers = opts.analyzers ?? ANALYZERS;
    this.isIgnored = createIgnore(root);
    this.ctx = this.makeCtx([]);
  }

  get(rel: string): FileModel | undefined { return this.files.get(rel); }
  /** Every file, sorted by path. */
  all(): FileModel[] { return [...this.files.values()].sort((a, b) => cmp(a.path, b.path)); }
  /** Stored text; null for secret, binary, tooLarge and unknown files. */
  content(rel: string): string | null { return this.texts.get(rel) ?? null; }
  ignored(rel: string, isDir = false): boolean { return this.isIgnored(rel, isDir); }

  scan(onProgress?: (done: number, total: number) => void): Promise<void> {
    return this.serial(async () => {
      this.files.clear(); this.texts.clear(); this.lastGood.clear(); this.specCache.clear();
      this.relinkPending = false;
      this.liveIndex = null;
      this.isIgnored = createIgnore(this.root); // everything from disk, the rules included
      const { files, truncated } = await walk(this.root, this.isIgnored, this.limit);
      this.truncated = truncated;
      // Config first so aliases and the Go module apply to every file; then the whole walked tree
      // is registered before parsing so imports see it.
      const walked = new Set(files);
      const configs = new Map<string, ReadResult>();
      for (const rel of CONFIG_FILES) {
        if (!walked.has(rel)) continue;
        const r = await this.read(rel);
        configs.set(rel, r);
        if (r?.kind === 'text') this.texts.set(rel, r.text);
      }
      this.ctx = this.makeCtx(files);
      // Reads run READ_AHEAD at a time while files are parsed in order, so progress moves from the start.
      let unreadable = false;
      let done = 0;
      await this.readEach(files, configs, async (rel, r) => {
        if (r) {
          if (r.kind === 'text') this.texts.set(rel, r.text); else this.texts.delete(rel);
          this.files.set(rel, await this.build(rel, r));
        } else {
          this.texts.delete(rel);
          unreadable = true;
        }
        onProgress?.(++done, files.length);
      });
      // A file that vanished or failed to read mid-scan must not stay resolvable as an import.
      if (unreadable) this.relink([]);
    });
  }

  /**
   * The event is advisory: the file is re-read and its on-disk state decides the result kind.
   * With `deferRelink`, a created/deleted file does not re-resolve every file's imports now; the
   * next non-deferred update, removeDir or flushRelink does it once for the whole burst.
   */
  update(rel: string, _event: 'add' | 'change' | 'unlink', opts: { deferRelink?: boolean } = {}): Promise<UpdateResult | null> {
    return this.serial(async () => {
      if (this.ignored(rel)) return null;
      const r = await this.read(rel);
      // readForModel returns null for any failure; a known file is deleted only if it is really gone.
      if (!r && this.files.has(rel) && !(await this.isGone(rel))) return null;
      if (r && !this.files.has(rel) && this.files.size >= this.limit) { this.truncated = true; return null; }
      const res = this.apply(rel, r);
      if (!res) return null;
      const { result, setChanged } = await res;
      if (setChanged || CONFIG_FILES.has(rel)) {
        // Config (aliases, Go module) changes resolution for every file, so it relinks at once.
        if (opts.deferRelink && !CONFIG_FILES.has(rel)) {
          this.deferRelink();
        } else {
          result.touched = this.relink([rel]);
          result.after = this.files.get(rel) ?? null;
        }
      }
      return result;
    });
  }

  /**
   * One `deleted` result per known file under relDir that is gone from disk. Imports are re-resolved once for the whole
   * directory, so the combined `touched` list is on the LAST result; consumers merge across the array.
   */
  removeDir(relDir: string, opts: { deferRelink?: boolean } = {}): Promise<UpdateResult[]> {
    return this.serial(async () => {
      const prefix = relDir.replace(/\/+$/, '') + '/';
      const under = [...this.files.keys()].filter(p => p.startsWith(prefix)).sort(cmp);
      // The directory may be back by now (deleted and recreated within the debounce, or a late
      // unlinkDir); files that exist again are left to their own add/change events.
      const gone: string[] = [];
      await this.eachAhead(under, rel => this.isGone(rel), (rel, isGone) => { if (isGone) gone.push(rel); });
      const results: UpdateResult[] = [];
      for (const rel of gone) results.push((await this.apply(rel, null))!.result);
      // One import re-resolution for the whole directory (or, deferred, for the whole burst);
      // touched goes on the last result.
      if (results.length && opts.deferRelink) this.deferRelink();
      else if (results.length) results[results.length - 1].touched = this.relink(gone);
      return results;
    });
  }

  /**
   * Re-reads the .gitignore files at `changed` (all of them when empty) and reconciles the model
   * with the new rules: files now ignored are dropped, files the old rules ignored are read, then
   * imports are re-resolved once. Nothing changed on disk for those, so they come back as a file
   * update (`files` upserted, `removed` paths) rather than change entries; files that are merely
   * new are left to their own add events. After a truncated scan, other unindexed files may fill
   * freed room (returned as `created` changes).
   *
   * `onIncluded` gets the topmost newly included directories (empty ones too) right after the
   * walk, before anything is read, so the watcher can start watching them.
   */
  reloadIgnores(
    changed: string[] = [],
    opts: { onIncluded?: (dirs: string[]) => void } = {},
  ): Promise<{ files: FileModel[]; removed: string[]; created: UpdateResult[] }> {
    // If this throws partway the model is left inconsistent; the caller rescans (see Watcher).
    return this.serial(() => this.reconcileIgnores(changed, opts));
  }

  private async reconcileIgnores(
    changed: string[],
    opts: { onIncluded?: (dirs: string[]) => void },
  ): Promise<{ files: FileModel[]; removed: string[]; created: UpdateResult[] }> {
    const old = this.isIgnored;
    const changedDirs = changed.map(parentDir);
    this.isIgnored = changed.length ? createIgnore(this.root, { previous: old, changed: changedDirs }) : createIgnore(this.root);
    // A nested .gitignore only affects its own subtree; the root one affects everything.
    const rootChanged = !changed.length || changedDirs.includes('');
    const subtrees = rootChanged ? [''] : topmost(changedDirs);
    const within = (rel: string): boolean => rootChanged || subtrees.some(d => rel.startsWith(`${d}/`));
    const removed: string[] = [];
    for (const rel of [...this.files.keys()].filter(within).sort(cmp)) {
      if (!this.isIgnored(rel, false)) continue;
      this.apply(rel, null);
      removed.push(rel);
    }
    // In a truncated model, room freed in a subtree may be filled from anywhere.
    const whole = rootChanged || (this.truncated && removed.length > 0);
    const roots = whole ? [''] : subtrees;
    const walked = await walk(this.root, this.isIgnored, this.limit, roots, { dirs: true });
    const dirs = topmost(walked.dirs.filter(d => old(d, true)));
    if (dirs.length) opts.onIncluded?.(dirs);
    // Files the old rules ignored come back as a file update. After a truncated scan, other
    // unindexed files may fill freed room; they may be brand new (with an add event queued that
    // will now find nothing to do), so they are reported as created changes.
    const wasTruncated = this.truncated;
    let full = false; // some file did not fit under the limit
    const included: string[] = [];
    const unreached: string[] = [];
    // Stop reading once the model is full (a truncated model may have thousands unread); files
    // that fail to read leave their room to later candidates.
    const fresh = walked.files.filter(rel => !this.files.has(rel) && (old(rel, false) || wasTruncated));
    const isFull = (): boolean => this.files.size >= this.limit;
    const done = await this.readEach(fresh, new Map(), async (rel, r) => {
      if (!r) return;
      const res = this.apply(rel, r);
      if (res) { await res; (old(rel, false) ? included : unreached).push(rel); }
    }, isFull);
    if (done < fresh.length) full = true;
    if (whole) this.truncated = walked.truncated || full;
    else if (full || walked.truncated) this.truncated = true;
    if (!removed.length && !included.length && !unreached.length) return { files: [], removed, created: [] };
    const touched = this.relink([]);
    const byPath = new Map<string, FileModel>();
    for (const rel of included) byPath.set(rel, this.files.get(rel)!);
    const isUnreached = new Set(unreached);
    for (const f of touched) if (!isUnreached.has(f.path)) byPath.set(f.path, f);
    const created: UpdateResult[] = unreached.map(rel => ({
      path: rel, kind: 'created', before: null, after: this.files.get(rel) ?? null, beforeText: null, afterText: this.texts.get(rel) ?? null, touched: [],
    }));
    return { files: [...byPath.values()].sort((x, y) => cmp(x.path, y.path)), removed, created };
  }

  /** Marks the file set changed; the rest of the burst resolves against the live set. */
  private deferRelink(): void {
    if (!this.relinkPending) this.ctx = this.liveCtx(); // first deferral of a burst
    this.relinkPending = true;
  }

  /** True while a deferred re-resolution is waiting for flushRelink. */
  get relinkDeferred(): boolean { return this.relinkPending; }

  /** Runs a deferred re-resolution, if any; returns the files whose local imports changed. */
  flushRelink(): Promise<FileModel[]> {
    return this.serial(async () => (this.relinkPending ? this.relink([]) : []));
  }

  /**
   * Starts `start` for up to READ_AHEAD items at a time (a sliding window) and hands each result
   * to `each` in order, one at a time, until `stop` says so. Returns how many were handed over.
   */
  private async eachAhead<T>(
    items: string[],
    start: (rel: string) => Promise<T>,
    each: (rel: string, v: T) => void | Promise<void>,
    stop?: () => boolean,
  ): Promise<number> {
    const pending: (Promise<T> | undefined)[] = new Array(items.length);
    let next = 0;
    const more = (): void => { if (next < items.length && !stop?.()) { pending[next] = start(items[next]); next++; } };
    for (let k = 0; k < READ_AHEAD; k++) more();
    let i = 0;
    for (; i < items.length && !stop?.(); i++) {
      const v = await pending[i]!;
      pending[i] = undefined;
      more();
      await each(items[i], v);
    }
    await Promise.allSettled(pending.filter(Boolean)); // reads already started when stopping
    return i;
  }

  /** Reads `files` with eachAhead; results already in `known` are reused instead of read again. */
  private readEach(files: string[], known: Map<string, ReadResult>, each: (rel: string, r: ReadResult) => Promise<void>, stop?: () => boolean): Promise<number> {
    return this.eachAhead(files, rel => (known.has(rel) ? Promise.resolve(known.get(rel)!) : this.read(rel)), each, stop);
  }

  /** True when the path no longer exists or is no longer a regular file inside the root; transient errors are not gone. */
  private async isGone(rel: string): Promise<boolean> {
    try {
      const abs = path.join(this.root, ...rel.split('/'));
      const st = await fs.lstat(abs);
      if (!st.isFile()) return true;
      // Reached through a symlinked directory that leads outside the root: gone, as readForModel
      // will never read it again.
      return !insideRoot(await this.realRoot(), await fs.realpath(abs));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
  }

  /** readForModel with the cached real root. */
  private async read(rel: string): Promise<ReadResult> {
    return readForModel(this.root, rel, await this.realRoot().catch(() => undefined));
  }

  private realRootP: Promise<string> | null = null;
  /** The root's realpath, resolved once it succeeds (a failure is retried next time). */
  private realRoot(): Promise<string> {
    if (!this.realRootP) {
      const p = fs.realpath(this.root);
      this.realRootP = p;
      p.catch(() => { if (this.realRootP === p) this.realRootP = null; });
    }
    return this.realRootP;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Applies one file's new read state; null when nothing changed. */
  private apply(rel: string, r: ReadResult): Promise<{ result: UpdateResult; setChanged: boolean }> | null {
    const before = this.files.get(rel) ?? null;
    const beforeText = this.texts.get(rel) ?? null;
    if (!r) {
      if (!before) return null;
      this.files.delete(rel); this.texts.delete(rel); this.lastGood.delete(rel); this.specCache.delete(rel);
      if (this.liveIndex) indexUpdate(this.liveIndex, rel, false);
      return Promise.resolve({
        result: { path: rel, kind: 'deleted', before, after: null, beforeText, afterText: null, touched: [] },
        setChanged: true,
      });
    }
    if (before && this.unchanged(before, beforeText, r)) return null;
    return (async () => {
      const after = await this.build(rel, r);
      // Commit text and model together only after a successful build.
      if (r.kind === 'text') this.texts.set(rel, r.text); else { this.texts.delete(rel); this.specCache.delete(rel); }
      this.files.set(rel, after);
      if (!before && this.liveIndex) indexUpdate(this.liveIndex, rel, true);
      const afterText = r.kind === 'text' ? r.text : null;
      return {
        result: { path: rel, kind: before ? 'modified' : 'created', before, after, beforeText, afterText, touched: [] },
        setChanged: !before,
      };
    })();
  }

  private unchanged(before: FileModel, beforeText: string | null, r: Exclude<ReadResult, null>): boolean {
    if (r.kind === 'text') return beforeText === r.text;
    const kindOf = before.flags.secret ? 'secret' : before.flags.binary ? 'binary' : before.flags.tooLarge ? 'tooLarge' : 'text';
    if (kindOf !== r.kind) return false;
    if (r.kind === 'secret') return before.size === r.size && sameList(before.env, r.envKeys ?? []);
    return before.size === r.size;
  }

  private async build(rel: string, r: Exclude<ReadResult, null>): Promise<FileModel> {
    const base: FileModel = {
      path: rel, lang: langOf(rel), size: r.size, lines: 0, symbols: [],
      imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
    };
    if (r.kind !== 'text') {
      if (r.kind === 'secret') return { ...base, env: r.envKeys ?? [], flags: { secret: true } };
      return { ...base, flags: r.kind === 'binary' ? { binary: true } : { tooLarge: true } };
    }
    const { symbols, parseError } = await this.symbolsFor(rel, base.lang, r.text);
    const { mounts, deps, ...facts } = analyzeFile(rel, base.lang, r.text, this.analyzers);
    return {
      ...base,
      ...facts,
      ...(mounts.length ? { mounts: mounts.map(m => ({ ...m, target: this.mountTarget(rel, base.lang, m.spec) })) } : {}),
      ...(deps ? { deps } : {}),
      lines: countLines(r.text),
      symbols,
      imports: this.importsFor(rel, base.lang, r.text),
      flags: parseError ? { parseError: true } : {},
    };
  }

  private mountTarget(rel: string, lang: FileModel['lang'], spec: string): string | null {
    return resolveSpecifier(rel, lang, spec, this.ctx);
  }

  /** R7: flag only a transition from a clean parse to a failed one, keeping the last good symbols. */
  private async symbolsFor(rel: string, lang: FileModel['lang'], text: string): Promise<{ symbols: CodeSymbol[]; parseError: boolean }> {
    const { symbols, ok } = await fileSymbols(lang, text, rel);
    const good = this.lastGood.get(rel) ?? null;
    if (ok) {
      this.lastGood.set(rel, symbols);
      return { symbols, parseError: false };
    }
    if (good) return { symbols: good, parseError: true };
    this.lastGood.set(rel, null);
    return { symbols, parseError: false };
  }

  private importsFor(rel: string, lang: FileModel['lang'], text: string): FileModel['imports'] {
    const code = lang === 'vue' || lang === 'svelte' ? scriptBlock(text)?.code ?? '' : text;
    return extractImports(rel, lang, code, this.ctx);
  }

  /**
   * Re-resolves every text file's imports and mount targets; returns the files (other than `skip`)
   * whose local imports or mount targets changed.
   */
  private relink(skip: string[]): FileModel[] {
    this.relinkPending = false;
    this.liveIndex = null;
    this.ctx = this.makeCtx([...this.files.keys()]);
    const touched: FileModel[] = [];
    for (const [rel, text] of this.texts) {
      const f = this.files.get(rel);
      if (!f) continue;
      const imports = this.importsFor(rel, f.lang, text);
      const mounts = f.mounts?.map(m => ({ ...m, target: this.mountTarget(rel, f.lang, m.spec) }));
      const mountsChanged = !!mounts && !sameTargets(f.mounts!, mounts);
      const changed = !sameList(f.imports.local, imports.local) || mountsChanged;
      if (changed || !sameList(f.imports.external, imports.external)) {
        const next = { ...f, imports, ...(mountsChanged ? { mounts } : {}) };
        this.files.set(rel, next);
        if (changed && !skip.includes(rel)) touched.push(next);
      }
    }
    return touched.sort((a, b) => cmp(a.path, b.path));
  }

  /**
   * Ctx over the live file set, used for the rest of a deferred burst. The directory index (used
   * only by Go and JVM lookups) is built on first use and then kept current by update(), so a
   * burst builds it at most once and JS-only bursts never do.
   */
  private liveCtx(): ImportCtx {
    const files = this.files;
    const { aliases, goModule } = this.ctx;
    const model = this;
    return {
      has: p => files.has(p),
      get index() { return (model.liveIndex ??= buildIndex([...files.keys()].sort(cmp))); },
      aliases,
      goModule,
      specCache: this.specCache,
    };
  }

  /** Fresh ctx (and fresh files array) for a file set; config read from stored contents. */
  private makeCtx(paths: string[]): ImportCtx {
    const files = [...paths].sort(cmp);
    const set = new Set(files);
    const ts = this.texts.get('tsconfig.json') ?? this.texts.get('jsconfig.json');
    const goMod = this.texts.get('go.mod');
    const goModule = goMod ? /^\s*module\s+(\S+)/m.exec(goMod)?.[1] ?? null : null;
    return { has: p => set.has(p), files, aliases: ts ? readTsconfigAliases(ts) : [], goModule, specCache: this.specCache };
  }
}
