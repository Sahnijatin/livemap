/**
 * Turns one MCP tool call into the capture event LiveMap's `/hook` takes (`source: "mcp-proxy"`). Pure: no
 * Node built-ins, so the SkyForge plugin can share the same rules. Values are redacted here, before
 * anything leaves the proxy.
 */
import { classifyTool, resultSysIds, type RecordTarget } from '../shared/tools.js';

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export const REDACTED = '[redacted]';
/** Keys whose values never leave the proxy: exact names, and names ending in them (`refresh_token`, `db_password`). */
const SECRET_KEY = /(^|[_-])(password2?|passwd|token|secret|client_secret|authorization|api[_-]?key|apikey|private[_-]?key|credentials?)$/i;
/** Keys that hold headers: every value under them is redacted. */
const HEADER_KEYS = /^(headers?|http_headers|request_headers)$/i;
/** Tables whose records hold credentials or secret settings: a call on them keeps arg names only. */
const SECRET_TABLE = /^(sys_auth_profile.*|oauth_entity.*|discovery_credentials|sys_properties)$/i;
const MAX_DEPTH = 32;
const MAX_ERROR = 300;

export const isSecretKey = (k: string): boolean => SECRET_KEY.test(k);
export const isSecretTable = (t: string | undefined): boolean => !!t && SECRET_TABLE.test(t);

/** A deep copy with secret values replaced; header objects lose every value. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Obj = {};
  for (const [k, x] of Object.entries(v as Obj)) {
    if (isSecretKey(k)) out[k] = REDACTED;
    else if (HEADER_KEYS.test(k)) out[k] = namesOnly(x);
    else out[k] = redact(x, depth + 1);
  }
  return out;
}

/** The same shape with every leaf value replaced: arg names survive, values do not. */
export function namesOnly(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => namesOnly(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) out[k] = namesOnly(x, depth + 1);
    return out;
  }
  return REDACTED;
}

