import type { SummaryConfig } from '../shared/summaries.js';

export interface ProviderPrompt { system: string; user: string; maxTokens: number }
export interface ProviderResult { text: string; inputTokens: number; outputTokens: number }

/** `status` is the HTTP status, or 0 for a network failure or timeout. Messages never carry keys or bodies. */
export class ProviderError extends Error {
  constructor(public status: number, public retryable: boolean, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

const SHORT: Record<number, string> = { 400: 'bad request', 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 429: 'rate limited' };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function request(cfg: SummaryConfig, p: ProviderPrompt): { url: string; headers: Record<string, string>; body: Json } {
  const base = cfg.url?.replace(/\/+$/, '');
  const json = { 'content-type': 'application/json' };
  const messages = [{ role: 'system', content: p.system }, { role: 'user', content: p.user }];
  if (cfg.provider === 'anthropic') {
    return {
      url: `${base ?? 'https://api.anthropic.com'}/v1/messages`,
      headers: { ...json, 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: { model: cfg.model, max_tokens: p.maxTokens, system: p.system, messages: [{ role: 'user', content: p.user }] },
    };
  }
  if (cfg.provider === 'openai') {
    return {
      url: `${base ?? 'https://api.openai.com'}/v1/chat/completions`,
      headers: { ...json, authorization: `Bearer ${cfg.apiKey ?? ''}` },
      body: { model: cfg.model, max_tokens: p.maxTokens, messages },
    };
  }
  return {
    url: `${base ?? 'http://127.0.0.1:11434'}/api/chat`,
    headers: json,
    body: { model: cfg.model, stream: false, messages, options: { num_predict: p.maxTokens } },
  };
}

function parse(cfg: SummaryConfig, j: Json): ProviderResult {
  if (cfg.provider === 'anthropic') {
    return { text: j?.content?.[0]?.text, inputTokens: num(j?.usage?.input_tokens), outputTokens: num(j?.usage?.output_tokens) } as ProviderResult;
  }
  if (cfg.provider === 'openai') {
    return { text: j?.choices?.[0]?.message?.content, inputTokens: num(j?.usage?.prompt_tokens), outputTokens: num(j?.usage?.completion_tokens) } as ProviderResult;
  }
  return { text: j?.message?.content, inputTokens: num(j?.prompt_eval_count), outputTokens: num(j?.eval_count) } as ProviderResult;
}

export async function callProvider(
  cfg: SummaryConfig, prompt: ProviderPrompt, fetchImpl: typeof fetch = fetch, signal?: AbortSignal,
): Promise<ProviderResult> {
  const r = request(cfg, prompt);
  let res: Response;
  try {
    res = await fetchImpl(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError(0, false, 'timeout');
    throw new ProviderError(0, true, `network error${e instanceof Error && e.name ? ` (${e.name})` : ''}`);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(res.status, retryable, SHORT[res.status] ?? (res.status >= 500 ? 'server error' : 'request failed'));
  }
  let parsed: ProviderResult;
  try {
    parsed = parse(cfg, await res.json());
  } catch {
    throw new ProviderError(res.status, false, 'invalid response');
  }
  if (typeof parsed.text !== 'string') throw new ProviderError(res.status, false, 'invalid response');
  return parsed;
}
