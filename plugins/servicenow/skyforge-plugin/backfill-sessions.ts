/**
 * `livemap sn backfill-sessions --since DATE [--url URL] [--dry-run]`: reads past SkyForge sessions from its
 * local API (read-only GETs: `/api/analytics/sessions`, `/session/{id}/message`) and sends their nexus tool
 * calls, prompts and assistant text to the running `livemap sn` with their real times. Work done before the
 * plugin was installed then counts for attribution.
 */
import { buildCapture, buildText, MAX_PARSED_RESULT, needsResult, SessionContext, type CaptureEvent, type TextEvent } from '../../../src/proxy/capture.js';
import { HookPoster, isServiceNowRun, liveRuntimes } from '../../../src/proxy/poster.js';
import { baseToolName, toolServer } from '../../../src/shared/tools.js';

export const DEFAULT_SKYFORGE_URL = 'http://127.0.0.1:4096';
export const BACKFILL_USAGE = 'Usage: livemap sn backfill-sessions --since DATE [--url URL] [--dry-run]';
const REQUEST_TIMEOUT_MS = 15_000;

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface BackfillArgs { since: number; url: string; dryRun: boolean }

/** A date (`2026-10-01`) or date-time (`2026-10-01T09:00`, local time unless it says otherwise). */
export function parseSince(v: string): number | undefined {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  return Number.isFinite(t) ? t : undefined;
}

export function parseBackfillArgs(argv: string[], onError: (m: string) => never): BackfillArgs {
  let since: number | undefined;
  let url = DEFAULT_SKYFORGE_URL;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const take = () => { const v = inline ?? argv[++i]; return v === undefined || (inline === undefined && v.startsWith('--')) ? onError(`${flag} needs a value`) : v; };
    if (flag === '--since') { const v = take(); since = parseSince(v); if (since === undefined) onError(`invalid --since date: ${v}`); }
    else if (flag === '--url') { url = take().replace(/\/+$/, ''); try { new URL(url); } catch { onError(`invalid --url: ${url}`); } }
    else if (a === '--dry-run') dryRun = true;
    else onError(`unknown option: ${a}`);
  }
  if (since === undefined) onError('--since is required (a date like 2026-10-01)');
  return { since: since as number, url, dryRun };
}

export interface SessionRef { id: string; instance?: string; source?: string }

/** Sessions from `/api/analytics/sessions`: an array, or one under `sessions` or `data`. MCP sessions are left out. */
export function sessionsOf(body: unknown): SessionRef[] {
  const list = Array.isArray(body) ? body : Array.isArray(rec(body).sessions) ? rec(body).sessions as unknown[] : Array.isArray(rec(body).data) ? rec(body).data as unknown[] : [];
  const out: SessionRef[] = [];
  for (const x of list) {
    const o = rec(x);
    const id = str(o.id) ?? str(o.sessionID) ?? str(o.session_id);
    if (!id) continue;
    const source = str(o.source);
    // MCP sessions are desktop clients' calls (the proxy's job) and LiveMap's own reads: no TUI messages.
    if (source === 'mcp') continue;
    out.push({ id, ...(str(o.instance) ? { instance: str(o.instance) } : {}), ...(source ? { source } : {}) });
  }
  return out;
}

const isNexusTool = (name: string): boolean => toolServer(name) === 'nexus' || /^(sn_|tool_execute$)/.test(baseToolName(name));

/**
 * The events in one session's messages (`[{info, parts}]`) from `since` on: each finished nexus tool call, each
 * prompt (user text), and each finished piece of assistant text, in time order.
 */
