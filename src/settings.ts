import fs from 'node:fs';
import path from 'node:path';
import { loadSummaryConfig } from './summarize/config.js';
import { atomicWrite } from './init.js';
import type { SummaryConfig, SummaryProvider } from './shared/summaries.js';
import type { AiSettings, SettingsView } from './shared/settings.js';
import { GUARDRAILS_FILE, parseGuardrails } from './agents/guardrails.js';
import type { GuardRule } from './shared/types.js';

export type SettingsResult = { ok: true; view: SettingsView } | { ok: false; error: string };

/** What the server's settings routes call. The API key goes in and never comes back out. */
export interface SettingsApi {
  view(): SettingsView;
  setAi(body: unknown): SettingsResult;
  setGuardrails(body: unknown): SettingsResult;
}

export interface SettingsOptions {
  /** The LiveMap home, which holds `config.json`. */
  home: string;
  /** The project folder, which holds `.livemap/guardrails.json`. */
  root: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** `--summaries` for this run: counts as enabled until the first save from Settings. */
  flag?: boolean;
  /** Called after the guardrails file was written, so the running rules and the UI follow at once. */
  onGuardrails?(): void;
  /** Switches the running summarizer to the saved configuration (undefined: off). */
  apply(cfg: SummaryConfig | undefined): void;
}

