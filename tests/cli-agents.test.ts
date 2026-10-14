import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
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
async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`waitFor timed out; stdout=${out} stderr=${err}`);
    await sleep(20);
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
async function runToEnd(args: string[]): Promise<void> {
  run(args);
  await waitFor(() => exit !== null);
}
const runFiles = () => (fs.existsSync(path.join(lmHome, 'run')) ? fs.readdirSync(path.join(lmHome, 'run')) : []);

beforeAll(buildOnce, 120_000);

beforeEach(() => {
  const mk = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  root = mk('lm-cliag-');
  lmHome = mk('lm-cliag-lmhome-');
  userHome = mk('lm-cliag-home-');
  child = null;
});
afterEach(async () => {
  if (child && exit === null) {
    child.kill('SIGKILL');
    await waitFor(() => exit !== null).catch(() => {});
  }
  for (const d of [root, lmHome, userHome]) fs.rmSync(d, { recursive: true, force: true });
});

describe('livemap init', () => {
  it('configures claude, installs the hook script and writes a valid file', async () => {
    await runToEnd(['init', root, '--agents', 'claude']);
    expect(exit!.code).toBe(0);
    expect(out).toContain('created .claude/settings.local.json');
    expect(out).not.toContain('Codex');
    const hook = path.join(lmHome, 'bin', 'livemap-hook.mjs');
    expect(fs.readFileSync(hook, 'utf8')).toBe(fs.readFileSync(path.join(repo, 'dist', 'hook.mjs'), 'utf8'));
    expect(fs.statSync(hook).mode & 0o777).toBe(0o755);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8'));
    expect(cfg.hooks.Stop[0].hooks[0].command).toBe(`node "${hook}" claude-code Stop`);

    await runToEnd(['init', root, '--agents=claude']);
    expect(exit!.code).toBe(0);
    expect(out).toContain('unchanged .claude/settings.local.json');
  });

  it('prints the Codex trust reminder and removes with --remove', async () => {
    await runToEnd(['init', root, '--agents', 'codex,cursor']);
    expect(exit!.code).toBe(0);
    expect(out).toContain('created .codex/hooks.json');
    expect(out).toContain('created .cursor/hooks.json');
    expect(out).toContain('Codex: run /hooks inside Codex once to trust the LiveMap hook.');
    await runToEnd(['init', root, '--remove']);
    expect(exit!.code).toBe(0);
    expect(out).toContain('deleted .codex/hooks.json');
    expect(out).toContain('deleted .cursor/hooks.json');
  });

  it('exits 1 when no agents are detected', async () => {
    await runToEnd(['init', root]);
    expect(exit!.code).toBe(1);
    expect(out + err).toContain('No agents detected. Use --agents claude,codex,cursor.');
  });

  it('detects agents from HOME', async () => {
    fs.mkdirSync(path.join(userHome, '.codex'));
    await runToEnd(['init', root]);
    expect(exit!.code).toBe(0);
    expect(out).toContain('created .codex/hooks.json');
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('rejects an unknown agent', async () => {
    await runToEnd(['init', root, '--agents', 'claude,vim']);
    expect(exit!.code).not.toBe(0);
    expect(err).toContain('vim');
  });

  it('reports a skipped invalid config file', async () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude/settings.local.json'), '{ nope');
    await runToEnd(['init', root, '--agents', 'claude']);
    expect(out).toMatch(/skipped \.claude\/settings\.local\.json: /);
    expect(exit!.code).toBe(1); // nothing could be configured
    expect(fs.readFileSync(path.join(root, '.claude/settings.local.json'), 'utf8')).toBe('{ nope');
  });
});

describe('livemap serve with agents', () => {
  it('writes a runtime file after binding and removes it after SIGTERM', async () => {
    const c = run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    const [, port, token] = out.match(URL_RE)!;
    expect(runFiles()).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(lmHome, 'run', runFiles()[0]), 'utf8'));
    expect(entry).toEqual({ root, port: Number(port), token, pid: c.pid });
    c.kill('SIGTERM');
    await waitFor(() => exit !== null);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(runFiles()).toEqual([]);
  });

  it('accepts --pull and --pull=SEC and rejects out-of-range values', async () => {
    const c = run([root, '--no-open', '--port', '0', '--pull=30']);
    await waitFor(() => URL_RE.test(out));
    c.kill('SIGTERM');
    await waitFor(() => exit !== null);
    expect(exit!.code).toBe(0);
    await runToEnd([root, '--no-open', '--port', '0', '--pull=2']);
    expect(exit!.code).not.toBe(0);
    expect(err).toContain('--pull');
  });

  it('records a git commit as an agent event', async () => {
    const git = (args: string) => execSync(`git ${args}`, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init -q');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    git('add .');
    git('commit -qm first');
    const c = run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    const [, port, token] = out.match(URL_RE)!;
    await sleep(500); // let the watcher read HEAD
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
    git('add .');
    git('commit -qm "second commit"');
    const { default: WebSocket } = await import('ws');
    const msgs: { type: string; event?: { agent: string } ; events?: { agent: string }[] }[] = [];
    let found = false;
    const end = Date.now() + 10_000;
    while (!found && Date.now() < end) {
      await sleep(500);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
      msgs.length = 0;
      ws.on('message', d => msgs.push(JSON.parse(String(d))));
      ws.on('error', () => {});
      await waitFor(() => msgs.some(m => m.type === 'hello'), 5000).catch(() => {});
      ws.terminate();
      found = msgs.some(m => m.type === 'hello' && (m.events ?? []).some(e => e.agent === 'git'));
    }
    expect(found).toBe(true);
    c.kill('SIGTERM');
    await waitFor(() => exit !== null);
  }, 20_000);
});
