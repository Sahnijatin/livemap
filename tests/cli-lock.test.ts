import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnce } from './build.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli.js');
const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{32})/;

interface Run { child: ChildProcess; out: string; err: string; exit: { code: number | null; signal: NodeJS.Signals | null } | null }

let root: string;
let lmHome: string;
let userHome: string;
let runs: Run[];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean, r: Run, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`waitFor timed out; stdout=${r.out} stderr=${r.err}`);
    await sleep(20);
  }
}
function start(args: string[]): Run {
  const env = { ...process.env, LIVEMAP_HOME: lmHome, HOME: userHome };
  const child = spawn(process.execPath, [cli, root, '--no-open', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  const r: Run = { child, out: '', err: '', exit: null };
  child.stdout!.setEncoding('utf8').on('data', d => (r.out += d));
  child.stderr!.setEncoding('utf8').on('data', d => (r.err += d));
  child.on('exit', (code, signal) => (r.exit = { code, signal }));
  runs.push(r);
  return r;
}
async function started(args: string[] = []): Promise<Run & { port: number }> {
  const r = start(args);
  await waitFor(() => URL_RE.test(r.out) || r.exit !== null, r);
  expect(r.exit).toBeNull();
  return Object.assign(r, { port: Number(r.out.match(URL_RE)![1]) });
}
async function ended(r: Run): Promise<void> {
  await waitFor(() => r.exit !== null, r);
}
const dirFiles = (d: string) => (fs.existsSync(path.join(lmHome, d)) ? fs.readdirSync(path.join(lmHome, d)) : []);

beforeAll(buildOnce, 120_000);

beforeEach(() => {
  const mk = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  root = mk('lm-clilock-');
  lmHome = mk('lm-clilock-lmhome-');
  userHome = mk('lm-clilock-home-');
  runs = [];
});
afterEach(async () => {
  for (const r of runs) {
    if (r.exit === null) {
      r.child.kill('SIGKILL');
      await ended(r).catch(() => {});
    }
  }
  for (const d of [root, lmHome, userHome]) fs.rmSync(d, { recursive: true, force: true });
});

describe('one LiveMap per project (#21)', () => {
  for (const args of [[], ['--no-history']]) {
    it(`refuses a second instance on the same project and leaves the first intact${args.length ? ` (${args[0]})` : ''}`, async () => {
      const first = await started(args);
      const runtime = path.join(lmHome, 'run', dirFiles('run')[0]);
      const before = fs.readFileSync(runtime, 'utf8');
      expect(dirFiles('locks')).toHaveLength(1);

      const second = start(args);
      await ended(second);
      expect(second.exit).toEqual({ code: 1, signal: null });
      expect(second.err).toContain(`LiveMap is already running for this project (pid ${first.child.pid}) at http://127.0.0.1:${first.port}`);
      expect(second.out).toBe('');
      expect(fs.readFileSync(runtime, 'utf8')).toBe(before);
      expect(dirFiles('locks')).toHaveLength(1);
      const token = first.out.match(URL_RE)![2];
      const health = await fetch(`http://127.0.0.1:${first.port}/api/health`, { headers: { 'x-livemap-token': token } });
      expect(health.status).toBe(200);

      first.child.kill('SIGTERM');
      await ended(first);
      expect(first.exit).toEqual({ code: 0, signal: null });
      expect(dirFiles('locks')).toEqual([]);
      expect(dirFiles('run')).toEqual([]);

      const third = await started(args);
      third.child.kill('SIGINT');
      await ended(third);
      expect(third.exit!.code).toBe(0);
      expect(dirFiles('locks')).toEqual([]);
    }, 30_000);
  }

  it('replaces the stale lock of a killed instance', async () => {
    const first = await started();
    first.child.kill('SIGKILL');
    await ended(first);
    expect(dirFiles('locks')).toHaveLength(1);
    const next = await started();
    expect(JSON.parse(fs.readFileSync(path.join(lmHome, 'locks', dirFiles('locks')[0]), 'utf8'))).toEqual({ pid: next.child.pid, port: next.port });
  }, 30_000);

  it('replaces the lock of a killed instance whose pid an unrelated process reuses (#40)', async () => {
    const first = await started();
    first.child.kill('SIGKILL');
    await ended(first);
    const lock = path.join(lmHome, 'locks', dirFiles('locks')[0]);
    const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      // The lock as the killed run left it, but its pid now names a live process that is not LiveMap.
      fs.writeFileSync(lock, JSON.stringify({ pid: squatter.pid, port: first.port }));
      const next = await started();
      expect(JSON.parse(fs.readFileSync(lock, 'utf8'))).toEqual({ pid: next.child.pid, port: next.port });
    } finally {
      squatter.kill('SIGKILL');
      await new Promise(r => squatter.on('exit', r));
    }
  }, 30_000);

  it('registers for hooks over a stale runtime entry whose pid an unrelated process reuses (#40)', async () => {
    const first = await started();
    first.child.kill('SIGKILL');
    await ended(first);
    const runtime = path.join(lmHome, 'run', dirFiles('run')[0]);
    const squatter = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(runtime, JSON.stringify({ ...JSON.parse(fs.readFileSync(runtime, 'utf8')), pid: squatter.pid }));
      const next = await started();
      expect(next.err).not.toContain('could not write runtime file');
      expect(JSON.parse(fs.readFileSync(runtime, 'utf8'))).toMatchObject({ pid: next.child.pid, port: next.port });
    } finally {
      squatter.kill('SIGKILL');
      await new Promise(r => squatter.on('exit', r));
    }
  }, 30_000);

  it('allows LiveMap on another project at the same time', async () => {
    await started();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-clilock-b-')));
    try {
      const env = { ...process.env, LIVEMAP_HOME: lmHome, HOME: userHome };
      const child = spawn(process.execPath, [cli, other, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env });
      const r: Run = { child, out: '', err: '', exit: null };
      child.stdout!.setEncoding('utf8').on('data', d => (r.out += d));
      child.on('exit', (code, signal) => (r.exit = { code, signal }));
      runs.push(r);
      await waitFor(() => URL_RE.test(r.out) || r.exit !== null, r);
      expect(r.exit).toBeNull();
      expect(dirFiles('locks')).toHaveLength(2);
    } finally {
      for (const r of runs) if (r.exit === null) { r.child.kill('SIGTERM'); await ended(r).catch(() => {}); }
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, 30_000);
});
