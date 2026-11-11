import type http from 'node:http';
import type { AgentHub } from '../agents/hub.js';
import { tokenMatches } from './auth.js';
import { ingestCapture, isCapture } from '../agents/capture.js';

/**
 * Hook payloads can carry large tool outputs; the hub truncates what it stores.
 * The hook forwards up to 8 MB of stdin, so the cap leaves 64 KB for the `{agent, event}` envelope.
 */
export const MAX_HOOK_BODY = 8 * 1024 * 1024 + 64 * 1024;
export const MAX_API_BODY = 64 * 1024;
const HOOK_AGENTS = new Set(['claude-code', 'codex', 'cursor']);

type Json = (status: number, body: unknown, extra?: Record<string, string>) => void;
type Read = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Reads at most `cap` bytes; past the cap it stops collecting and reports 413. */
export function readJsonBody(req: http.IncomingMessage, cap: number): Promise<Read> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) return resolve({ ok: false, status: 413, error: 'payload too large' });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (r: Read) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      resolve(r);
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        chunks.length = 0;
        return settle({ ok: false, status: 413, error: 'payload too large' });
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.once('end', () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        settle({ ok: false, status: 400, error: 'invalid JSON' });
      }
    });
    req.once('error', () => settle({ ok: false, status: 400, error: 'bad request' }));
  });
}

/** After an early reply, discard the rest of the body and close the connection. */
/** An oversized body is read and dropped up to this many bytes, for at most DRAIN_MS, before the socket is cut. */
const MAX_DRAIN = 64 * 1024 * 1024;
const DRAIN_MS = 5000;

/**
 * Answers an oversized body, then reads and drops the rest of it (nothing is kept) so the client sees
 * the status. Closing the socket while the client still sends makes the peer reset the connection,
 * and on macOS the reset discards the unread response. A body past MAX_DRAIN or DRAIN_MS is cut off.
 */
function rejectBody(req: http.IncomingMessage, res: http.ServerResponse, json: Json, status: number, error: string): void {
  json(status, { error });
  let drained = 0;
  const cut = () => { clearTimeout(timer); req.socket.destroy(); };
  const timer = setTimeout(cut, DRAIN_MS);
  timer.unref();
  req.on('data', (c: Buffer) => { drained += c.length; if (drained > MAX_DRAIN) cut(); });
  req.once('end', () => clearTimeout(timer));
  req.once('close', () => clearTimeout(timer));
  req.resume();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `POST /hook`: machine endpoint authenticated only by the `x-livemap-token` header. Takes agent hook
 * payloads (`{agent, event, payload}`) and capture events (`{source: "mcp-proxy" | "skyforge-plugin", ...}`).
 */
export async function handleHook(req: http.IncomingMessage, res: http.ServerResponse, json: Json, token: string, hub: AgentHub | undefined): Promise<void> {
  const h = req.headers['x-livemap-token'];
  if (!tokenMatches(token, Array.isArray(h) ? h[0] : h)) return json(401, { error: 'unauthorized' });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, { allow: 'POST' });
  if (!hub) return json(503, { error: 'agent activity is not available' });
  const body = await readJsonBody(req, MAX_HOOK_BODY);
  if (!body.ok) return body.status === 413 ? rejectBody(req, res, json, 413, body.error) : json(body.status, { error: body.error });
  const v = body.value;
  // A tool call or session text captured by `livemap mcp-proxy` or the SkyForge plugin: recorded only, never blocked.
  if (isCapture(v)) {
    try { ingestCapture(hub, v); } catch { /* a bad capture must not fail the sender */ }
    return json(200, { block: null });
  }
  if (!isObj(v) || typeof v.agent !== 'string' || !HOOK_AGENTS.has(v.agent) || typeof v.event !== 'string' || !v.event) {
    return json(400, { error: 'expected {agent, event, payload}' });
  }
  // A hook that already gave up (its 2 s budget) cannot be blocked: record only, keep flags queued.
  const result = hub.ingestHook(v.agent as 'claude-code' | 'codex' | 'cursor', v.event, v.payload, Date.now(), { canBlock: !req.socket.destroyed, settle: true, followup: v.followup === true });
  // A block that never reaches the hook did not stop the tool: the hub undoes it (flags, blocked marks).
  const settle = result.settle;
  if (settle) {
    res.once('finish', () => settle(true));
    res.once('close', () => settle(res.writableFinished));
  }
  json(200, result.followup ? { block: result.block, followup: result.followup } : { block: result.block });
}

const isJsonType = (req: http.IncomingMessage): boolean =>
  /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''));

/**
 * `/api/control`, `/api/flags`, `/api/flags/:id`, `/api/pause` for an already authenticated request.
 * Returns false when the path is not one of them.
 */
export async function handleControlApi(
  req: http.IncomingMessage, res: http.ServerResponse, json: Json, pathname: string, hub: AgentHub | undefined, sameOrigin: boolean,
): Promise<boolean> {
  const flagId = /^\/api\/flags\/([^/]+)$/.exec(pathname);
  const route = pathname === '/api/control' ? 'control' : pathname === '/api/flags' ? 'flags' : pathname === '/api/pause' ? 'pause' : flagId ? 'flag' : null;
  if (!route) return false;
  const allowed = route === 'control' ? 'GET, HEAD' : route === 'flag' ? 'DELETE' : 'POST';
  if (!allowed.split(', ').includes(req.method ?? '')) {
    json(405, { error: 'method not allowed' }, { allow: allowed });
    return true;
  }
  if (!hub) {
    json(503, { error: 'agent activity is not available' });
    return true;
  }
  const control = hub.control;
  if (route === 'control') {
    json(200, control.state());
    return true;
  }
  // State changes: refuse cross-site requests (simple form posts cannot send application/json).
  if (!sameOrigin) {
    json(403, { error: 'forbidden origin' });
    return true;
  }
  if (!isJsonType(req)) {
    json(415, { error: 'expected application/json' });
    return true;
  }
  if (route === 'flag') {
    const id = Number(flagId![1]);
    if (!Number.isInteger(id) || !control.removeFlag(id)) json(404, { error: 'not found' });
    else json(200, control.state());
    return true;
  }
  const body = await readJsonBody(req, MAX_API_BODY);
  if (!body.ok) {
    if (body.status === 413) rejectBody(req, res, json, 413, body.error);
    else json(body.status, { error: body.error });
    return true;
  }
  const v = body.value;
  if (route === 'pause') {
    if (!isObj(v) || typeof v.paused !== 'boolean') json(400, { error: 'expected {paused: boolean}' });
    else {
      control.setPaused(v.paused);
      json(200, control.state());
    }
    return true;
  }
  const target = isObj(v) ? (v.target ?? null) : undefined;
  if (!isObj(v) || typeof v.note !== 'string' || (target !== null && typeof target !== 'string')) {
    json(400, { error: 'expected {target, note}' });
    return true;
  }
  try {
    if (v.kind !== undefined && v.kind !== 'message') throw new Error('unknown kind');
    json(201, control.addFlag(target === '' ? null : (target as string | null), v.note, Date.now(), v.kind === 'message' ? 'message' : undefined));
  } catch (e) {
    json(400, { error: e instanceof Error ? e.message : 'invalid flag' });
  }
  return true;
}
