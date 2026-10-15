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

let root: string;
let lmHome: string;
let userHome: string;
let child: ChildProcess | null;
let out: string;
let err: string;
let exit: { code: number | null; signal: NodeJS.Signals | null } | null;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`waitFor timed out; stdout=${out} stderr=${err}`);
    await sleep(50);
  }
}
function run(args: string[]): ChildProcess {
  out = ''; err = ''; exit = null;
  const env = { ...process.env, LIVEMAP_HOME: lmHome, HOME: userHome };
  const c = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  c.stdout!.setEncoding('utf8').on('data', d => (out += d));
  c.stderr!.setEncoding('utf8').on('data', d => (err += d));
  c.on('exit', (code, signal) => (exit = { code, signal }));
  child = c;
  return c;
}
async function api(p: string): Promise<{ status: number; body: any }> {
  const [, port, token] = out.match(URL_RE)!;
  const sep = p.includes('?') ? '&' : '?';
  const res = await fetch(`http://127.0.0.1:${port}${p}${sep}t=${token}`);
  return { status: res.status, body: await res.json() };
}
/** Starts the CLI and waits until the server is ready (/api/state answers 503 while indexing). */
async function start(args: string[]): Promise<ChildProcess> {
  const c = run(args);
  await waitFor(() => URL_RE.test(out));
  await waitFor(async () => (await api('/api/state')).status === 200);
  return c;
}
async function stop(c: ChildProcess): Promise<void> {
  c.kill('SIGTERM');
  await waitFor(() => exit !== null);
}

beforeAll(buildOnce, 120_000);

beforeEach(() => {
  const mk = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  root = mk('lm-clihist-');
  lmHome = mk('lm-clihist-lmhome-');
  userHome = mk('lm-clihist-home-');
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function first() { return 1; }\n');
  child = null;
});
afterEach(async () => {
  if (child && exit === null) {
    child.kill('SIGKILL');
    await waitFor(() => exit !== null).catch(() => {});
  }
  for (const d of [root, lmHome, userHome]) fs.rmSync(d, { recursive: true, force: true });
});

describe('livemap history', () => {
  it('records each run, and run 2 starts from the state on disk', async () => {
    await stop(await start([root, '--no-open', '--port', '0']));
    expect(exit!.code).toBe(0);

    // Edited while LiveMap was not running: only run 2's start state can know about it.
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function first() { return 1; }\nexport function second() { return 2; }\n');
    const c = await start([root, '--no-open', '--port', '0']);
    const info = (await api('/api/history/info')).body;
    expect(info.enabled).toBe(true);
    expect(info.runs).toHaveLength(2);
    const state = (await api(`/api/history/state?seq=${info.runs[1].firstSeq}`)).body;
    const a = state.files.find((f: any) => f.path === 'a.ts');
    expect(a.symbols.map((s: any) => s.name)).toEqual(expect.arrayContaining(['first', 'second']));
    const before = (await api(`/api/history/state?seq=${info.runs[0].firstSeq}`)).body;
    expect(before.files.find((f: any) => f.path === 'a.ts').symbols.map((s: any) => s.name)).not.toContain('second');
    await stop(c);
    expect(exit!.code).toBe(0);
  }, 30_000);

  it('--no-history records nothing', async () => {
    const c = await start([root, '--no-open', '--port', '0', '--no-history']);
    const res = await api('/api/history/info');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'history disabled' });
    await stop(c);
    expect(fs.existsSync(path.join(lmHome, 'projects'))).toBe(false);
  }, 30_000);

  it('warns once and keeps running when history cannot be opened', async () => {
    // A file where the projects directory should be makes opening fail.
    fs.writeFileSync(path.join(lmHome, 'projects'), '');
    const c = await start([root, '--no-open', '--port', '0']);
    expect(err.match(/history is unavailable/g)).toHaveLength(1);
    const info = (await api('/api/history/info')).body;
    expect(info.enabled).toBe(false);
    expect(info.error).toMatch(/could not open history files/);
    expect((await api('/api/state')).body.history.enabled).toBe(false);
    // A failure, not the user's choice: the UI shows the error, not "History is off".
    expect((await api('/api/state')).body.history.off).toBeUndefined();
    await stop(c);
    expect(exit!.code).toBe(0);
  }, 30_000);
});

describe('livemap summaries', () => {
  it('are off by default, even with a key in the environment', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-used';
    try {
      const c = await start([root, '--no-open', '--port', '0']);
      expect((await api('/api/state')).body.summaries.status.state).toBe('off');
      expect((await api('/api/summary?path=a.ts')).status).toBe(503);
      expect(err).not.toMatch(/summaries/);
      await stop(c);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  }, 30_000);

  it('--summaries turns them on with the configured provider, and says when a key is missing', async () => {
    fs.writeFileSync(path.join(lmHome, 'config.json'), JSON.stringify({ summaries: { provider: 'ollama', model: 'tiny', url: 'http://127.0.0.1:9' } }));
    const s = await start([root, '--no-open', '--port', '0', '--summaries']);
    const status = (await api('/api/state')).body.summaries.status;
    expect(status).toMatchObject({ state: 'ready', provider: 'ollama', model: 'tiny', usedTokens: 0, capTokens: 2_000_000 });
    await stop(s);
    expect(exit!.code).toBe(0);

    fs.writeFileSync(path.join(lmHome, 'config.json'), JSON.stringify({ summaries: { provider: 'openai' } }));
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const s2 = await start([root, '--no-open', '--port', '0', '--summaries']);
      expect((await api('/api/state')).body.summaries.status.state).toBe('off');
      expect(err).toContain('summaries are off: no API key');
      await stop(s2);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  }, 30_000);

  it('a config apiKey without a provider keeps summaries off and says provider is required', async () => {
    fs.writeFileSync(path.join(lmHome, 'config.json'), JSON.stringify({ summaries: { enabled: true, apiKey: 'sk-not-used' } }));
    const s = await start([root, '--no-open', '--port', '0']);
    expect((await api('/api/state')).body.summaries.status.state).toBe('off');
    expect(err).toContain('summaries are off');
    expect(err).toContain('"provider" is required when "apiKey" is set');
    expect(err).not.toContain('sk-not-used');
    await stop(s);
  }, 30_000);
});
