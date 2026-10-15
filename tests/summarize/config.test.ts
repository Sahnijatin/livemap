import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSummaryConfig } from '../../src/summarize/config.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sum-cfg-')); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const write = (v: unknown): void => fs.writeFileSync(path.join(home, 'config.json'), typeof v === 'string' ? v : JSON.stringify(v));

describe('loadSummaryConfig', () => {
  it('an env key alone never enables summaries', () => {
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'k' }, home })).toEqual({ disabled: true, reason: 'off' });
    write({ summaries: { enabled: false } });
    expect(loadSummaryConfig({ env: { OPENAI_API_KEY: 'k' }, home })).toEqual({ disabled: true, reason: 'off' });
  });

  it('config enabled plus an env key gives anthropic with defaults', () => {
    write({ summaries: { enabled: true } });
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'k' }, home })).toEqual({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5', monthlyTokenCap: 2_000_000 });
  });

  it('falls back to openai, then to ollama only with a url', () => {
    write({ summaries: { enabled: true } });
    expect(loadSummaryConfig({ env: { OPENAI_API_KEY: 'o' }, home })).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', apiKey: 'o' });
    expect(loadSummaryConfig({ env: {}, home })).toEqual({ disabled: true, reason: 'no-key' });
    write({ summaries: { enabled: true, url: 'http://box:11434/', model: 'llama' } });
    expect(loadSummaryConfig({ env: {}, home })).toEqual({ provider: 'ollama', model: 'llama', url: 'http://box:11434', monthlyTokenCap: 2_000_000 });
  });

  it('the --summaries flag enables without a config file; no key gives no-key', () => {
    expect(loadSummaryConfig({ env: {}, home, flag: true })).toEqual({ disabled: true, reason: 'no-key' });
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'k' }, home, flag: true })).toMatchObject({ provider: 'anthropic' });
  });

  it('config values win over defaults and env', () => {
    write({ summaries: { enabled: true, provider: 'openai', apiKey: 'cfg', model: 'm', url: 'http://x', monthlyTokenCap: 500 } });
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'e', OPENAI_API_KEY: 'e2' }, home })).toEqual({ provider: 'openai', apiKey: 'cfg', model: 'm', url: 'http://x', monthlyTokenCap: 500 });
  });

  it('bad JSON or bad values give bad-config', () => {
    write('{ nope');
    expect(loadSummaryConfig({ env: {}, home })).toEqual({ disabled: true, reason: 'bad-config' });
    write({ summaries: { enabled: true, provider: 'gemini' } });
    expect(loadSummaryConfig({ env: {}, home })).toEqual({ disabled: true, reason: 'bad-config' });
    write({ summaries: { enabled: true, monthlyTokenCap: -1 } });
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'k' }, home })).toEqual({ disabled: true, reason: 'bad-config' });
  });

  it('ollama without a model gives bad-config', () => {
    write({ summaries: { enabled: true, provider: 'ollama' } });
    expect(loadSummaryConfig({ env: {}, home })).toEqual({ disabled: true, reason: 'bad-config' });
  });

  it('a monthlyTokenCap below 1 or non-finite is bad-config', () => {
    for (const v of [0, 0.5, null, 'x', 1e999]) {
      write(`{"summaries":{"enabled":true,"monthlyTokenCap":${typeof v === 'string' ? '"x"' : v === 1e999 ? '1e999' : v}}}`);
      expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'k' }, home })).toEqual({ disabled: true, reason: 'bad-config' });
    }
  });

  it('a config apiKey with no provider is bad-config, so the key is never guessed onto a provider', () => {
    const want = { disabled: true, reason: 'bad-config', detail: '"provider" is required when "apiKey" is set' };
    write({ summaries: { enabled: true, apiKey: 'sk-openai-style' } });
    expect(loadSummaryConfig({ env: {}, home })).toEqual(want);
    expect(loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, home })).toEqual(want);
    write({ summaries: { enabled: true, apiKey: 'k', url: 'http://proxy' } });
    expect(loadSummaryConfig({ env: {}, home })).toEqual(want);
  });

  it('a config url with no apiKey and no provider means ollama, even with env keys set', () => {
    write({ summaries: { enabled: true, url: 'http://box:11434', model: 'llama' } });
    const got = loadSummaryConfig({ env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }, home });
    expect(got).toEqual({ provider: 'ollama', model: 'llama', url: 'http://box:11434', monthlyTokenCap: 2_000_000 });
    expect(JSON.stringify(got)).not.toMatch(/"a"|"o"/);
  });
});