const PROVIDERS: readonly string[] = ['anthropic', 'openai', 'ollama'];
const MAX_FIELD = 500;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSettings(opts: SettingsOptions): SettingsApi {
  const configFile = path.join(opts.home, 'config.json');
  const guardFile = path.join(opts.root, ...GUARDRAILS_FILE.split('/'));
  let flag = opts.flag === true;

  /** The whole config file as an object ({} when missing); throws when it is not a JSON object. */
  const readConfig = (): Obj => {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`${configFile} is not valid JSON. Fix or delete it, then try again.`);
    }
    if (!isObj(raw) || (raw.summaries !== undefined && !isObj(raw.summaries))) throw new Error(`${configFile} has an unexpected shape. Fix or delete it, then try again.`);
    return raw;
  };

  const envKeyFor = (provider: string | undefined): boolean =>
    provider === 'anthropic' ? !!text(opts.env.ANTHROPIC_API_KEY) : provider === 'openai' ? !!text(opts.env.OPENAI_API_KEY) : false;

  const ai = (): AiSettings => {
    let s: Obj = {};
    let broken: string | undefined;
    try { s = (readConfig().summaries as Obj | undefined) ?? {}; } catch (e) { broken = message(e); }
    const resolved = loadSummaryConfig({ env: opts.env, home: opts.home, flag });
    const on = !('disabled' in resolved);
    const enabled = s.enabled === true || flag;
    const provider = on ? resolved.provider : PROVIDERS.includes(s.provider as string) ? (s.provider as SummaryProvider) : undefined;
    const keySource: AiSettings['keySource'] = text(s.apiKey) ? 'config' : envKeyFor(provider) ? 'env' : 'none';
    let problem = broken;
    if (!problem && enabled && !on) {
      problem = resolved.reason === 'no-key' ? 'No API key yet: add one below, or choose Ollama for a local model.'
        : resolved.detail ?? (provider === 'ollama' && !text(s.model) ? 'Ollama needs a model name.' : 'The saved settings are not valid.');
    }
    return {
      enabled, active: on, keySource,
      ...(provider ? { provider } : {}),
      ...(on ? { model: resolved.model } : text(s.model) ? { model: text(s.model) } : {}),
      ...(text(s.model) ? { savedModel: text(s.model) } : {}),
      ...(text(s.url) ? { url: text(s.url) } : {}),
      ...(typeof s.monthlyTokenCap === 'number' ? { monthlyTokenCap: s.monthlyTokenCap } : {}),
      ...(problem ? { problem } : {}),
    };
  };

  const view = (): SettingsView => ({ version: opts.version, configFile, ai: ai() });

  return {
    view,

    setAi(body: unknown): SettingsResult {
      if (!isObj(body) || typeof body.enabled !== 'boolean') return { ok: false, error: 'expected {enabled: boolean, ...}' };
      for (const k of ['provider', 'model', 'url'] as const) {
        const v = body[k];
        if (v !== undefined && (typeof v !== 'string' || v.length > MAX_FIELD)) return { ok: false, error: `"${k}" must be text of at most ${MAX_FIELD} characters` };
      }
      const provider = text(body.provider);
      if (provider && !PROVIDERS.includes(provider)) return { ok: false, error: 'the provider must be anthropic, openai or ollama' };
      const url = text(body.url)?.replace(/\/+$/, '');
      if (url) {
        let ok = false;
        try { ok = /^https?:$/.test(new URL(url).protocol); } catch { /* not a URL */ }
        if (!ok) return { ok: false, error: 'the URL must start with http:// or https://' };
      }
      const cap = body.monthlyTokenCap;
      if (cap !== undefined && cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1)) return { ok: false, error: 'the monthly token cap must be a number above 0' };
      const key = body.apiKey;
      if (key !== undefined && key !== null && (typeof key !== 'string' || key.length > MAX_FIELD)) return { ok: false, error: 'the API key must be text' };
      if (body.enabled && !provider) return { ok: false, error: 'choose a provider' };
      if (body.enabled && provider === 'ollama' && !text(body.model)) return { ok: false, error: 'Ollama needs a model name' };

      let config: Obj;
      try { config = readConfig(); } catch (e) { return { ok: false, error: message(e) }; }
      const before = (config.summaries as Obj | undefined) ?? {};
      const next: Obj = { ...before, enabled: body.enabled };
      const set = (k: string, v: unknown): void => { if (v === undefined || v === null) delete next[k]; else next[k] = v; };
      set('provider', provider);
      set('model', text(body.model));
      set('url', url);
      set('monthlyTokenCap', typeof cap === 'number' ? Math.floor(cap) : undefined);
      // A saved key belongs to the provider and address it was entered for: never send it anywhere else.
      const moved = text(before.provider) !== provider || text(before.url)?.replace(/\/+$/, '') !== url;
      if (provider === 'ollama') delete next.apiKey; // a local model takes no key
      else if (typeof key === 'string' && key.trim()) next.apiKey = key.trim();
      else if (key === null || key === '' || moved) delete next.apiKey;
      try {
        fs.mkdirSync(opts.home, { recursive: true, mode: 0o700 });
        // Through a symlink to its real file, as init writes agent configs. It can hold an API key: owner only.
        atomicWrite(configFile, `${JSON.stringify({ ...config, summaries: next }, null, 2)}\n`, 0o600);
        fs.chmodSync(fs.realpathSync.native(configFile), 0o600);
      } catch (e) {
        return { ok: false, error: `could not write ${configFile}: ${message(e)}` };
      }
      flag = false; // the saved settings now decide
      const resolved = loadSummaryConfig({ env: opts.env, home: opts.home });
      opts.apply('disabled' in resolved ? undefined : resolved);
      return { ok: true, view: view() };
    },

    setGuardrails(body: unknown): SettingsResult {
      if (!isObj(body) || !Array.isArray(body.rules)) return { ok: false, error: 'expected {rules: [...]}' };
      const parsed = parseGuardrails(JSON.stringify({ rules: body.rules }));
      if (parsed.errors.length) return { ok: false, error: parsed.errors.join('; ') };
      // The list the UI sends holds only the rules LiveMap could read. Rewriting a file that has rules it skipped
      // (or that is not valid JSON) would delete them: the user fixes the file first.
      try {
        const current = parseGuardrails(fs.readFileSync(guardFile, 'utf8').replace(/^\uFEFF/, ''));
        if (current.errors.length) return { ok: false, error: `${GUARDRAILS_FILE} has a problem (${current.errors.join('; ')}). Fix the file, then change rules here.` };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: `could not read ${GUARDRAILS_FILE}: ${message(e)}` };
      }
      // Written without the defaults, so the file stays as short as a hand-written one.
      const rules = parsed.rules.map((r: GuardRule) => ({
        ...(r.paths.length ? { paths: r.paths } : {}),
        ...(r.commands.length ? { commands: r.commands } : {}),
        action: r.action,
        ...(r.on === 'any' ? { on: r.on } : {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.enabled === false ? { enabled: false } : {}),
      }));
      try {
        atomicWrite(guardFile, `${JSON.stringify({ rules }, null, 2)}\n`);
        opts.onGuardrails?.();
      } catch (e) {
        return { ok: false, error: `could not write ${GUARDRAILS_FILE}: ${message(e)}` };
      }
      return { ok: true, view: view() };
    },
  };
}
