/**
 * Turns one MCP tool call into the capture event LiveMap's `/hook` takes (`source: "mcp-proxy"`). Pure: no
 * Node built-ins, so the SkyForge plugin can share the same rules. Values are redacted here, before
 * anything leaves the proxy.
 */
import { classifyTool, resultSysIds, unwrapTool, type RecordTarget } from '../shared/tools.js';

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export const REDACTED = '[redacted]';
/**
 * Secret keys, matched on the key lowercased with `_` and `-` removed, so `client_secret`, `clientSecret`,
 * `refresh-token`, `X-Api-Key` and `db_password` all match.
 */
const SECRET_KEY = /(password|passwd|passphrase|pwd|token|secret|apikey|privatekey|credentials?|cookie)\d*$/;
/** `auth` and `authorization` count only as whole keys: `requires_auth` and `oauth_enabled` are flags, not secrets. */
const AUTH_KEYS = new Set(['auth', 'authorization']);
/** Keys that hold code: a script can embed a password, so its value never leaves the proxy. */
const SCRIPT_KEY = /(script|condition)$/;
/** Keys that hold headers: every value under them is redacted. */
const HEADER_KEYS = /^(headers?|httpheaders|requestheaders)$/;
/** Name-value pairs (`{name: 'password', value: 'x'}`): the value is secret when the name is. */
const PAIR_NAME_KEYS = ['name', 'key', 'field', 'property'];
const PAIR_VALUE_KEYS = ['value', 'default_value', 'defaultValue'];
/** Tables whose records hold credentials or secret settings: a call on them keeps arg names only. */
const SECRET_TABLE = /^(sys_auth_profile.*|oauth_entity.*|discovery_credentials|sys_properties)$/i;
const MAX_DEPTH = 32;
const MAX_ERROR = 300;

const norm = (k: string) => k.replace(/[_-]/g, '').toLowerCase();
export const isSecretKey = (k: string): boolean => SECRET_KEY.test(norm(k)) || AUTH_KEYS.has(norm(k));
/** The words of a key: `basic_auth`, `proxyAuth` and `auth-string` all have the word `auth`. */
const words = (k: string): string[] => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s.]+/).filter(Boolean);
/** A key with the word `auth` (`basic_auth`, `http_auth`, `auth_string`): its value is a secret unless it is a plain flag. */
const isAuthWordKey = (k: string): boolean => words(k).includes('auth');
const isFlag = (v: unknown): boolean => typeof v === 'boolean' || v === 'true' || v === 'false';
export const isScriptKey = (k: string): boolean => SCRIPT_KEY.test(norm(k));
export const isSecretTable = (t: string | undefined): boolean => !!t && SECRET_TABLE.test(t);

const SECRET_TEXT = /\b([\w-]*(?:password2?|passwd|passphrase|pwd|token|secret|api[_-]?key|private[_-]?key|credentials?|cookie|authorization))(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;

/** Free text with `key=value` and `key: value` secrets and bearer tokens cut out. */
export function redactText(s: string): string {
  return s.replace(SECRET_TEXT, `$1$2${REDACTED}`).replace(BEARER, `$1 ${REDACTED}`);
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

/**
 * A deep copy safe to send: secret, script and header values replaced, the value of a secret name-value
 * pair replaced, secrets cut out of every string, and anything nested past MAX_DEPTH replaced whole.
 */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof v === 'string') return redactText(v);
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const o = v as Obj;
  const pairName = PAIR_NAME_KEYS.map((k) => o[k]).find((x): x is string => typeof x === 'string');
  const secretPair = !!pairName && isSecretKey(pairName);
  const out: Obj = {};
  for (const [k, x] of Object.entries(o)) {
    if (isSecretKey(k) || (secretPair && PAIR_VALUE_KEYS.includes(k)) || (isAuthWordKey(k) && !isFlag(x))) out[k] = REDACTED;
    else if (isScriptKey(k) || HEADER_KEYS.test(norm(k))) out[k] = namesOnly(x, depth + 1);
    else out[k] = redact(x, depth + 1);
  }
  return out;
}

