import type { Flag, GuardRule } from '@shared/types.js';
import type { SettingsView } from '@shared/settings.js';
import { authHeaders } from './connection';

/**
 * State-changing calls to the local server, authenticated by the x-livemap-token header; every
 * request sends `content-type: application/json` (the server refuses anything else). Throws an Error
 * with a readable message on a network failure or a non-2xx reply.
 */
/** A failed request; `status` is the HTTP status, or 0 when the server was not reachable. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('LiveMap is not reachable. Is it still running?', 0);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === 'string') detail = j.error;
    } catch {
      // Not JSON: fall back to the status.
    }
    const text = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : `Request failed (${res.status})`;
    throw new ApiError(text, res.status);
  }
  return res;
}

export async function addFlag(target: string | null, note: string): Promise<Flag> {
  const res = await request('POST', '/api/flags', { target, note });
  return (await res.json()) as Flag;
}

export async function removeFlag(id: number): Promise<void> {
  await request('DELETE', `/api/flags/${id}`);
}

export async function setPaused(paused: boolean): Promise<void> {
  await request('POST', '/api/pause', { paused });
}

export async function getSettings(): Promise<SettingsView> {
  return (await (await request('GET', '/api/settings')).json()) as SettingsView;
}

/** `apiKey`: text sets it, null removes the saved one, absent keeps it. The reply never holds the key. */
export async function saveAiSettings(ai: { enabled: boolean; provider: string; model?: string; url?: string; monthlyTokenCap?: number; apiKey?: string | null }): Promise<SettingsView> {
  return (await (await request('POST', '/api/settings/ai', ai)).json()) as SettingsView;
}

export async function saveGuardrails(rules: GuardRule[]): Promise<void> {
  await request('POST', '/api/settings/guardrails', { rules });
}
