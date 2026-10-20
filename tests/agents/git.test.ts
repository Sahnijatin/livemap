import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitWatcher } from '../../src/agents/git.js';
import type { RawAgentEvent } from '../../src/shared/types.js';
import { IS_WIN, rmTree } from '../helpers/platform.js';

/** Slower CI runners scale wall-clock budgets (LIVEMAP_TIME_SCALE, set by CI on macOS and Windows). */
const TIME_SCALE = Number(process.env.LIVEMAP_TIME_SCALE) || 1;

const dirs: string[] = [];
const watchers: GitWatcher[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
  for (const d of dirs.splice(0)) rmTree(d);
});
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-git-'))); dirs.push(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Bot', '-c', 'user.email=bot@x', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (cwd: string, subject: string, body?: string) => {
  fs.writeFileSync(path.join(cwd, `${subject.replace(/\W+/g, '_')}.txt`), subject);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', subject, ...(body ? ['-m', body] : []));
};
const initRepo = () => { const d = tmp(); git(d, 'init', '-q', '-b', 'main'); return d; };
const watch = (root: string, opts?: ConstructorParameters<typeof GitWatcher>[1]) => {
  const w = new GitWatcher(root, { pollMs: 100, ...opts });
  watchers.push(w);
  const got: RawAgentEvent[] = [];
  w.on('events', (evs: RawAgentEvent[]) => got.push(...evs));
  return { w, got };
};
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('GitWatcher', () => {
  it('returns false for a non-git dir', async () => {
    const { w } = watch(tmp());
    expect(await w.start()).toBe(false);
  });

  it('baselines existing commits and emits new ones oldest first', async () => {
    const d = initRepo();
    commit(d, 'old one');
    const { w, got } = watch(d);
    expect(await w.start()).toBe(true);
    commit(d, 'first new', 'with a body');
    commit(d, 'second new');
    await until(() => got.length >= 2);
    expect(got.map((e) => e.text!.split('\n')[0])).toEqual(['first new', 'second new']);
    expect(got[0]).toMatchObject({ agent: 'git', type: 'commit', sessionId: 'Bot' });
    expect(got[0].text).toBe('first new\n\nwith a body');
    expect(got[1].text).toBe('second new');
    expect(Math.abs(got[0].at - Date.now())).toBeLessThan(30_000);
  });

  it('works on an empty repo and emits the first commit', async () => {
    const d = initRepo();
    const { w, got } = watch(d);
    expect(await w.start()).toBe(true);
    commit(d, 'initial');
    await until(() => got.length >= 1);
    expect(got[0].text).toBe('initial');
  });

  it('re-baselines silently on reset', async () => {
    const d = initRepo();
    commit(d, 'a');
    commit(d, 'b');
    const { w, got } = watch(d);
    await w.start();
    git(d, 'reset', '-q', '--hard', 'HEAD~1');
    await new Promise((r) => setTimeout(r, 400));
    expect(got).toEqual([]);
    commit(d, 'c');
    await until(() => got.length >= 1);
    expect(got.map((e) => e.text)).toEqual(['c']);
  });

  it('I5: commit events carry root-relative paths and the time the poll saw them', async () => {
    const d = initRepo();
    commit(d, 'seed');
    fs.mkdirSync(path.join(d, 'sub'));
    const { w, got } = watch(d);
    await w.start();
    fs.writeFileSync(path.join(d, 'sub', 'b.ts'), 'b');
    fs.writeFileSync(path.join(d, 'a b.ts'), 'a');
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'two files');
    const before = Date.now();
    await until(() => got.length >= 1);
    expect([...got[0].paths!].sort()).toEqual(['a b.ts', 'sub/b.ts']);
    expect(got[0].seenAt).toBeGreaterThanOrEqual(before - 1000);
    expect(got[0].seenAt).toBeLessThanOrEqual(Date.now());
  });

  it('I5: paths are relative to a subdirectory root and exclude files outside it; the first commit has paths', async () => {
    const d = initRepo();
    fs.mkdirSync(path.join(d, 'app'));
    const { w, got } = watch(path.join(d, 'app'));
    expect(await w.start()).toBe(true);
    fs.writeFileSync(path.join(d, 'app', 'x.ts'), 'x');
    fs.writeFileSync(path.join(d, 'outside.ts'), 'o');
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'root commit');
    await until(() => got.length >= 1);
    expect(got[0].paths).toEqual(['x.ts']);
  });

  it('I5: a merge lists the files it brought in from the merged branch', async () => {
    const d = initRepo();
    commit(d, 'seed');
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'feature file');
    git(d, 'checkout', '-q', 'main');
    commit(d, 'main file');
    const { w, got } = watch(d);
    await w.start();
    git(d, 'merge', '-q', '--no-ff', '--no-edit', 'feat');
    await until(() => got.some((e) => e.text?.startsWith('Merge')));
    const merge = got.find((e) => e.text?.startsWith('Merge'))!;
    expect(merge.paths).toEqual(['feature_file.txt']);
  });

  it('reads the paths of every commit in a range with one git process', async () => {
    const d = initRepo();
    commit(d, 'seed');
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'one');
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'sub', 'x y.ts'), 'x');
    fs.writeFileSync(path.join(d, 'two.ts'), '2');
    git(d, 'add', '-A');
    git(d, 'commit', '-q', '-m', 'two');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'three');
    git(d, 'checkout', '-q', 'main');
    const calls: string[][] = [];
    const run = (cwd: string, args: string[]) => {
      calls.push(args);
      return new Promise<string>((res, rej) => execFile('git', args, { cwd }, (e, out, err) => (e ? rej(new Error(String(err))) : res(String(out)))));
    };
    const { w, got } = watch(d, { run });
    await w.start();
    git(d, 'merge', '-q', '--ff-only', 'feat');
    await until(() => got.length >= 3);
    expect(got.map(e => [e.text, [...e.paths!].sort()])).toEqual([['one', ['one.txt']], ['two', ['sub/x y.ts', 'two.ts']], ['three', []]]);
    expect(calls.filter(a => a.includes('--name-only'))).toHaveLength(1);
    expect(calls.some(a => a[0] === 'diff-tree')).toBe(false);
  });

  it('falls back to -m when git rejects --diff-merges, keeping first-parent paths for a merge', async () => {
    const d = initRepo();
    commit(d, 'seed');
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'feature file');
    git(d, 'checkout', '-q', 'main');
    commit(d, 'main file');
    const run = (cwd: string, args: string[]) => {
      if (args.includes('--diff-merges=first-parent')) return Promise.reject(new Error('unknown option'));
      return new Promise<string>((res, rej) => execFile('git', args, { cwd }, (e, out, err) => (e ? rej(new Error(String(err))) : res(String(out)))));
    };
    const { w, got } = watch(d, { run });
    await w.start();
    git(d, 'merge', '-q', '--no-ff', '--no-edit', 'feat');
    await until(() => got.some((e) => e.text?.startsWith('Merge')));
    expect(got.find((e) => e.text?.startsWith('Merge'))!.paths).toEqual(['feature_file.txt']);
  });

  it('marks merge commits (by parent count, whatever their message) and only them', async () => {
    const d = initRepo();
    commit(d, 'seed');
    git(d, 'checkout', '-q', '-b', 'feat');
    commit(d, 'feature file');
    git(d, 'checkout', '-q', 'main');
    commit(d, 'main file');
    const { w, got } = watch(d);
    await w.start();
    git(d, 'merge', '-q', '--no-ff', '-m', 'Bring in the feature', 'feat');
    await until(() => got.some((e) => e.text === 'Bring in the feature'));
    expect(got.find((e) => e.text === 'Bring in the feature')!.merge).toBe(true);
    expect(got.find((e) => e.text === 'feature file')!.merge).toBeUndefined();
  });

  it('caps text at 2000 chars', async () => {
    const d = initRepo();
    commit(d, 'seed');
    const { w, got } = watch(d);
    await w.start();
    commit(d, 'big', 'x'.repeat(5000));
    await until(() => got.length >= 1);
    expect(got[0].text!.length).toBe(2000);
  });

  it('pulls fast-forwards with pullSec and emits the pulled commit', async () => {
    const base = tmp();
    const bare = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    const a = path.join(base, 'a');
    git(base, 'clone', '-q', bare, a);
    commit(a, 'seed');
    git(a, 'push', '-q', 'origin', 'HEAD:main');
    const b = path.join(base, 'b');
    git(base, 'clone', '-q', bare, b);
    const { w, got } = watch(b, { pullSec: 1 });
    expect(await w.start()).toBe(true);
    commit(a, 'from remote');
    git(a, 'push', '-q', 'origin', 'HEAD:main');
    await until(() => got.length >= 1, 3500 * TIME_SCALE);
    expect(got[0].text).toBe('from remote');
  }, 5000 * TIME_SCALE);

  it('emits a distinct pull error once and keeps polling', async () => {
    const d = initRepo();
    commit(d, 'a');
    const { w, got } = watch(d, { pullSec: 1 });
    const errs: string[] = [];
    w.on('error', (e: Error) => errs.push(e.message));
    await w.start();
    await new Promise((r) => setTimeout(r, 2600));
    expect(errs.length).toBe(1);
    commit(d, 'b');
    await until(() => got.length >= 1);
  });

  it('does not crash on error without a listener and keeps polling', async () => {
    const d = initRepo();
    commit(d, 'a');
    const { w, got } = watch(d, { pullSec: 1 });
    await w.start();
    await new Promise((r) => setTimeout(r, 1600));
    commit(d, 'b');
    await until(() => got.length >= 1);
    expect(got[0].text).toBe('b');
  });

  it('uses committer time, not author time', async () => {
    const d = initRepo();
    commit(d, 'seed');
    const { w, got } = watch(d);
    await w.start();
    fs.writeFileSync(path.join(d, 'z.txt'), 'z');
    git(d, 'add', '-A');
    const env = { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2021-06-01T00:00:00Z', GIT_CONFIG_COUNT: '0' };
    execFileSync('git', ['-c', 'user.name=Bot', '-c', 'user.email=bot@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'dated'], { cwd: d, env });
    await until(() => got.length >= 1);
    expect(got[0].at).toBe(Date.parse('2021-06-01T00:00:00Z'));
  });

  it('does not replay history after a transient git failure', async () => {
    const d = initRepo();
    commit(d, 'a');
    commit(d, 'b');
    let failHead = false;
    const run = (cwd: string, args: string[]) => {
      if (failHead && args[0] === 'rev-parse') return Promise.reject(new Error('index.lock busy'));
      return new Promise<string>((res, rej) => execFile('git', args, { cwd }, (e, out, err) => (e ? rej(new Error(String(err))) : res(String(out)))));
    };
    const { w, got } = watch(d, { run });
    const errs: string[] = [];
    w.on('error', (e: Error) => errs.push(e.message));
    await w.start();
    failHead = true;
    await new Promise((r) => setTimeout(r, 350));
    failHead = false;
    commit(d, 'c');
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(got.map((e) => e.text)).toEqual(['c']);
    expect(errs).toEqual(['index.lock busy']);
  });

  it('caps bulk commits at the newest 100, oldest first', async () => {
    const d = initRepo();
    commit(d, 'seed');
    const { w, got } = watch(d);
    await w.start();
    for (let i = 1; i <= 120; i++) git(d, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
    await until(() => got.length >= 100);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(100);
    expect(got[0].text).toBe('c21');
    expect(got[99].text).toBe('c120');
    // 120 git processes in a row: each start costs tens of ms on Windows, past vitest's 5 s default.
  }, 30_000);

  // Windows: a shell script cannot stand in for git.exe.
  it.skipIf(IS_WIN)('stop() ends a git command still running (on Windows it would keep the repo from being deleted)', async () => {
    const d = tmp();
    const bin = tmp();
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 5\necho ok\n', { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${saved}`;
    try {
      const { w } = watch(d);
      const t = Date.now();
      const started = w.start();
      await new Promise((r) => setTimeout(r, 200));
      w.stop();
      expect(await started).toBe(false);
      expect(Date.now() - t).toBeLessThan(2000);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('start is idempotent', async () => {
    const d = initRepo();
    commit(d, 'a');
    const { w, got } = watch(d);
    await w.start();
    expect(await w.start()).toBe(true);
    commit(d, 'b');
    await until(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(1);
  });
});

describe('review fixes: start/stop race', () => {
  it('stop() during start() leaves no timers running', async () => {
    const d = initRepo();
    commit(d, 'first');
    const { w } = watch(d, { pullSec: 5 });
    const started = w.start();
    w.stop();
    await started;
    const t = w as unknown as { pollTimer?: unknown; pullTimer?: unknown };
    expect(t.pollTimer).toBeUndefined();
    expect(t.pullTimer).toBeUndefined();
  });
});