export function sessionEvents(sessionId: string, messages: unknown, since: number, instance?: string): Array<CaptureEvent | TextEvent> {
  const out: Array<CaptureEvent | TextEvent> = [];
  const ctx = new SessionContext(instance);
  const list = Array.isArray(messages) ? messages : [];
  const items: { at: number; build: () => CaptureEvent | TextEvent | undefined }[] = [];
  for (const m of list) {
    const info = rec(rec(m).info);
    const parts = Array.isArray(rec(m).parts) ? rec(m).parts as unknown[] : [];
    const role = str(info.role);
    const created = num(rec(info.time).created) ?? 0;
    if (role === 'user') {
      const text = parts.map(rec).filter((p) => p.type === 'text' && !p.synthetic && !p.ignored).map((p) => str(p.text) ?? '').join('\n');
      if (created >= since) items.push({ at: created, build: () => buildText('prompt', sessionId, created, text) });
      continue;
    }
    for (const raw of parts) {
      const p = rec(raw);
      if (p.type === 'text' && !p.synthetic) {
        const end = num(rec(p.time).end);
        if (end !== undefined && end >= since) items.push({ at: end, build: () => buildText('message', sessionId, end, str(p.text)) });
        continue;
      }
      if (p.type !== 'tool') continue;
      const name = str(p.tool);
      const st = rec(p.state);
      const start = num(rec(st.time).start);
      const end = num(rec(st.time).end);
      if (!name || !isNexusTool(name) || (st.status !== 'completed' && st.status !== 'error') || start === undefined || start < since) continue;
      const args = st.input ?? {};
      const callId = str(p.callID) ?? str(p.id) ?? `${sessionId}:${start}`;
      items.push({
        at: start,
        build: () => {
          if (st.status === 'error') return buildCapture({ source: 'skyforge-plugin', client: { name: 'skyforge' }, sessionId, callId, name, args, rpcError: { message: str(st.error) ?? 'error' }, start, end: end ?? start }, ctx);
          const text = typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? '');
          const skipResult = text.length > MAX_PARSED_RESULT || !needsResult(name, args);
          return buildCapture({ source: 'skyforge-plugin', client: { name: 'skyforge' }, sessionId, callId, name, args, result: { content: [{ type: 'text', text }] }, skipResult, start, end: end ?? start }, ctx);
        },
      });
    }
  }
  // Built in time order, so the session's update set and user are learned the way they happened.
  items.sort((a, b) => a.at - b.at);
  for (const it of items) { const e = it.build(); if (e) out.push(e); }
  return out;
}

async function getJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface BackfillResult { sessions: number; calls: number; prompts: number; messages: number; sent: number }

/** Reads the sessions and sends their events. `send` is the delivery (a poster to the running LiveMap). */
export async function backfillSessions(args: BackfillArgs, send: (e: CaptureEvent | TextEvent) => void, get: (url: string) => Promise<unknown> = getJson): Promise<BackfillResult> {
  let refs: SessionRef[];
  try {
    refs = sessionsOf(await get(`${args.url}/api/analytics/sessions`));
  } catch {
    // An older build without analytics: every session, with no instance.
    refs = sessionsOf(await get(`${args.url}/session`));
  }
  const r: BackfillResult = { sessions: 0, calls: 0, prompts: 0, messages: 0, sent: 0 };
  for (const ref of refs) {
    let messages: unknown;
    try { messages = await get(`${args.url}/session/${encodeURIComponent(ref.id)}/message`); } catch { continue; }
    const events = sessionEvents(ref.id, messages, args.since, ref.instance);
    if (!events.length) continue;
    r.sessions++;
    for (const e of events) {
      if ('kind' in e) { if (e.kind === 'prompt') r.prompts++; else if (e.kind === 'message') r.messages++; } else r.calls++;
      send(e);
      r.sent++;
    }
  }
  return r;
}

export async function runBackfillSessions(argv: string[]): Promise<void> {
  const fail = (m: string): never => { process.stderr.write(`livemap sn backfill-sessions: ${m}\n${BACKFILL_USAGE}\n`); process.exit(1); };
  const args = parseBackfillArgs(argv, fail);
  const say = (l: string) => process.stdout.write(`${l}\n`);
  const runs = liveRuntimes().filter(isServiceNowRun);
  if (!runs.length && !args.dryRun) fail('no running livemap sn was found. Start it first, then run this again.');
  const poster = new HookPoster({ queueMax: Number.MAX_SAFE_INTEGER, timeoutMs: 5000 });
  const send = args.dryRun ? () => {} : (e: unknown) => poster.send(e);
  let r: BackfillResult;
  try {
    r = await backfillSessions(args, send);
  } catch (e) {
    fail(`could not read SkyForge at ${args.url} (${(e as Error).message}). Is SkyForge running?`);
  }
  await poster.flushed();
  const since = new Date(args.since).toISOString().slice(0, 10);
  say(`Read ${r!.sessions} SkyForge sessions with activity since ${since}: ${r!.calls} tool calls, ${r!.prompts} prompts, ${r!.messages} messages.`);
  say(args.dryRun ? 'Dry run: nothing was sent.' : `Sent ${r!.sent} events to LiveMap (${runs.map((x) => x.root).join(', ')}).`);
}
