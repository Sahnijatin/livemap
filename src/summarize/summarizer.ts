import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ensureDir, FILE_MODE } from '../history/paths.js';
import { callProvider, ProviderError } from './providers.js';
import type { ProviderPrompt } from './providers.js';
import type { SummaryConfig, SummaryStatus } from '../shared/summaries.js';
import type { ChangeSummary, CodeSymbol, FileModel } from '../shared/types.js';

export type { SummaryConfig, SummaryStatus };
export const PROMPT_VERSION = 1;

const FILE_SYSTEM = 'You explain source files to developers in one or two plain sentences. No markdown. Describe what the file does and how it fits in.';
const CHANGE_SYSTEM = 'You describe a code change in one plain sentence under 20 words. No markdown.';
const FILE_MAX_TOKENS = 120;
const CHANGE_MAX_TOKENS = 60;
const MAX_LINES = 300;
const MAX_CHARS = 12_000;
const MAX_HUNK_CHARS = 4_000;
const MAX_RESULT = 300;
const MAX_RETRIES = 3;
const PAUSE_MS = 60_000;
const MAX_QUEUE = 200;

interface Opts { home: string; fetchImpl?: typeof fetch; now?: () => number; concurrency?: number; timeoutMs?: number }
interface Job { run: () => Promise<string | null>; resolve: (v: string | null) => void }

export class Summarizer extends EventEmitter {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly queue: Job[] = [];
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly aborts = new Set<AbortController>();
  private sleeps = new Set<{ t: ReturnType<typeof setTimeout>; res: () => void }>();
  private active = 0;
  private reserved = 0;
  private waiters: (() => void)[] = [];
  private pausedUntil = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private capHit = false;
  private error: string | undefined;
  private month: string;
  private used: number;
  private last = '';

  constructor(private readonly cfg: SummaryConfig, private readonly opts: Opts) {
    super();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.month = this.monthNow();
    this.used = this.readUsage();
  }

  status(): SummaryStatus {
    this.rollMonth();
    const state: SummaryStatus['state'] = this.capHit ? 'cap' : this.error ? 'error' : this.active > 0 || this.queue.length > 0 ? 'working' : 'ready';
    return {
      state, provider: this.cfg.provider, model: this.cfg.model, usedTokens: this.used, capTokens: this.cfg.monthlyTokenCap, month: this.month,
      ...(state === 'error' && this.error ? { error: this.error } : {}),
    };
  }

  summarizeFile(file: FileModel, text: string): Promise<string | null> {
    if (this.blocked(file)) return Promise.resolve(null);
    const body = text.split('\n').slice(0, MAX_LINES).join('\n').slice(0, MAX_CHARS);
    const syms = flatten(file.symbols).map((s) => `${s.name}: ${s.signature}`).join('\n');
    const user = `Path: ${file.path}\nLanguage: ${file.lang}\nSymbols:\n${syms || '(none)'}\n\nSource:\n${body}`;
    return this.submit({ system: FILE_SYSTEM, user, maxTokens: FILE_MAX_TOKENS });
  }

  summarizeChange(change: ChangeSummary, file: FileModel | null): Promise<string | null> {
    if ((file && this.blocked(file)) || change.lang === 'secret') return Promise.resolve(null);
    if (!changeQualifies(change)) return Promise.resolve(null);
    const { symbols: s, routes: r, entities: e } = change;
    const names = (xs: { name: string }[]): string => xs.map((x) => x.name).join(', ') || '-';
    const routes = (xs: { method: string; path: string }[]): string => xs.map((x) => `${x.method} ${x.path}`).join(', ') || '-';
    const facts = [
      `Change: ${change.kind}`,
      `Symbols added: ${names(s.added)}`, `Symbols removed: ${names(s.removed)}`, `Symbols modified: ${names(s.modified)}`,
      `Routes added: ${routes(r.added)}`, `Routes removed: ${routes(r.removed)}`,
      `Tables added: ${names(e.added)}`, `Tables removed: ${names(e.removed)}`, `Tables changed: ${names(e.changed)}`,
      ...(change.deps ? [`Dependencies added: ${names(change.deps.added)}`, `Dependencies removed: ${names(change.deps.removed)}`, `Dependencies changed: ${names(change.deps.changed)}`] : []),
    ].join('\n');
    const hunks = change.hunks.map((h) => h.lines.join('\n')).join('\n').slice(0, MAX_HUNK_CHARS);
    const user = `Path: ${change.path}\n${facts}\n\nChanges:\n${hunks}`;
    return this.submit({ system: CHANGE_SYSTEM, user, maxTokens: CHANGE_MAX_TOKENS });
  }

  stop(): void {
    this.stopped = true;
    for (const sl of this.sleeps) { clearTimeout(sl.t); sl.res(); }
    this.sleeps.clear();
    for (const w of this.waiters.splice(0)) w();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    for (const a of this.aborts) a.abort();
    for (const j of this.queue.splice(0)) j.resolve(null);
  }

  private blocked(f: FileModel): boolean {
    return this.stopped || f.lang === 'secret' || !!(f.flags.secret || f.flags.binary || f.flags.tooLarge);
  }

