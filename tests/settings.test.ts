import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettings, type SettingsApi } from '../src/settings.js';
import { SwitchableSummarizer, AI_OFF, type Engine } from '../src/summarize/switch.js';
import { parseGuardrails, Guardrails, GUARDRAILS_FILE } from '../src/agents/guardrails.js';
import type { SummaryConfig, SummaryStatus } from '../src/shared/summaries.js';

let dir: string, home: string, root: string;
let applied: (SummaryConfig | undefined)[];
const make = (env: NodeJS.ProcessEnv = {}, flag = false): SettingsApi =>
  createSettings({ home, root, env, version: '9.9.9', flag, apply: cfg => { applied.push(cfg); } });
const config = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-settings-'));
  home = path.join(dir, 'home'); root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  applied = [];
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('settings: AI', () => {
  it('starts off, with nothing saved', () => {
    const v = make().view();
    expect(v.version).toBe('9.9.9');
    expect(v.ai).toEqual({ enabled: false, active: false, keySource: 'none' });
  });

  it('saves a provider and key, applies it at once, and never returns the key', () => {
    const s = make();
    const r = s.setAi({ enabled: true, provider: 'anthropic', apiKey: ' sk-secret ' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    expect(r.ok && r.view.ai).toMatchObject({ enabled: true, active: true, provider: 'anthropic', keySource: 'config' });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ provider: 'anthropic', apiKey: 'sk-secret' });
    expect(config().summaries).toEqual({ enabled: true, provider: 'anthropic', apiKey: 'sk-secret' });
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps the saved key when a later save sends none, and keeps other config keys', () => {
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ other: 1, summaries: { enabled: true, provider: 'openai', apiKey: 'k1' } }));
    const s = make();
    expect(s.setAi({ enabled: false, provider: 'openai', model: 'm' }).ok).toBe(true);
    expect(config()).toEqual({ other: 1, summaries: { enabled: false, provider: 'openai', apiKey: 'k1', model: 'm' } });
    expect(applied).toEqual([undefined]);
  });

  it('drops the saved key when the provider or address changes, so it is never sent elsewhere', () => {
    const s = make();
    s.setAi({ enabled: true, provider: 'openai', apiKey: 'k1' });
    const r = s.setAi({ enabled: true, provider: 'openai', url: 'https://proxy.example/v1/' });
    expect(config().summaries).toEqual({ enabled: true, provider: 'openai', url: 'https://proxy.example/v1' });
    expect(r.ok && r.view.ai).toMatchObject({ enabled: true, active: false, keySource: 'none' });
    expect(r.ok && r.view.ai.problem).toMatch(/No API key/);
    expect(applied.at(-1)).toBeUndefined();
    s.setAi({ enabled: true, provider: 'anthropic', apiKey: 'k2' });
    s.setAi({ enabled: true, provider: 'anthropic', apiKey: null });
    expect(config().summaries.apiKey).toBeUndefined();
  });

  it('uses a key from the environment and says so', () => {
    const r = make({ ANTHROPIC_API_KEY: 'envkey' }).setAi({ enabled: true, provider: 'anthropic' });
    expect(r.ok && r.view.ai).toMatchObject({ active: true, keySource: 'env' });
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).not.toContain('envkey');
  });

  it('a local Ollama needs a model and no key', () => {
    const s = make();
    expect(s.setAi({ enabled: true, provider: 'ollama' })).toEqual({ ok: false, error: 'Ollama needs a model name' });
    const r = s.setAi({ enabled: true, provider: 'ollama', model: 'llama3', apiKey: 'ignored' });
    expect(r.ok && r.view.ai).toMatchObject({ active: true, provider: 'ollama', model: 'llama3', keySource: 'none' });
    expect(config().summaries.apiKey).toBeUndefined();
  });

  it('refuses bad input and writes nothing', () => {
    const s = make();
    expect(s.setAi({ enabled: 'yes' }).ok).toBe(false);
    expect(s.setAi({ enabled: true }).ok).toBe(false);
    expect(s.setAi({ enabled: true, provider: 'acme' }).ok).toBe(false);
    expect(s.setAi({ enabled: true, provider: 'openai', url: 'file:///etc' }).ok).toBe(false);
    expect(s.setAi({ enabled: true, provider: 'openai', monthlyTokenCap: 0 }).ok).toBe(false);
    expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
    expect(applied).toEqual([]);
  });

  it('never overwrites a config file it cannot read as JSON', () => {
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.json'), '{broken');
    const s = make();
    const r = s.setAi({ enabled: true, provider: 'anthropic', apiKey: 'k' });
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).toBe('{broken');
    expect(s.view().ai.problem).toMatch(/not valid JSON/);
  });

  it('--summaries counts as enabled until the first save', () => {
    const s = make({ OPENAI_API_KEY: 'e' }, true);
    expect(s.view().ai).toMatchObject({ enabled: true, active: true, provider: 'openai' });
    const r = s.setAi({ enabled: false, provider: 'openai' });
    expect(r.ok && r.view.ai).toMatchObject({ enabled: false, active: false });
  });
});

