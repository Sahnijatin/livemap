import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectModel } from '../../src/engine/project.js';
import { Watcher } from '../../src/engine/watcher.js';
import { startServer } from '../../src/server/server.js';
import { createSettings } from '../../src/settings.js';

type Started = Awaited<ReturnType<typeof startServer>>;
let dir: string;
let srv: Started | null = null;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-settings-srv-')); });
afterEach(async () => {
  await srv?.close();
  srv = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(withSettings = true): Promise<Started> {
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const model = new ProjectModel(root);
  const settings = createSettings({ home: path.join(dir, 'home'), root, env: {}, version: '1.2.3', apply: () => undefined });
  srv = await startServer({ model, watcher: new Watcher(model), port: 0, uiDir: path.join(dir, 'ui'), ...(withSettings ? { settings } : {}) });
  return srv;
}
const call = (s: Started, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'x-livemap-token': s.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('/api/settings', () => {
  it('needs the token', async () => {
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/api/settings`)).status).toBe(401);
  });

  it('reads the settings, saves AI settings without echoing the key, and saves guardrails', async () => {
    const s = await start();
    const got = await call(s, 'GET', '/api/settings');
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ version: '1.2.3', ai: { enabled: false, active: false } });

    const saved = await call(s, 'POST', '/api/settings/ai', { enabled: true, provider: 'anthropic', apiKey: 'sk-top-secret' });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('sk-top-secret');
    expect(JSON.parse(text).ai).toMatchObject({ enabled: true, active: true, keySource: 'config' });
    expect(await (await call(s, 'GET', '/api/settings')).text()).not.toContain('sk-top-secret');

    const rules = await call(s, 'POST', '/api/settings/guardrails', { rules: [{ paths: ['db/'] }] });
    expect(rules.status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'proj', '.livemap', 'guardrails.json'))).toBe(true);
  });

  it('refuses bad input, other origins, other content types and other methods', async () => {
    const s = await start();
    const bad = await call(s, 'POST', '/api/settings/ai', { enabled: true });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'choose a provider' });
    expect((await call(s, 'POST', '/api/settings/ai', { enabled: false }, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await call(s, 'POST', '/api/settings/guardrails', { rules: [] }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call(s, 'DELETE', '/api/settings/ai')).status).toBe(405);
    expect((await call(s, 'POST', '/api/settings')).status).toBe(405);
    expect((await call(s, 'GET', '/api/settings/nope')).status).toBe(404);
  });

  it('is 404 when the server has no settings', async () => {
    const s = await start(false);
    expect((await call(s, 'GET', '/api/settings')).status).toBe(404);
  });
});