  private submit(p: ProviderPrompt): Promise<string | null> {
    if (this.stopped) return Promise.resolve(null);
    const key = crypto.createHash('sha256')
      .update(`${this.cfg.provider}|${this.cfg.model}|${PROMPT_VERSION}|${p.maxTokens}|${p.system}\n${p.user}`).digest('hex');
    const cached = this.readCache(key);
    if (cached !== null) return Promise.resolve(cached);
    const dup = this.inflight.get(key);
    if (dup) return dup;
    const prom = new Promise<string | null>((resolve) => {
      if (this.queue.length >= MAX_QUEUE) this.queue.shift()?.resolve(null);
      this.queue.push({ run: () => this.execute(key, p), resolve });
      this.pump();
      this.emitStatus();
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, prom);
    return prom;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.now() < this.pausedUntil) return;
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      job.run().catch(() => null).then((v) => {
        this.active--;
        job.resolve(v);
        this.emitStatus();
        this.pump();
      });
    }
  }

  private async execute(key: string, p: ProviderPrompt): Promise<string | null> {
    const estimate = Math.ceil((p.system.length + p.user.length) / 4) + p.maxTokens;
    for (;;) {
      this.rollMonth();
      this.used = Math.max(this.used, this.readUsage()); // another LiveMap process may have spent tokens
      if (this.stopped) return null;
      if (this.capHit) return null;
      if (this.used + estimate > this.cfg.monthlyTokenCap) {
        this.capHit = true;
        this.emitStatus();
        return null;
      }
      if (this.used + this.reserved + estimate <= this.cfg.monthlyTokenCap) break;
      // Only in-flight reservations block this job: wait for them to settle, then re-check.
      await new Promise<void>((res) => this.waiters.push(res));
    }
    this.reserved += estimate;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.attempt(p);
          // Add to what the file holds now: another LiveMap process may have spent tokens during the request.
          this.used = Math.max(this.used, this.readUsage()) + r.inputTokens + r.outputTokens;
          this.writeUsage();
          this.error = undefined;
          const text = r.text.trim().slice(0, MAX_RESULT);
          if (!text) return null;
          this.writeCache(key, text);
          return text;
        } catch (e) {
          const pe = e instanceof ProviderError ? e : new ProviderError(0, false, 'request failed');
          if (pe.retryable && attempt < MAX_RETRIES && !this.stopped) {
            await this.sleep(1000 * 2 ** attempt);
            if (this.stopped) return null;
            continue;
          }
          if (this.stopped) return null;
          this.error = this.scrub(pe.status ? `${pe.status} ${pe.message}` : pe.message);
          if (!pe.retryable && pe.status >= 400 && pe.status < 500) this.pause();
          return null;
        }
      }
    } finally {
      this.reserved -= estimate;
      for (const w of this.waiters.splice(0)) w();
    }
  }

  private async attempt(p: ProviderPrompt): ReturnType<typeof callProvider> {
    const ac = new AbortController();
    this.aborts.add(ac);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => { ac.abort(); rej(new ProviderError(0, false, 'timeout')); }, this.timeoutMs);
    });
    try {
      return await Promise.race([callProvider(this.cfg, p, this.fetchImpl, ac.signal), timeout]);
    } finally {
      clearTimeout(timer);
      this.aborts.delete(ac);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      const sl = { t: setTimeout(() => { this.sleeps.delete(sl); res(); }, ms), res };
      this.sleeps.add(sl);
    });
  }

  private pause(): void {
    this.pausedUntil = this.now() + PAUSE_MS;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => { this.resumeTimer = null; this.pausedUntil = 0; this.pump(); }, PAUSE_MS);
  }

  private scrub(s: string): string {
    return this.cfg.apiKey ? s.split(this.cfg.apiKey).join('[redacted]') : s;
  }

  private emitStatus(): void {
    const s = this.status();
    const sig = JSON.stringify(s);
    if (sig === this.last) return;
    this.last = sig;
    this.emit('status', s);
  }

  // Usage and cache persistence. Failures here never break the live UI; they only cost a re-request.
  private monthNow(): string { return new Date(this.now()).toISOString().slice(0, 7); }
  private usagePath(): string { return path.join(this.opts.home, 'usage.json'); }

  private readUsage(): number {
    try {
      const u = JSON.parse(fs.readFileSync(this.usagePath(), 'utf8'));
      if (u && u.month === this.month && typeof u.tokens === 'number' && u.tokens >= 0) return u.tokens;
    } catch { /* missing or corrupt: start at zero */ }
    return 0;
  }

  private rollMonth(): void {
    const m = this.monthNow();
    if (m === this.month) return;
    this.month = m;
    this.used = 0;
    this.capHit = false;
    this.writeUsage();
  }

  private writeUsage(): void {
    try {
      ensureDir(this.opts.home);
      writeSync(this.usagePath(), JSON.stringify({ month: this.month, tokens: this.used }));
    } catch { /* ignore */ }
  }

  private cachePath(key: string): string { return path.join(this.opts.home, 'cache', 'summaries', `${key}.json`); }

  private readCache(key: string): string | null {
    try {
      const c = JSON.parse(fs.readFileSync(this.cachePath(key), 'utf8'));
      return typeof c?.text === 'string' && c.text ? c.text : null;
    } catch { return null; }
  }

  private writeCache(key: string, text: string): void {
    try {
      ensureDir(path.dirname(this.cachePath(key)));
      writeSync(this.cachePath(key), JSON.stringify({ text }));
    } catch { /* ignore */ }
  }
}

/** A change worth a summary: at least one symbol, route or entity change (spec §9). */
export function changeQualifies(change: ChangeSummary): boolean {
  const { symbols: s, routes: r, entities: e } = change;
  return s.added.length + s.removed.length + s.modified.length + r.added.length + r.removed.length + e.added.length + e.removed.length + e.changed.length > 0;
}

function flatten(syms: CodeSymbol[], out: CodeSymbol[] = []): CodeSymbol[] {
  for (const s of syms) { out.push(s); flatten(s.children, out); }
  return out;
}

/** Atomic 0600 write (temp file, then rename). Sync so usage is on disk before the next cap check. */
function writeSync(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: FILE_MODE, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