describe('settings: guardrails', () => {
  it('writes valid rules without their defaults, and the store picks them up', () => {
    const s = make();
    const r = s.setGuardrails({ rules: [{ paths: ['db/'], action: 'block', on: 'write', commands: [] }, { commands: ['git push'], action: 'pause', enabled: false }] });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, GUARDRAILS_FILE), 'utf8'))).toEqual({
      rules: [{ paths: ['db/'], action: 'block' }, { commands: ['git push'], action: 'pause', enabled: false }],
    });
    const g = new Guardrails(root);
    expect(g.check({ tool: 'Bash', paths: [], command: 'git push', access: 'write' }, { agent: 'codex', sessionId: 's' }, 1)).toBeNull();
    expect(g.check({ tool: 'Edit', paths: ['db/a.sql'], access: 'write' }, { agent: 'codex', sessionId: 's' }, 1)?.block).toMatch(/guardrail/);
  });
  it('refuses invalid rules and leaves the file alone', () => {
    const s = make();
    s.setGuardrails({ rules: [{ paths: ['a'] }] });
    const before = fs.readFileSync(path.join(root, GUARDRAILS_FILE), 'utf8');
    expect(s.setGuardrails({ rules: [{ action: 'block' }] })).toEqual({ ok: false, error: 'rule 1: needs "paths" or "commands"' });
    expect(s.setGuardrails({ rules: 'x' }).ok).toBe(false);
    expect(fs.readFileSync(path.join(root, GUARDRAILS_FILE), 'utf8')).toBe(before);
  });
  it('a rule keeps enabled: false through parsing, and only a boolean is accepted', () => {
    expect(parseGuardrails(JSON.stringify({ rules: [{ paths: ['a'], enabled: false }, { paths: ['b'], enabled: true }] })).rules.map(r => r.enabled)).toEqual([false, undefined]);
    expect(parseGuardrails(JSON.stringify({ rules: [{ paths: ['a'], enabled: 'no' }] })).errors).toEqual(['rule 1: "enabled" must be true or false']);
  });
});

describe('SwitchableSummarizer', () => {
  const fake = (cfg: SummaryConfig) => {
    const listeners = new Set<(s: SummaryStatus) => void>();
    const e = {
      stopped: false,
      status: (): SummaryStatus => ({ state: 'ready', provider: cfg.provider, model: cfg.model, usedTokens: 0, capTokens: 1, month: 'm' }),
      summarizeFile: async () => `file by ${cfg.model}`,
      summarizeChange: async () => `change by ${cfg.model}`,
      ask: async () => ({ answer: cfg.model }),
      stop() { e.stopped = true; },
      on: (_: 'status', l: (s: SummaryStatus) => void) => { listeners.add(l); },
      off: (_: 'status', l: (s: SummaryStatus) => void) => { listeners.delete(l); },
      fire: () => { for (const l of listeners) l(e.status()); },
    };
    return e;
  };
  const cfg = (model: string): SummaryConfig => ({ provider: 'ollama', model, monthlyTokenCap: 1 });

  it('is off until given a configuration, then answers through it, and switches without a restart', async () => {
    const made: ReturnType<typeof fake>[] = [];
    const sw = new SwitchableSummarizer(c => { const e = fake(c); made.push(e); return e as unknown as Engine; });
    const seen: string[] = [];
    sw.on('status', (s: SummaryStatus) => seen.push(s.state));
    expect(sw.status().state).toBe('off');
    expect(await sw.summarizeFile({} as never, '')).toBeNull();
    expect(await sw.ask('q', 'c')).toEqual({ error: AI_OFF });
    sw.set(cfg('a'));
    expect(sw.status()).toMatchObject({ state: 'ready', model: 'a' });
    expect(await sw.ask('q', 'c')).toEqual({ answer: 'a' });
    sw.set(cfg('b'));
    expect(made[0].stopped).toBe(true);
    made[0].fire(); // the replaced engine no longer reports
    made[1].fire();
    sw.set(undefined);
    expect(made[1].stopped).toBe(true);
    expect(seen).toEqual(['ready', 'ready', 'ready', 'off']);
  });
});
