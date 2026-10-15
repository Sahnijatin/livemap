import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOnce } from '../build.js';
import { SPECS } from '../../src/init.js';
import { normalizeHook } from '../../src/agents/normalize.js';
import { isBlockable } from '../../src/shared/blockable.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const hook = path.join(repo, 'dist', 'hook.mjs');

let home: string;
let root: string;
let servers: http.Server[];

interface Run { code: number | null; stdout: string; stderr: string; ms: number }
function runHook(args: string[], stdin: string, cwd = root, keepStdinOpen = false): Promise<Run> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [hook, ...args], { cwd, env: { ...process.env, LIVEMAP_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', d => (stdout += d));
    c.stderr.on('data', d => (stderr += d));
    c.on('error', reject);
    c.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    c.stdin.on('error', () => {});
    if (keepStdinOpen) c.stdin.write(stdin);
    else c.stdin.end(stdin);
    c.on('close', () => c.stdin.destroy());
  });
}

function writeRuntimeFile(port: number, token = 'tok', pid = process.pid): void {
  const dir = path.join(home, 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${crypto.createHash('sha1').update(root).digest('hex')}.json`), JSON.stringify({ root, port, token, pid }), { mode: 0o600 });
}

interface Seen { headers: http.IncomingHttpHeaders; body: unknown; url: string }
async function fakeServer(answer: unknown): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body), url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  servers.push(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  return { port: (s.address() as net.AddressInfo).port, seen };
}

const claudePayload = () => JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });

beforeAll(async () => {
  await buildOnce();
  if (!fs.existsSync(hook)) throw new Error('dist/hook.mjs is missing after the build');
}, 120_000);
beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hookhome-')));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lm-hookroot-')));
  servers = [];
});
afterEach(async () => {
  for (const s of servers) await new Promise(r => s.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hook bundle', () => {
  it('imports only node: built-ins', () => {
    const src = fs.readFileSync(hook, 'utf8');
    const specs = [...src.matchAll(/(?:^|[\s;])(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map(m => m[1] ?? m[2] ?? m[3]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s).toMatch(/^node:/);
  });
});

describe('blockable rules', () => {
  it('isBlockable matches normalizeHook for every agent and event init installs', () => {
    let n = 0;
    for (const spec of Object.values(SPECS)) {
      const agent = spec.hookAgent as 'claude-code' | 'codex' | 'cursor';
      for (const event of spec.events) {
        const payload = { session_id: 's1', conversation_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' }, command: 'ls' };
        expect([agent, event, isBlockable(agent, event)]).toEqual([agent, event, normalizeHook({ agent, event, payload, root, now: 1 }).blockable]);
        n++;
      }
    }
    expect(n).toBeGreaterThan(10);
    expect(isBlockable('cursor', 'beforeShellExecution')).toBe(true);
    expect(isBlockable('claude-code', 'Stop')).toBe(false);
  });
});

describe('hook: LiveMap not running (Review Focus 1)', () => {
  it('exits 0 in under 300 ms with no runtime file', async () => {
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(300);
    expect(r.stdout).toBe('');
  });

  it('exits 0 in under 2.5 s when the runtime port has no listener', async () => {
    const probe = net.createServer();
    await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise(r => probe.close(r));
    writeRuntimeFile(port);
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500);
    expect(r.stdout).toBe('');
  });

  it('exits 0 within 2.5 s when the server accepts but never answers', async () => {
    const s = http.createServer(() => { /* never respond */ });
    servers.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
    writeRuntimeFile((s.address() as net.AddressInfo).port);
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload());
    s.closeAllConnections();
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500);
    expect(r.stdout).toBe('');
  });

  it('R9: exits 0 in under 2.5 s with stdin left open and a server that never answers (one shared deadline)', async () => {
    const s = http.createServer(() => { /* never respond */ });
    servers.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
    writeRuntimeFile((s.address() as net.AddressInfo).port);
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload(), root, true);
    s.closeAllConnections();
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(2500); // the documented bound includes node startup: no extra slack
    expect(r.stdout).toBe('');
  });

  it('#22: stays under 2.5 s in the worst case with several hooks starting at once', async () => {
    const s = http.createServer(() => { /* never respond */ });
    servers.push(s);
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
    writeRuntimeFile((s.address() as net.AddressInfo).port);
    const runs = await Promise.all(Array.from({ length: 4 }, () => runHook(['claude-code', 'PreToolUse'], claudePayload(), root, true)));
    s.closeAllConnections();
    for (const r of runs) {
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(2500);
    }
  });

  it('exits 0 on malformed stdin', async () => {
    const { port, seen } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['claude-code', 'PreToolUse'], '{not json');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(seen).toHaveLength(0);
  });

  it('exits 0 when the runtime pid is dead', async () => {
    const { port, seen } = await fakeServer({ block: 'x' });
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise(r => child.on('exit', r));
    writeRuntimeFile(port, 'tok', pid);
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(0);
  });
});

describe('hook: with a server', () => {
  it('posts {agent, event, payload} with the token header to /hook', async () => {
    const { port, seen } = await fakeServer({ block: null });
    writeRuntimeFile(port, 'secret-token');
    const r = await runHook(['claude-code', 'PostToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/hook');
    expect(seen[0].headers['x-livemap-token']).toBe('secret-token');
    expect(seen[0].headers['content-type']).toMatch(/^application\/json/);
    expect(seen[0].body).toEqual({ agent: 'claude-code', event: 'PostToolUse', payload: JSON.parse(claudePayload()) });
  });

  it('claude PreToolUse exits 2 with the reason on stderr when the server blocks', async () => {
    const { port } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['claude-code', 'PreToolUse'], claudePayload());
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe('x');
    expect(r.stdout).toBe('');
  });

  it('claude PostToolUse exits 0 even when the server says block', async () => {
    const { port } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['claude-code', 'PostToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('codex Stop exits 0 even when the server says block', async () => {
    const { port } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['codex', 'Stop'], JSON.stringify({ session_id: 'c1', cwd: root, hook_event_name: 'Stop' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('codex PreToolUse exits 2 when the server blocks', async () => {
    const { port } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['codex', 'PreToolUse'], JSON.stringify({ session_id: 'c1', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(r.code).toBe(2);
    expect(r.stderr.trim()).toBe('x');
  });

  it('cursor beforeShellExecution exits 2 with a JSON deny on stdout', async () => {
    const { port } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['cursor', 'beforeShellExecution'], JSON.stringify({ conversation_id: 'k1', workspace_roots: [root], command: 'ls', cwd: '' }), os.tmpdir());
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ permission: 'deny', agent_message: 'x', user_message: 'Blocked by LiveMap' });
    expect(r.stderr.trim()).toBe('x');
  });

  it('finds the runtime from payload cwd in a subdirectory, not the process cwd', async () => {
    const { port, seen } = await fakeServer({ block: null });
    writeRuntimeFile(port);
    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    const r = await runHook(['codex', 'UserPromptSubmit'], JSON.stringify({ session_id: 'c1', cwd: sub, prompt: 'hi' }), os.tmpdir());
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('exits 0 for an unknown agent argument without posting', async () => {
    const { port, seen } = await fakeServer({ block: 'x' });
    writeRuntimeFile(port);
    const r = await runHook(['other', 'PreToolUse'], claudePayload());
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(0);
  });
});