/** `key=value` and `key: value` pairs in free text with a secret key lose their value. */
export function redactText(s: string): string {
  return s.replace(/\b([\w-]*(?:password2?|passwd|token|secret|authorization|api[_-]?key|apikey))(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi, `$1$2${REDACTED}`);
}

/** Arg names only, for debug logs: top-level keys, and the inner tool's keys for a gateway call. */
export function argNames(args: unknown): string[] {
  const o = rec(args);
  const keys = Object.keys(o);
  const inner = rec(o.args);
  return Object.keys(inner).length ? [...keys, ...Object.keys(inner).map((k) => `args.${k}`)] : keys;
}

/** The redacted args of a call: names only when it touches a secret table. */
export function safeArgs(name: string, args: unknown): unknown {
  const c = classifyTool(name, args);
  const a = rec(c.args);
  const table = str(a.table) ?? str(a.table_name) ?? str(a.tableName);
  return isSecretTable(table) || c.targets.some((t) => isSecretTable(t.table)) ? namesOnly(args) : redact(args);
}

/**
 * The payload of an MCP `tools/call` result: `structuredContent` when there is one, else the first text
 * content parsed as JSON (or the text itself).
 */
export function resultPayload(result: unknown): unknown {
  const r = rec(result);
  if (r.structuredContent !== undefined) return r.structuredContent;
  const content = Array.isArray(r.content) ? r.content : [];
  for (const c of content) {
    const t = rec(c);
    if (t.type !== 'text' || typeof t.text !== 'string') continue;
    const s = t.text.trimStart();
    if (s.startsWith('{') || s.startsWith('[')) { try { return JSON.parse(s); } catch { return t.text; } }
    return t.text;
  }
  return undefined;
}

/** Whether a call failed, and its message: an MCP error result, a JSON-RPC error, or `{success: false}`. */
export function outcome(result: unknown, rpcError?: unknown): { ok: boolean; error?: string } {
  const cut = (s: string) => redactText(s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s);
  if (rpcError !== undefined) return { ok: false, error: cut(str(rec(rpcError).message) ?? 'error') };
  const r = rec(result);
  const payload = resultPayload(result);
  const p = rec(payload);
  if (r.isError === true || p.success === false) {
    const msg = str(p.error) ?? str(rec(p.error).message) ?? str(p.message) ?? (typeof payload === 'string' ? payload : undefined) ?? 'error';
    return { ok: false, error: cut(msg) };
  }
  return { ok: true };
}

export interface UpdateSetRef { sysId?: string; name?: string }
export interface ClientInfo { name: string; version?: string }

/** The body posted to `/hook` for one tool call. Times are epoch ms on this machine. */
export interface CaptureEvent {
  source: 'mcp-proxy' | 'skyforge-plugin';
  client?: ClientInfo;
  sessionId: string;
  callId: string;
  /** The called tool's base name (`tool_execute` for a gateway call). */
  tool: string;
  innerTool?: string;
  args: unknown;
  targets: RecordTarget[];
  resultSysIds: string[];
  updateSet?: UpdateSetRef;
  /** The ServiceNow user the session acts as, once known. */
  user?: string;
  instance?: string;
  start: number;
  end: number;
  ok: boolean;
  error?: string;
  /** LiveMap's own session: recorded nowhere, never agent work. */
  own?: boolean;
}

/** Actions of `sn_update_set_manage` that make an update set the current one. */
const SETS_CURRENT = new Set(['create', 'set_current', 'set', 'switch', 'use', 'change', 'select', 'make_current', 'activate']);
const USER_KEYS = ['user_name', 'username', 'userName', 'user_id', 'user'];

function userOf(payload: unknown): string | undefined {
  for (const o of [rec(payload), rec(rec(payload).data), rec(rec(rec(payload).result).data), rec(rec(rec(payload).data).user)]) {
    for (const k of USER_KEYS) {
      const v = o[k];
      const s = str(v) ?? str(rec(v).value) ?? str(rec(v).user_name);
      if (s && !/^[0-9a-f]{32}$/i.test(s)) return s;
    }
  }
  return undefined;
}

/**
 * What a session has said about itself so far: its instance, its ServiceNow user (from `sn_session_context`
 * or `sn_get_instance_info` results), and the update set it made current (from `sn_update_set_manage`).
 */
export class SessionContext {
  instance?: string;
  user?: string;
  updateSet?: UpdateSetRef;

  constructor(instance?: string) {
    if (instance) this.instance = instance;
  }

  /** Learns from one finished call; `real` is the inner tool of a gateway call. */
  learn(real: string, args: unknown, payload: unknown, ok: boolean): void {
    if (!ok) return;
    if (real === 'sn_session_context' || real === 'sn_get_instance_info') {
      const u = userOf(payload);
      if (u) this.user = u;
      const inst = str(rec(rec(payload).data).instance_name) ?? str(rec(payload).instance_name);
      if (inst && !this.instance) this.instance = inst;
      return;
    }
    if (real !== 'sn_update_set_manage') return;
    const a = rec(args);
    const action = str(a.action)?.toLowerCase();
    if (!action || !SETS_CURRENT.has(action)) return;
    const name = str(a.name) ?? str(a.update_set) ?? str(a.update_set_name);
    const ids = resultSysIds(payload);
    const sysId = str(a.sys_id) ?? str(a.update_set_id) ?? ids[0];
    if (!name && !sysId) return;
    this.updateSet = { ...(sysId ? { sysId } : {}), ...(name ? { name } : {}) };
  }
}

export interface CallInput {
  source?: CaptureEvent['source'];
  client?: ClientInfo;
  sessionId: string;
  callId: string;
  /** The tool name as called, prefixes and all. */
  name: string;
  args: unknown;
  /** The MCP result (`{content, structuredContent, isError}`), or undefined when the call errored or was cancelled. */
  result?: unknown;
  rpcError?: unknown;
  /** Set for a cancelled call. */
  cancelled?: boolean;
  start: number;
  end: number;
  own?: boolean;
}

/** Builds the capture event for a finished call and updates the session's context from it. */
export function buildCapture(call: CallInput, ctx: SessionContext): CaptureEvent {
  const payload = call.result === undefined ? undefined : resultPayload(call.result);
  const res = call.cancelled ? { ok: false, error: 'cancelled' } : outcome(call.result, call.rpcError);
  const c = classifyTool(call.name, call.args, payload === undefined ? {} : { output: payload, ...(ctx.instance ? { instance: ctx.instance } : {}) });
  const real = c.inner ?? c.name;
  ctx.learn(real, c.args, payload, res.ok);
  if (ctx.instance) for (const t of c.targets) if (!t.instance) t.instance = ctx.instance;
  const ids = payload === undefined ? [] : resultSysIds(payload);
  const ev: CaptureEvent = {
    source: call.source ?? 'mcp-proxy',
    sessionId: call.sessionId,
    callId: call.callId,
    tool: c.name,
    args: safeArgs(call.name, call.args),
    targets: c.targets.map((t) => (isSecretTable(t.table) ? { kind: 'record', instance: t.instance, table: t.table, ...(t.sysId ? { sysId: t.sysId } : {}) } : t)),
    resultSysIds: ids,
    start: call.start,
    end: call.end,
    ok: res.ok,
  };
  if (call.client) ev.client = call.client;
  if (c.inner) ev.innerTool = c.inner;
  if (ctx.updateSet) ev.updateSet = { ...ctx.updateSet };
  if (ctx.user) ev.user = ctx.user;
  if (ctx.instance) ev.instance = ctx.instance;
  if (res.error) ev.error = res.error;
  if (call.own) ev.own = true;
  return ev;
}
