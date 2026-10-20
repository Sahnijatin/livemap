import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildOnce } from '../build.js';
import { rmTree } from '../helpers/platform.js';
import { startMockUpstream, type MockUpstream } from '../helpers/mock-upstream.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repo, 'dist', 'cli.js');

let up: MockUpstream;
let home: string;
let hook: http.Server;
const bodies: Record<string, unknown>[] = [];

beforeAll(async () => {
  await buildOnce();
  up = await startMockUpstream();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-proxy-home-'));
  hook = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers['x-livemap-token'] === 'tok') bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"block":null}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  const run = path.join(home, 'run');
  fs.mkdirSync(run, { recursive: true });
  // The run file of a `livemap sn` on some project: this test process stands in for it (its pid is alive).
  fs.writeFileSync(path.join(run, 'a.json'), JSON.stringify({ root: path.join(home, 'proj', '.livemap', 'sn'), port: (hook.address() as AddressInfo).port, token: 'tok', pid: process.pid }));
}, 180_000);

afterAll(async () => {
  await up?.close();
  await new Promise<void>((r) => (hook ? hook.close(() => r()) : r()));
  if (home) rmTree(home);
});

describe('livemap mcp-proxy (built CLI, as a desktop client launches it)', () => {
  it('serves the upstream over stdio and reports the call to LiveMap', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp-proxy', '--upstream', up.url, '--header', 'X-SN-Instance=devtest'],
      env: { ...process.env, LIVEMAP_HOME: home } as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    const client = new Client({ name: 'desktop-test', version: '1.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const r = await client.callTool({ name: 'sn_record_manage', arguments: { action: 'update', table: 'sys_script', sys_id: 'c'.repeat(32), token: 'abc' } });
    expect(r.isError).toBeFalsy();
    const t = Date.now();
    while (!bodies.length && Date.now() - t < 5000) await new Promise((res) => setTimeout(res, 20));
    expect(bodies[0]).toMatchObject({ source: 'mcp-proxy', tool: 'sn_record_manage', instance: 'devtest', ok: true, args: { token: '[redacted]' } });
    await client.close();
    expect(stderr).toBe('');
  }, 30_000);
});
