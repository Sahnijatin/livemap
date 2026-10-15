import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnce } from './build.js';
import WebSocket from 'ws';
import { IS_WIN, expectStopped, rmTree } from './helpers/platform.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist', 'cli.js');
const URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{32})/;

let root: string;
/** LIVEMAP_HOME for each test, so history and runtime files stay out of the real ~/.livemap. */
let home: string;
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
const isolated = (): NodeJS.ProcessEnv => ({ ...process.env, LIVEMAP_HOME: home });
function run(args: string[], env: NodeJS.ProcessEnv = isolated(), cwd?: string): ChildProcess {
  out = ''; err = ''; exit = null;
  const c = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd });
  c.stdout!.setEncoding('utf8').on('data', d => (out += d));
  c.stderr!.setEncoding('utf8').on('data', d => (err += d));
  c.on('exit', (code, signal) => (exit = { code, signal }));
  child = c;
  return c;
}
function getStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, res => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

beforeAll(buildOnce, 120_000);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cli-')));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-cli-home-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  child = null;
});
afterEach(async () => {
  if (child && exit === null) {
    child.kill('SIGKILL');
    await waitFor(() => exit !== null).catch(() => {});
  }
  for (const d of [root, home]) rmTree(d);
});

describe('livemap CLI', () => {
  // buildOnce runs `npm run build` from vitest, where NODE_ENV is "test": the UI must still be a production build.
  it('builds the UI and the export page for production even when NODE_ENV is set', () => {
    const assets = path.join(repo, 'dist', 'ui', 'assets');
    const bundles = [
      ...fs.readdirSync(assets).filter(f => f.endsWith('.js')).map(f => path.join(assets, f)),
      path.join(repo, 'dist', 'ui-export', 'index.html'),
    ];
    const dev = bundles.filter(f => fs.readFileSync(f, 'utf8').includes('jsxDEV'));
    expect(dev.map(f => path.relative(repo, f))).toEqual([]);
  });

  it('prints the project name and a tokened URL whose /api/health answers 200', async () => {
    run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    expect(out).toContain(`LiveMap is watching ${path.basename(root)}`);
    const [, port, token] = out.match(URL_RE)!;
    expect(await getStatus(`http://127.0.0.1:${port}/api/health?t=${token}`)).toBe(200);
    expect(await getStatus(`http://127.0.0.1:${port}/api/health`)).toBe(401);
  });

  it('sends hello over the WebSocket once indexing finishes', async () => {
    run([root, '--no-open', '--port=0']);
    await waitFor(() => URL_RE.test(out));
    const [, port, token] = out.match(URL_RE)!;
    const msgs: { type: string; files?: { path: string }[] }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
    ws.on('message', d => msgs.push(JSON.parse(String(d))));
    ws.on('error', () => {});
    try {
      await waitFor(() => msgs.some(m => m.type === 'hello'));
      const hello = msgs.find(m => m.type === 'hello')!;
      expect(hello.files!.map(f => f.path)).toEqual(['src/a.ts']);
    } finally {
      ws.terminate();
    }
  });

  it('exits 0 on SIGINT', async () => {
    const c = run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    c.kill('SIGINT');
    await waitFor(() => exit !== null);
    expectStopped(exit);
  });

  it('exits 0 when SIGINT arrives twice', async () => {
    const c = run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    c.kill('SIGINT');
    c.kill('SIGINT');
    await waitFor(() => exit !== null);
    expectStopped(exit);
  });

  it('exits 1 on an unknown flag', async () => {
    run([root, '--bogus']);
    await waitFor(() => exit !== null);
    expect(exit!.code).toBe(1);
    expect(err).toMatch(/--bogus/);
  });

  it('exits 1 when the directory does not exist', async () => {
    run([path.join(root, 'missing'), '--no-open', '--port', '0']);
    await waitFor(() => exit !== null);
    expect(exit!.code).toBe(1);
    expect(err.length).toBeGreaterThan(0);
  });

  it('exits 1 on an invalid port', async () => {
    run([root, '--no-open', '--port', 'abc']);
    await waitFor(() => exit !== null);
    expect(exit!.code).toBe(1);
  });

  it('reads --pull 30 with a space and keeps the default folder', async () => {
    const c = run(['--no-open', '--port', '0', '--pull', '30'], isolated(), root);
    await waitFor(() => URL_RE.test(out));
    expect(out).toContain(`LiveMap is watching ${path.basename(root)}`);
    c.kill('SIGTERM');
    await waitFor(() => exit !== null);
    expectStopped(exit);
  });

  it('rejects --pull 3 with the interval error', async () => {
    run(['--no-open', '--port', '0', '--pull', '3'], isolated(), root);
    await waitFor(() => exit !== null);
    expect(exit!.code).toBe(1);
    expect(err).toContain('invalid --pull interval: 3');
    expect(err).not.toContain('directory not found');
  });

  it('keeps ./30 as a folder after --pull', async () => {
    fs.mkdirSync(path.join(root, '30'));
    const c = run(['--no-open', '--port', '0', '--pull', './30'], isolated(), root);
    await waitFor(() => URL_RE.test(out));
    expect(out).toContain('LiveMap is watching 30');
    c.kill('SIGTERM');
    await waitFor(() => exit !== null);
    expectStopped(exit);
  });

  it('keeps edits and new files made while the initial index is running', async () => {
    // Enough files that the parse phase spans several indexing broadcasts.
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), `export function f${i}(x: number) { return x + ${i}; }\n`);
    run([root, '--no-open', '--port', '0']);
    await waitFor(() => URL_RE.test(out));
    const [, port, token] = out.match(URL_RE)!;
    type Msg = { type: string; done?: number; total?: number; files?: { path: string; symbols: { name: string }[] }[]; change?: { path: string } };
    const msgs: Msg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
    ws.on('message', d => msgs.push(JSON.parse(String(d))));
    ws.on('error', () => {});
    try {
      // Mid-scan: the walk is done and files are being parsed.
      await waitFor(() => msgs.some(m => m.type === 'indexing' && m.total! > 0 && m.done! < m.total!), 15_000);
      expect(msgs.some(m => m.type === 'hello')).toBe(false);
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\nexport function edited() {}\n');
      fs.writeFileSync(path.join(root, 'src', 'late.ts'), 'export function late() {}\n');
      await waitFor(() => msgs.some(m => m.type === 'hello'), 15_000);
      // The final state (hello plus any later file updates) must reflect both writes.
      const state = new Map<string, string[]>();
      const apply = (files: Msg['files']) => files!.forEach(f => state.set(f.path, f.symbols.map(s => s.name)));
      await waitFor(() => {
        state.clear();
        for (const m of msgs) if (m.type === 'hello' || m.type === 'files' || m.type === 'change') apply(m.files);
        return (state.get('src/late.ts') ?? []).includes('late') && (state.get('src/a.ts') ?? []).includes('edited');
      }, 5000);
      expect(state.get('src/a.ts')).toEqual(['a', 'edited']);
      expect(state.get('src/late.ts')).toEqual(['late']);
    } finally {
      ws.terminate();
    }
  }, 40_000);

  it('opens the browser before indexing finishes so progress is visible', async () => {
    for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), `export function f${i}(x: number) { return x + ${i}; }\n`);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-bin-'));
    const marker = path.join(bin, 'opened');
    // BROWSER names the opener on every platform, so no real browser starts (Safari, Edge) on CI.
    const opener = path.join(bin, IS_WIN ? 'opener.cmd' : 'opener');
    fs.writeFileSync(opener, IS_WIN ? `@echo off\r\n> "${marker}" echo %~1\r\n` : `#!/bin/sh\necho "$1" > "${marker}"\n`, { mode: 0o755 });
    try {
      run([root, '--port', '0'], { ...isolated(), BROWSER: opener });
      await waitFor(() => URL_RE.test(out));
      const [, port, token] = out.match(URL_RE)!;
      const msgs: { type: string }[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
      ws.on('message', d => msgs.push(JSON.parse(String(d))));
      ws.on('error', () => {});
      try {
        await waitFor(() => fs.existsSync(marker) || msgs.some(m => m.type === 'hello'), 15_000);
        // The opener must have run while the server was still indexing.
        expect(fs.existsSync(marker)).toBe(true);
        expect(msgs.some(m => m.type === 'hello')).toBe(false);
        // The opener gets a one-time launch URL, never the token (process args are readable).
        const opened = fs.readFileSync(marker, 'utf8').trim();
        expect(opened).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?launch=[0-9a-f]{32}$`));
        expect(opened).not.toContain(token);
        const res = await fetch(opened, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`/?t=${token}`);
      } finally {
        ws.terminate();
      }
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 40_000);
});