/** Arg names only, for debug logs: top-level keys, and the inner tool's keys for a gateway call. */
export function argNames(args: unknown): string[] {
  const o = rec(args);
  const keys = Object.keys(o);
  const inner = rec(o.args);
  return Object.keys(inner).length ? [...keys, ...Object.keys(inner).map((k) => `args.${k}`)] : keys;
}

/**
 * The args to send for a call. A gateway call is sent as `{tool, args}` with the inner args parsed when
 * they came as a JSON string, and as names only when that string does not parse. A call on a secret table
 * keeps arg names only.
 */
export function safeArgs(name: string, args: unknown): unknown {
  const c = classifyTool(name, args);
  const a = rec(c.args);
  const table = str(a.table) ?? str(a.table_name) ?? str(a.tableName);
  const secret = isSecretTable(table) || c.targets.some((t) => isSecretTable(t.table));
  if (!c.inner) return secret ? namesOnly(args) : redact(args);
  const { args: inner } = unwrapTool(name, args);
  const rest: Obj = { ...rec(args) };
  delete rest.args;
  const safeInner = typeof inner === 'string' || secret ? namesOnly(inner) : redact(inner);
  return { ...(redact(rest) as Obj), args: safeInner };
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

/**
 * Whether a call failed, and its message: an MCP error result, a JSON-RPC error, or `{success: false}`.
 * With `shallow`, only the result's `isError` flag is read (a large result is not parsed).
 */
export function outcome(result: unknown, rpcError?: unknown, shallow = false): { ok: boolean; error?: string } {
  const cut = (s: string) => redactText(s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s);
  if (rpcError !== undefined) return { ok: false, error: cut(str(rec(rpcError).message) ?? 'error') };
  const r = rec(result);
  if (shallow) return r.isError === true ? { ok: false, error: 'error' } : { ok: true };
  const payload = resultPayload(result);
  const p = rec(payload);
  if (r.isError === true || p.success === false) {
    const msg = str(p.error) ?? str(rec(p.error).message) ?? str(p.message) ?? (typeof payload === 'string' ? payload : undefined) ?? 'error';
    return { ok: false, error: cut(msg) };
  }
  return { ok: true };
}

/** An update set; `unknown` marks a session whose current set changed to one the proxy cannot name yet. */
export interface UpdateSetRef { sysId?: string; name?: string; unknown?: true }
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
  /** Redacted args as called; for a gateway call, `{tool, args}`. */
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

/** Results larger than this are not parsed for the capture: only their `isError` flag counts. */
export const MAX_PARSED_RESULT = 1024 * 1024;

/** Tools whose results say who the session is or which update set is current: their results are always read. */
export const CONTEXT_TOOLS = new Set(['sn_session_context', 'sn_get_instance_info', 'sn_update_set_manage', 'sn_update_set_query', 'sn_ensure_active_update_set', 'sn_switch_application_scope']);
const USER_KEYS = ['user_name', 'username', 'userName', 'user_id', 'user'];
const SYS_ID = /^[0-9a-f]{32}$/i;

function userOf(payload: unknown): string | undefined {
  for (const o of [rec(payload), rec(rec(payload).data), rec(rec(rec(payload).result).data), rec(rec(rec(payload).data).user)]) {
    for (const k of USER_KEYS) {
      const v = o[k];
      const s = str(v) ?? str(rec(v).value) ?? str(rec(v).user_name);
      if (s && !SYS_ID.test(s)) return s;
    }
  }
  return undefined;
}

/** The update set a result describes: `{sys_id, name}` at the top, under `data`, `result.data`, or their `update_set`/`current`. */
function updateSetOf(payload: unknown): UpdateSetRef | undefined {
  const tops = [rec(payload), rec(rec(payload).data), rec(rec(rec(payload).result).data)];
  for (const t of tops) {
    for (const o of [rec(t.update_set), rec(t.current), rec(t.current_update_set), t]) {
      const sysId = str(o.sys_id) ?? str(rec(o.sys_id).value);
      const name = str(o.name) ?? str(rec(o.name).value);
      if (sysId && SYS_ID.test(sysId)) return { sysId, ...(name ? { name } : {}) };
    }
  }
  return undefined;
}

/**
 * What a session has said about itself so far: its instance, its ServiceNow user (from `sn_session_context`
 * or `sn_get_instance_info` results), and its current update set. SkyForge changes the current set with
 * `sn_update_set_manage` (`create`, `switch`), `sn_ensure_active_update_set` and
 * `sn_switch_application_scope`; `sn_update_set_manage` and `sn_update_set_query` with `current` read it back.
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
    const a = rec(args);
    const fromResult = () => updateSetOf(payload);
    const set = (u: UpdateSetRef | undefined) => { if (u && (u.sysId || u.name || u.unknown)) this.updateSet = u; };
    switch (real) {
      case 'sn_session_context':
      case 'sn_get_instance_info': {
        const u = userOf(payload);
        if (u) this.user = u;
        const inst = str(rec(rec(payload).data).instance_name) ?? str(rec(payload).instance_name);
        if (inst && !this.instance) this.instance = inst;
        return;
      }
      case 'sn_update_set_manage': {
        const action = str(a.action)?.toLowerCase();
        const r = fromResult();
        if (action === 'current') set(r);
        else if (action === 'create') set({ ...(r?.sysId ? { sysId: r.sysId } : {}), ...((str(a.name) ?? r?.name) ? { name: str(a.name) ?? r?.name } : {}) });
        else if (action === 'switch') {
          const sysId = str(a.update_set_id) ?? str(a.sys_id) ?? r?.sysId;
          const name = r?.name ?? str(a.name);
          set(sysId || name ? { ...(sysId ? { sysId } : {}), ...(name ? { name } : {}) } : { unknown: true });
        }
        return;
      }
      case 'sn_update_set_query': {
        // A read; with action=current its result names the session's current set.
        if (str(a.action)?.toLowerCase() === 'current') set(fromResult());
        return;
      }
      case 'sn_ensure_active_update_set': {
        const r = fromResult();
        const name = str(a.name) ?? r?.name;
        set({ ...(r?.sysId ? { sysId: r.sysId } : {}), ...(name ? { name } : {}) });
        return;
      }
      case 'sn_switch_application_scope': {
        // The scope's current set changes, to a set the args do not name (a new one with create_update_set).
        const r = fromResult();
        set(r ?? { unknown: true });
        return;
      }
    }
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
  /** Do not parse the result (it is large, or the call reads): only its `isError` flag counts. */
  skipResult?: boolean;
  start: number;
  end: number;
  own?: boolean;
}

