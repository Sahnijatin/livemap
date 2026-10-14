import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodeSymbol, FileModel } from '../shared/types.js';
import { langOf } from './languages.js';
import { fileSymbols } from './symbols/index.js';
import { scriptBlock } from './symbols/markup.js';
import { extractImports, readTsconfigAliases, type ImportCtx } from './imports.js';
import { createIgnore, walk, readForModel, type ReadResult } from './files.js';

export interface UpdateResult {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  before: FileModel | null;
  after: FileModel | null;
  beforeText: string | null;
  afterText: string | null;
  /** Other files whose resolved local imports changed because of this update. */
  touched: FileModel[];
}

const CONFIG_FILES = new Set(['tsconfig.json', 'jsconfig.json', 'go.mod']);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

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
  private isIgnored: (rel: string, isDir: boolean) => boolean;
  private ctx: ImportCtx;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, opts: { limit?: number } = {}) {
    this.root = root;
    this.limit = opts.limit ?? 25000;
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
      this.files.clear(); this.texts.clear(); this.lastGood.clear();
      const { files, truncated } = await walk(this.root, this.isIgnored, this.limit);
      this.truncated = truncated;
      const reads: [string, ReadResult][] = [];
      for (const rel of files) reads.push([rel, await readForModel(this.root, rel)]);
      for (const [rel, r] of reads) if (r?.kind === 'text') this.texts.set(rel, r.text);
      // Register every readable path (and config contents) before parsing so imports see the whole tree.
      this.ctx = this.makeCtx(reads.filter(([, r]) => r).map(([rel]) => rel));
      let done = 0;
      for (const [rel, r] of reads) {
        if (r) this.files.set(rel, await this.build(rel, r));
        onProgress?.(++done, reads.length);
      }
    });
  }

  /** The event is advisory: the file is re-read and its on-disk state decides the result kind. */
  update(rel: string, _event: 'add' | 'change' | 'unlink'): Promise<UpdateResult | null> {
    return this.serial(async () => {
      if (this.ignored(rel)) return null;
      const r = await readForModel(this.root, rel);
      // readForModel returns null for any failure; a known file is deleted only if it is really gone.
      if (!r && this.files.has(rel) && !(await this.isGone(rel))) return null;
      if (r && !this.files.has(rel) && this.files.size >= this.limit) { this.truncated = true; return null; }
      const res = this.apply(rel, r);
      if (!res) return null;
      const { result, setChanged } = await res;
      if (setChanged || CONFIG_FILES.has(rel)) {
        result.touched = this.relink([rel]);
        result.after = this.files.get(rel) ?? null;
      }
      return result;
    });
  }

  /**
   * One `deleted` result per known file under relDir. Imports are re-resolved once for the whole
   * directory, so the combined `touched` list is on the LAST result; consumers merge across the array.
   */
  removeDir(relDir: string): Promise<UpdateResult[]> {
    return this.serial(async () => {
      const prefix = relDir.replace(/\/+$/, '') + '/';
      const gone = [...this.files.keys()].filter(p => p.startsWith(prefix)).sort(cmp);
      const results: UpdateResult[] = [];
      for (const rel of gone) results.push((await this.apply(rel, null))!.result);
      // One import re-resolution for the whole directory; touched goes on the last result.
      if (results.length) results[results.length - 1].touched = this.relink(gone);
      return results;
    });
  }

  /** True when the path no longer exists or is no longer a regular file; transient errors are not gone. */
  private async isGone(rel: string): Promise<boolean> {
    try {
      const st = await fs.lstat(path.join(this.root, ...rel.split('/')));
      return !st.isFile();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR';
    }
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
      this.files.delete(rel); this.texts.delete(rel); this.lastGood.delete(rel);
      return Promise.resolve({
        result: { path: rel, kind: 'deleted', before, after: null, beforeText, afterText: null, touched: [] },
        setChanged: true,
      });
    }
    if (before && this.unchanged(before, beforeText, r)) return null;
    return (async () => {
      const after = await this.build(rel, r);
      // Commit text and model together only after a successful build.
      if (r.kind === 'text') this.texts.set(rel, r.text); else this.texts.delete(rel);
      this.files.set(rel, after);
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
    return {
      ...base,
      lines: countLines(r.text),
      symbols,
      imports: this.importsFor(rel, base.lang, r.text),
      flags: parseError ? { parseError: true } : {},
    };
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

  /** Re-resolves every text file's imports; returns the files (other than `skip`) whose local imports changed. */
  private relink(skip: string[]): FileModel[] {
    this.ctx = this.makeCtx([...this.files.keys()]);
    const touched: FileModel[] = [];
    for (const [rel, text] of this.texts) {
      const f = this.files.get(rel);
      if (!f) continue;
      const imports = this.importsFor(rel, f.lang, text);
      const changed = !sameList(f.imports.local, imports.local);
      if (changed || !sameList(f.imports.external, imports.external)) {
        const next = { ...f, imports };
        this.files.set(rel, next);
        if (changed && !skip.includes(rel)) touched.push(next);
      }
    }
    return touched.sort((a, b) => cmp(a.path, b.path));
  }

  /** Fresh ctx (and fresh files array) for a file set; config read from stored contents. */
  private makeCtx(paths: string[]): ImportCtx {
    const files = [...paths].sort(cmp);
    const set = new Set(files);
    const ts = this.texts.get('tsconfig.json') ?? this.texts.get('jsconfig.json');
    const goMod = this.texts.get('go.mod');
    const goModule = goMod ? /^\s*module\s+(\S+)/m.exec(goMod)?.[1] ?? null : null;
    return { has: p => set.has(p), files, aliases: ts ? readTsconfigAliases(ts) : [], goModule };
  }
}
