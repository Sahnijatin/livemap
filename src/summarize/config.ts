import fs from 'node:fs';
import path from 'node:path';
import { livemapHome } from '../agents/runtime.js';
import { DEFAULT_MONTHLY_TOKEN_CAP } from '../shared/summaries.js';
import type { SummaryConfig, SummaryProvider } from '../shared/summaries.js';

export type { SummaryConfig };
export type SummaryDisabled = { disabled: true; reason: 'off' | 'no-key' | 'bad-config'; detail?: string };

export const DEFAULT_MODELS = { anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna' } as const;
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

const PROVIDERS: readonly string[] = ['anthropic', 'openai', 'ollama'];
const bad: SummaryDisabled = { disabled: true, reason: 'bad-config' };
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Summaries are opt-in (ruling R1): only `summaries.enabled: true` in `<home>/config.json` or the
 * `--summaries` flag enables them. A key in the environment alone never does.
 */
export function loadSummaryConfig(opts: { env: NodeJS.ProcessEnv; home?: string; flag?: boolean }): SummaryConfig | SummaryDisabled {
  const home = opts.home ?? livemapHome();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return bad;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad;
  const sRaw = raw.summaries;
  if (sRaw !== undefined && (!sRaw || typeof sRaw !== 'object' || Array.isArray(sRaw))) return bad;
  const s = (sRaw ?? {}) as Record<string, unknown>;

  if (!(opts.flag === true || s.enabled === true)) return { disabled: true, reason: 'off' };

  const url = str(s.url)?.replace(/\/+$/, '');
  const envKey = (name: string): string | undefined => str(opts.env[name]);
  let provider: SummaryProvider | undefined;
  if (s.provider !== undefined) {
    if (typeof s.provider !== 'string' || !PROVIDERS.includes(s.provider)) return bad;
    provider = s.provider as SummaryProvider;
  } else if (str(s.apiKey)) {
    // Never guess which provider a config key belongs to: posting it to the wrong host leaks it.
    return { disabled: true, reason: 'bad-config', detail: '"provider" is required when "apiKey" is set' };
  } else if (url) {
    // A url without a key is a local Ollama; checked before env keys so they are never sent to it.
    provider = 'ollama';
  } else if (envKey('ANTHROPIC_API_KEY')) {
    provider = 'anthropic';
  } else if (envKey('OPENAI_API_KEY')) {
    provider = 'openai';
  }
  if (!provider) return { disabled: true, reason: 'no-key' };

  let monthlyTokenCap = DEFAULT_MONTHLY_TOKEN_CAP;
  if (s.monthlyTokenCap !== undefined) {
    if (typeof s.monthlyTokenCap !== 'number' || !Number.isFinite(s.monthlyTokenCap) || s.monthlyTokenCap < 1) return bad;
    monthlyTokenCap = Math.floor(s.monthlyTokenCap);
  }

  const model = str(s.model);
  if (provider === 'ollama') {
    if (!model) return bad;
    return { provider, model, url: url ?? DEFAULT_OLLAMA_URL, monthlyTokenCap };
  }
  const apiKey = str(s.apiKey) ?? envKey(provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  if (!apiKey) return { disabled: true, reason: 'no-key' };
  return { provider, apiKey, model: model ?? DEFAULT_MODELS[provider], ...(url ? { url } : {}), monthlyTokenCap };
}
