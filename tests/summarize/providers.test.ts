import { describe, it, expect, vi } from 'vitest';
import { callProvider, ProviderError } from '../../src/summarize/providers.js';
import type { SummaryConfig } from '../../src/shared/summaries.js';

const prompt = { system: 'SYS', user: 'USR', maxTokens: 50 };
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const mk = (res: Response | (() => Response)) => vi.fn(async (_u: string, _i?: RequestInit) => (typeof res === 'function' ? res() : res));
const anthropic: SummaryConfig = { provider: 'anthropic', apiKey: 'sk-ant', model: 'claude-haiku-5-5', monthlyTokenCap: 1 };
const openai: SummaryConfig = { provider: 'openai', apiKey: 'sk-oa', model: 'gpt-6-luna', monthlyTokenCap: 1 };
const ollama: SummaryConfig = { provider: 'ollama', model: 'llama', url: 'http://127.0.0.1:11434', monthlyTokenCap: 1 };
const call = (f: ReturnType<typeof mk>) => ({ url: f.mock.calls[0][0] as string, init: f.mock.calls[0][1] as RequestInit });

describe('callProvider', () => {
  it('anthropic: url, headers, body and parsing', async () => {
    const f = mk(ok({ content: [{ text: 'hi' }], usage: { input_tokens: 7, output_tokens: 3 } }));
    expect(await callProvider(anthropic, prompt, f as unknown as typeof fetch)).toEqual({ text: 'hi', inputTokens: 7, outputTokens: 3 });
    const { url, init } = call(f);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ model: 'claude-haiku-5-5', max_tokens: 50, system: 'SYS', messages: [{ role: 'user', content: 'USR' }] });
  });

  it('openai: url, bearer auth, body and parsing', async () => {
    const f = mk(ok({ choices: [{ message: { content: 'yo' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
    expect(await callProvider(openai, prompt, f as unknown as typeof fetch)).toEqual({ text: 'yo', inputTokens: 4, outputTokens: 2 });
    const { url, init } = call(f);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-oa' });
    expect(JSON.parse(init.body as string)).toEqual({ model: 'gpt-6-luna', max_completion_tokens: 50, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }] });
  });

  it('ollama: url, stream false, body and parsing', async () => {
    const f = mk(ok({ message: { content: 'ok' }, prompt_eval_count: 9, eval_count: 5 }));
    expect(await callProvider(ollama, prompt, f as unknown as typeof fetch)).toEqual({ text: 'ok', inputTokens: 9, outputTokens: 5 });
    const { url, init } = call(f);
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'llama', stream: false, messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }] });
  });

  it('config url overrides the base for every provider (R-P3)', async () => {
    for (const [cfg, tail] of [[anthropic, '/v1/messages'], [openai, '/v1/chat/completions'], [ollama, '/api/chat']] as const) {
      const f = mk(ok({}));
      await callProvider({ ...cfg, url: 'http://127.0.0.1:9/' }, prompt, f as unknown as typeof fetch).catch(() => undefined);
      expect(call(f).url).toBe(`http://127.0.0.1:9${tail}`);
    }
  });

  it('maps statuses to retryable and non-retryable errors without leaking keys', async () => {
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false], [401, false], [403, false]] as const) {
      const f = mk(() => new Response('sk-ant leaked body', { status }));
      const err = await callProvider(anthropic, prompt, f as unknown as typeof fetch).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ status, retryable });
      expect(err.message).not.toContain('sk-ant');
    }
  });

  it('a thrown network error is retryable with status 0', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const err = await callProvider(anthropic, prompt, f as unknown as typeof fetch).catch((e) => e);
    expect(err).toMatchObject({ status: 0, retryable: true });
  });

  it('anthropic: skips a leading thinking block and joins the text blocks', async () => {
    const f = mk(ok({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }], usage: {} }));
    expect((await callProvider(anthropic, prompt, f as unknown as typeof fetch)).text).toBe('ab');
  });

  it('an empty reply is a non-retryable error that names it, not a silent null', async () => {
    for (const [cfg, body] of [[anthropic, { content: [{ type: 'text', text: '  ' }] }], [openai, { choices: [{ message: { content: '' } }] }]] as const) {
      const err = await callProvider(cfg, prompt, mk(ok(body)) as unknown as typeof fetch).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable: false, message: 'empty response from the model' });
    }
  });

  it('an unparseable body is a non-retryable error', async () => {
    const err = await callProvider(openai, prompt, mk(ok({ nothing: 1 })) as unknown as typeof fetch).catch((e) => e);
    expect(err).toMatchObject({ retryable: false });
  });
});
