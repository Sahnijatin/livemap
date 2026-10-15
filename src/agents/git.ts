import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import type { RawAgentEvent } from '../shared/types.js';

const MAX_TEXT = 2000;
const FIELD = '\x1f';
const RECORD = '\x1e';

const MAX_COMMITS = 100;
const MAX_PATHS = 500;

export interface GitWatcherOptions {
  pollMs?: number;
  pullSec?: number | null;
  /** Test seam: replaces the git runner. */
  run?: (cwd: string, args: string[]) => Promise<string>;
}

class GitError extends Error {
  constructor(message: string, readonly exitCode: unknown, readonly stderr: string) { super(message); }
}

function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, signal }, (err, stdout, stderr) => {
      if (err) reject(new GitError((String(stderr).trim() || err.message).slice(0, 500), (err as { code?: unknown }).code, String(stderr).trim()));
      else resolve(String(stdout));
    });
  });
}

/**
 * Polls HEAD and emits 'events' (RawAgentEvent[]) with one commit event per new commit.
 * Emits 'error' (once per distinct message, only when someone listens).
 */
export class GitWatcher extends EventEmitter {
  private readonly pollMs: number;
  private readonly pullSec: number | null;
  private readonly run: (cwd: string, args: string[]) => Promise<string>;
  private head: string | null = null;
  private pollTimer?: NodeJS.Timeout;
  private pullTimer?: NodeJS.Timeout;
  private polling = false;
  private pulling = false;
  private stopped = true;
  /**
   * Aborts the git commands still running when stop() is called. On Windows a running git keeps the repo
   * as its working directory, which nothing can delete until it exits.
   */
  private abort = new AbortController();
  private readonly seenErrors = new Set<string>();

  constructor(private readonly root: string, opts: GitWatcherOptions = {}) {
    super();
    this.pollMs = opts.pollMs ?? 3000;
    this.pullSec = opts.pullSec ?? null;
    this.run = opts.run ?? ((cwd, args) => git(cwd, args, this.abort.signal));
  }

  async start(): Promise<boolean> {
    if (this.pollTimer) return true;
    this.stopped = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    try {
      if ((await this.run(this.root, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return false;
    } catch {
      return false;
    }
    try {
      this.head = await this.readHead();
    } catch (err) {
      this.fail(err);
      return false;
    }
    if (this.pollTimer) return true;
    if (this.stopped) return false; // stop() ran while we were checking the repo
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
    this.pollTimer.unref?.();
    if (this.pullSec && this.pullSec > 0) {
      this.pullTimer = setInterval(() => void this.pull(), this.pullSec * 1000);
      this.pullTimer.unref?.();
    }
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pullTimer) clearInterval(this.pullTimer);
    this.pollTimer = this.pullTimer = undefined;
  }

  private async readHead(): Promise<string | null> {
    try {
      return (await this.run(this.root, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
    } catch (err) {
      // An unborn HEAD exits 1 with no output; anything else is a real failure.
      if (err instanceof GitError && err.exitCode === 1 && !err.stderr) return null;
      throw err;
    }
  }

  private fail(err: unknown): void {
    if (this.stopped) return; // a command stop() aborted, or one that lost its race with stop()
    const msg = err instanceof Error ? err.message : String(err);
    if (this.seenErrors.has(msg)) return;
    this.seenErrors.add(msg);
    if (this.listenerCount('error') > 0) this.emit('error', err instanceof Error ? err : new Error(msg));
  }

  private async pull(): Promise<void> {
    if (this.pulling || this.stopped) return;
    this.pulling = true;
    try {
      await this.run(this.root, ['pull', '--ff-only']);
    } catch (err) {
      this.fail(err);
    } finally {
      this.pulling = false;
    }
    await this.poll();
  }

  /**
   * Files each commit in `range` changed (a merge: against its first parent), relative to the root, from one
   * `git log`; undefined on failure. Renames count as a delete and an add, as `diff-tree` lists them.
   */
  private async rangePaths(range: string): Promise<Map<string, string[]> | undefined> {
    const args = (merges: string[]) => ['log', `--max-count=${MAX_COMMITS}`, '--no-show-signature', '--name-only', '-z', '--root', '--relative', '--no-renames', ...merges, `--format=${RECORD}%H`, range];
    let out: string;
    try {
      out = await this.run(this.root, args(['--diff-merges=first-parent']));
    } catch {
      // git before 2.31: `-m` lists a merge once per parent, first parent first; only that first list is kept.
      try { out = await this.run(this.root, args(['-m'])); } catch { return undefined; }
    }
    const paths = new Map<string, string[]>();
    let list: string[] | null = null;
    let first = false;
    for (const tok of out.split('\0')) {
      if (tok.startsWith(RECORD)) {
        const sha = tok.slice(1);
        list = paths.has(sha) ? null : [];
        if (list) paths.set(sha, list);
        first = true;
        continue;
      }
      // The first path after a commit line starts with the newline that ends it.
      const p = first ? tok.replace(/^\n/, '') : tok;
      first = false;
      if (p && list && list.length < MAX_PATHS && !list.includes(p)) list.push(p);
    }
    return paths;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const next = await this.readHead();
      const prev = this.head;
      if (next === prev) return;
      if (!next) { this.head = next; return; }
      let range: string | null = null;
      if (prev === null) range = next;
      else {
        try {
          await this.run(this.root, ['merge-base', '--is-ancestor', prev, next]);
          range = `${prev}..${next}`;
        } catch { /* not a descendant: re-baseline silently */ }
      }
      if (!range) { this.head = next; return; }
      const out = await this.run(this.root, ['log', '--reverse', `--max-count=${MAX_COMMITS}`, '--no-show-signature', `--format=%H${FIELD}%ct${FIELD}%an${FIELD}%s${FIELD}%b${RECORD}`, range]);
      const seenAt = Date.now();
      const events: RawAgentEvent[] = [];
      const pathsOf = await this.rangePaths(range);
      for (const rec of out.split(RECORD)) {
        if (!rec.trim()) continue;
        const [sha, at, author, subject, body = ''] = rec.replace(/^\n/, '').split(FIELD);
        const text = `${subject}\n\n${body}`.trim().slice(0, MAX_TEXT);
        const paths = pathsOf?.get(sha);
        events.push({ agent: 'git', sessionId: author, at: Number(at) * 1000, seenAt, type: 'commit', text, ...(paths ? { paths } : {}) });
      }
      this.head = next;
      if (events.length && !this.stopped) this.emit('events', events);
    } catch (err) {
      this.fail(err);
    } finally {
      this.polling = false;
    }
  }
}