/** Whether a call's result must be parsed: writes (for new sys_ids) and context tools. */
export function needsResult(name: string, args: unknown): boolean {
  const c = classifyTool(name, args);
  return c.access === 'write' || CONTEXT_TOOLS.has(c.inner ?? c.name);
}

/** Builds the capture event for a finished call and updates the session's context from it. */
export function buildCapture(call: CallInput, ctx: SessionContext): CaptureEvent {
  const payload = call.result === undefined || call.skipResult ? undefined : resultPayload(call.result);
  const res = call.cancelled ? { ok: false, error: 'cancelled' } : outcome(call.result, call.rpcError, !!call.skipResult);
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

/** A session's prompt, assistant text or idle status, posted to `/hook` by the SkyForge plugin. */
export interface TextEvent {
  source: 'skyforge-plugin';
  kind: 'prompt' | 'message' | 'idle';
  sessionId: string;
  at: number;
  text?: string;
  /** The message or part id, so LiveMap records a prompt or message once however often it is sent. */
  textId?: string;
}

/** Longest text sent for one prompt or message. */
export const MAX_TEXT = 8000;

/** A text event with its secrets cut out and its length capped; undefined when there is no text to send. */
export function buildText(kind: TextEvent['kind'], sessionId: string, at: number, text?: string, textId?: string): TextEvent | undefined {
  if (kind === 'idle') return { source: 'skyforge-plugin', kind, sessionId, at };
  const t = text?.trim();
  if (!t) return undefined;
  return { source: 'skyforge-plugin', kind, sessionId, at, text: redactText(t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t), ...(textId ? { textId } : {}) };
}
