// LiveMap plugin for SkyForge. Built from plugins/servicenow/skyforge-plugin/plugin.ts by npm run build; do not edit.

// plugins/servicenow/skyforge-plugin/plugin.ts
import fs2 from "node:fs";
import path3 from "node:path";

// src/shared/tools.ts
var rec = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var str = (v) => typeof v === "string" && v ? v : void 0;
var FAMILIES = {
  read: ["read", "read_file", "view"],
  write: ["write", "write_file", "create_file"],
  edit: ["edit", "multiedit", "replace", "edit_file", "str_replace"],
  shell: ["bash", "shell", "run_shell_command", "exec_command"],
  patch: ["apply_patch"],
  search: ["grep", "search_file_content"],
  glob: ["glob", "list_directory", "ls"],
  fetch: ["webfetch", "web_fetch"],
  websearch: ["websearch", "google_web_search"],
  subagent: ["task", "agent"],
  notebook: ["notebookedit"]
};
var WRITE_FAMILIES = /* @__PURE__ */ new Set(["write", "edit", "patch", "notebook", "shell"]);
var READ_FAMILIES = /* @__PURE__ */ new Set(["read", "search", "glob", "fetch", "websearch"]);
var BY_NAME = /* @__PURE__ */ new Map();
for (const [fam, names] of Object.entries(FAMILIES)) for (const n of names) BY_NAME.set(n, fam);
var familyOf = (name) => BY_NAME.get(name.toLowerCase());
var MCP_PREFIX = /^mcp__.+?__(?=.)/;
var NEXUS_PREFIX = /^nexus_ses_[A-Za-z0-9]+_(?=.)/;
var GATEWAYS = /* @__PURE__ */ new Set(["tool_execute"]);
function baseToolName(name) {
  return name.replace(MCP_PREFIX, "").replace(NEXUS_PREFIX, "");
}
function toolServer(name) {
  const m = /^mcp__(.+?)__./.exec(name);
  if (m) return m[1];
  return NEXUS_PREFIX.test(name) ? "nexus" : void 0;
}
function unwrapTool(name, input) {
  const base = baseToolName(name);
  if (!GATEWAYS.has(base)) return { name: base, args: input };
  const o = rec(input);
  const inner = str(o.tool);
  if (!inner) return { name: base, args: input };
  let args = o.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
    }
  }
  return { name: base, inner: baseToolName(inner), args: args ?? {} };
}
var RECORD_READ_ACTIONS = /* @__PURE__ */ new Set(["get", "read", "query", "list", "search", "find", "count", "describe", "fetch"]);
var actionAccess = (a) => {
  const action = str(a.action)?.toLowerCase();
  return action && RECORD_READ_ACTIONS.has(action) ? "read" : "write";
};
var NAME_KEYS = ["name", "api_name", "sys_name"];
var UPDATE_SET_KEYS = ["update_set", "update_set_name"];
var firstStr = (o, keys) => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return void 0;
};
function recordTargetsOf(args, defaults = {}) {
  const table = str(args.table) ?? str(args.table_name) ?? str(args.tableName) ?? defaults.table;
  if (!table) return [];
  const sysId = str(args.sys_id) ?? str(args.sysId) ?? str(args.record_id) ?? str(args.recordId);
  const keys = defaults.nameKeys ?? NAME_KEYS;
  const name = firstStr(args, keys) ?? firstStr(rec(args.data), keys);
  const out = { kind: "record", instance: str(args.instance) ?? "", table };
  if (sysId) out.sysId = sysId;
  if (name) out.name = name;
  return [out];
}
var records = (a) => recordTargetsOf(a);
var UPDATE_SET_READS = /* @__PURE__ */ new Set(["current", "list", "get", "preview", "export"]);
var lowerAction = (a) => str(a.action)?.toLowerCase();
var SERVICENOW_RULES = [
  { match: "sn_query_table", access: "read" },
  { match: "sn_get_table_metadata", access: "read" },
  { match: "sn_get_instance_info", access: "read" },
  { match: "sn_session_context", access: "read" },
  { match: "sn_discover_platform_tables", access: "read" },
  { match: "sn_aggregate_metrics", access: "read" },
  { match: "sn_load_skill", access: "other" },
  { match: "tool_search", access: "other" },
  // Pulls an instance record to local files: it reads the instance, and its path args are local files.
  { match: "sn_pull_artifact", access: "read", localPaths: true },
  { match: "sn_record_manage", access: actionAccess, targets: records },
  { match: "sn_push_artifact", access: "write", targets: records },
  {
    // Actions seen live: switch, create, current, add_artifact, force_capture, export, list, preview, ignore.
    match: "sn_update_set_manage",
    access: (a) => UPDATE_SET_READS.has(lowerAction(a) ?? "") ? "read" : "write",
    targets: (a) => recordTargetsOf(a, { table: "sys_update_set", nameKeys: [...NAME_KEYS, ...UPDATE_SET_KEYS] })
  },
  // Reads update sets; `current` returns the session's current set as {success, data: {sys_id, name, ...}}.
  { match: "sn_update_set_query", access: "read" },
  // Makes the named update set current, creating it when missing.
  { match: "sn_ensure_active_update_set", access: "write", targets: (a) => recordTargetsOf(a, { table: "sys_update_set" }) },
  // Changes the session's application scope (and with create_update_set, its current update set): no app record changes.
  { match: "sn_switch_application_scope", access: "other" },
  { match: "sn_execute_background_script", access: "write" },
  { match: "sn_schedule_script_job", access: "write" },
  // Actions: get (read), and create_flow, create_subflow, update_flow, delete_flow, promote, populate_inputs, add_component,
  // delete_component, update_trigger (writes). Its args name the flow by sys_id or name, never by table.
  { match: "sn_intermediate_flow", access: (a) => lowerAction(a) === "get" ? "read" : "write", targets: (a) => recordTargetsOf(a, { table: "sys_hub_flow" }) },
  { match: /^sn_(create|update|delete|add|remove|set|activate|deactivate|publish)_/, access: "write", targets: records }
];
var WRITE_VERBS = /* @__PURE__ */ new Set([
  "create",
  "update",
  "delete",
  "write",
  "push",
  "put",
  "insert",
  "upsert",
  "patch",
  "edit",
  "remove",
  "move",
  "rename",
  "merge",
  "apply",
  "execute",
  "exec",
  "run",
  "set",
  "add",
  "deploy",
  "publish",
  "commit",
  "save",
  "upload",
  "drop",
  "replace"
]);
var READ_VERBS = /* @__PURE__ */ new Set(["get", "list", "search", "query", "read", "fetch", "find", "describe", "view", "show", "lookup", "download", "count"]);
function verbAccess(base) {
  for (const t of base.toLowerCase().split(/[_\-.]+/)) {
    if (WRITE_VERBS.has(t)) return "write";
    if (READ_VERBS.has(t)) return "read";
  }
  return void 0;
}
var extraRules = [];
function ruleFor(base) {
  const lower = base.toLowerCase();
  const hit = (r) => typeof r.match === "string" ? r.match.toLowerCase() === lower : r.match.test(base);
  return extraRules.find(hit) ?? SERVICENOW_RULES.find(hit);
}
var SYS_ID = /^[0-9a-f]{32}$/i;
var SYS_ID_TEXT = /"sys_id"\s*:\s*"([0-9a-f]{32})"/gi;
var MAX_TEXT_IDS = 5;
function resultObjects(top) {
  const out = [];
  for (const base of [top, rec(top.result)]) {
    const data = rec(base.data);
    const list = Array.isArray(data.records) ? data.records : [];
    out.push(base, data, rec(data.record), rec(list[0]));
  }
  return out;
}
function resultSysIds(output) {
  let o = output;
  if (typeof o === "string") {
    const t = o.trimStart();
    if (!t.startsWith("{")) return [];
    try {
      o = JSON.parse(t);
    } catch {
      const ids = /* @__PURE__ */ new Set();
      for (const m of t.matchAll(SYS_ID_TEXT)) {
        ids.add(m[1]);
        if (ids.size >= MAX_TEXT_IDS) break;
      }
      return [...ids];
    }
  }
  const out = /* @__PURE__ */ new Set();
  for (const v of resultObjects(rec(o))) {
    const id = str(v.sys_id);
    if (id && SYS_ID.test(id)) out.add(id);
  }
  return [...out];
}
function classifyTool(name, input, opts = {}) {
  const { name: base, inner, args } = unwrapTool(name, input);
  const real = inner ?? base;
  const server = toolServer(name);
  const out = { name: base, access: "other", known: false, args, targets: [] };
  if (inner) out.inner = inner;
  if (server) out.server = server;
  const family = server || inner ? void 0 : familyOf(real);
  const rule = ruleFor(real);
  if (family) {
    out.family = family;
    out.access = WRITE_FAMILIES.has(family) ? "write" : READ_FAMILIES.has(family) ? "read" : "other";
    out.known = true;
  } else if (rule) {
    if (rule.family) out.family = rule.family;
    out.access = typeof rule.access === "function" ? rule.access(rec(args)) : rule.access;
    out.known = true;
    if (rule.targets && out.access === "write") out.targets = rule.targets(rec(args));
  } else if (GATEWAYS.has(real)) {
    out.access = "other";
  } else if (server || /^sn_/.test(real)) {
    const v = verbAccess(real);
    if (v) {
      out.access = v;
      out.known = true;
    }
  }
  if (out.access === "write" && opts.output !== void 0) {
    const ids = resultSysIds(opts.output);
    if (ids.length) {
      const t0 = out.targets[0];
      const table = t0?.table ?? str(rec(args).table);
      if (table) {
        for (const id of ids) if (!out.targets.some((t) => t.sysId === id)) out.targets.push({ kind: "record", instance: "", table, sysId: id, ...t0?.name ? { name: t0.name } : {} });
      }
    }
  }
  if (opts.instance) {
    for (const t of out.targets) if (!t.instance) t.instance = opts.instance;
  }
  return out;
}

// src/proxy/capture.ts
var rec2 = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var str2 = (v) => typeof v === "string" && v ? v : void 0;
var REDACTED = "[redacted]";
var SECRET_KEY = /(password|passwd|passphrase|pwd|token|secret|apikey|privatekey|credentials?|cookie)\d*$/;
var AUTH_KEYS = /* @__PURE__ */ new Set(["auth", "authorization"]);
var SCRIPT_KEY = /(script|condition)$/;
var HEADER_KEYS = /^(headers?|httpheaders|requestheaders)$/;
var PAIR_NAME_KEYS = ["name", "key", "field", "property"];
var PAIR_VALUE_KEYS = ["value", "default_value", "defaultValue"];
var SECRET_TABLE = /^(sys_auth_profile.*|oauth_entity.*|discovery_credentials|sys_properties)$/i;
var MAX_DEPTH = 32;
var MAX_ERROR = 300;
var norm = (k) => k.replace(/[_-]/g, "").toLowerCase();
var isSecretKey = (k) => SECRET_KEY.test(norm(k)) || AUTH_KEYS.has(norm(k));
var words = (k) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-\s.]+/).filter(Boolean);
var isAuthWordKey = (k) => words(k).includes("auth");
var isFlag = (v) => typeof v === "boolean" || v === "true" || v === "false";
var isScriptKey = (k) => SCRIPT_KEY.test(norm(k));
var isSecretTable = (t) => !!t && SECRET_TABLE.test(t);
var SECRET_TEXT = /\b([\w-]*(?:password2?|passwd|passphrase|pwd|token|secret|api[_-]?key|private[_-]?key|credentials?|cookie|authorization))(["']?\s*[:=]\s*["']?)([^\s"',;}&]+)/gi;
var BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
function redactText(s) {
  return s.replace(SECRET_TEXT, `$1$2${REDACTED}`).replace(BEARER, `$1 ${REDACTED}`);
}
function namesOnly(v, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => namesOnly(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = namesOnly(x, depth + 1);
    return out;
  }
  return REDACTED;
}
function redact(v, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof v === "string") return redactText(v);
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const o = v;
  const pairName = PAIR_NAME_KEYS.map((k) => o[k]).find((x) => typeof x === "string");
  const secretPair = !!pairName && isSecretKey(pairName);
  const out = {};
  for (const [k, x] of Object.entries(o)) {
    if (isSecretKey(k) || secretPair && PAIR_VALUE_KEYS.includes(k) || isAuthWordKey(k) && !isFlag(x)) out[k] = REDACTED;
    else if (isScriptKey(k) || HEADER_KEYS.test(norm(k))) out[k] = namesOnly(x, depth + 1);
    else out[k] = redact(x, depth + 1);
  }
  return out;
}
function argNames(args) {
  const o = rec2(args);
  const keys = Object.keys(o);
  const inner = rec2(o.args);
  return Object.keys(inner).length ? [...keys, ...Object.keys(inner).map((k) => `args.${k}`)] : keys;
}
function safeArgs(name, args) {
  const c = classifyTool(name, args);
  const a = rec2(c.args);
  const table = str2(a.table) ?? str2(a.table_name) ?? str2(a.tableName);
  const secret = isSecretTable(table) || c.targets.some((t) => isSecretTable(t.table));
  if (!c.inner) return secret ? namesOnly(args) : redact(args);
  const { args: inner } = unwrapTool(name, args);
  const rest = { ...rec2(args) };
  delete rest.args;
  const safeInner = typeof inner === "string" || secret ? namesOnly(inner) : redact(inner);
  return { ...redact(rest), args: safeInner };
}
function resultPayload(result) {
  const r = rec2(result);
  if (r.structuredContent !== void 0) return r.structuredContent;
  const content = Array.isArray(r.content) ? r.content : [];
  for (const c of content) {
    const t = rec2(c);
    if (t.type !== "text" || typeof t.text !== "string") continue;
    const s = t.text.trimStart();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {
        return t.text;
      }
    }
    return t.text;
  }
  return void 0;
}
function outcome(result, rpcError, shallow = false) {
  const cut = (s) => redactText(s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s);
  if (rpcError !== void 0) return { ok: false, error: cut(str2(rec2(rpcError).message) ?? "error") };
  const r = rec2(result);
  if (shallow) return r.isError === true ? { ok: false, error: "error" } : { ok: true };
  const payload = resultPayload(result);
  const p = rec2(payload);
  if (r.isError === true || p.success === false) {
    const msg = str2(p.error) ?? str2(rec2(p.error).message) ?? str2(p.message) ?? (typeof payload === "string" ? payload : void 0) ?? "error";
    return { ok: false, error: cut(msg) };
  }
  return { ok: true };
}
var MAX_PARSED_RESULT = 1024 * 1024;
var CONTEXT_TOOLS = /* @__PURE__ */ new Set(["sn_session_context", "sn_get_instance_info", "sn_update_set_manage", "sn_update_set_query", "sn_ensure_active_update_set", "sn_switch_application_scope"]);
var USER_KEYS = ["user_name", "username", "userName", "user_id", "user"];
var SYS_ID2 = /^[0-9a-f]{32}$/i;
function userOf(payload) {
  for (const o of [rec2(payload), rec2(rec2(payload).data), rec2(rec2(rec2(payload).result).data), rec2(rec2(rec2(payload).data).user)]) {
    for (const k of USER_KEYS) {
      const v = o[k];
      const s = str2(v) ?? str2(rec2(v).value) ?? str2(rec2(v).user_name);
      if (s && !SYS_ID2.test(s)) return s;
    }
  }
  return void 0;
}
function updateSetOf(payload) {
  const tops = [rec2(payload), rec2(rec2(payload).data), rec2(rec2(rec2(payload).result).data)];
  for (const t of tops) {
    for (const o of [rec2(t.update_set), rec2(t.current), rec2(t.current_update_set), t]) {
      const sysId = str2(o.sys_id) ?? str2(rec2(o.sys_id).value);
      const name = str2(o.name) ?? str2(rec2(o.name).value);
      if (sysId && SYS_ID2.test(sysId)) return { sysId, ...name ? { name } : {} };
    }
  }
  return void 0;
}
var SessionContext = class {
  instance;
  user;
  updateSet;
  constructor(instance) {
    if (instance) this.instance = instance;
  }
  /** Learns from one finished call; `real` is the inner tool of a gateway call. */
  learn(real, args, payload, ok) {
    if (!ok) return;
    const a = rec2(args);
    const fromResult = () => updateSetOf(payload);
    const set = (u) => {
      if (u && (u.sysId || u.name || u.unknown)) this.updateSet = u;
    };
    switch (real) {
      case "sn_session_context":
      case "sn_get_instance_info": {
        const u = userOf(payload);
        if (u) this.user = u;
        const inst = str2(rec2(rec2(payload).data).instance_name) ?? str2(rec2(payload).instance_name);
        if (inst && !this.instance) this.instance = inst;
        return;
      }
      case "sn_update_set_manage": {
        const action = str2(a.action)?.toLowerCase();
        const r = fromResult();
        if (action === "current") set(r);
        else if (action === "create") set({ ...r?.sysId ? { sysId: r.sysId } : {}, ...str2(a.name) ?? r?.name ? { name: str2(a.name) ?? r?.name } : {} });
        else if (action === "switch") {
          const sysId = str2(a.update_set_id) ?? str2(a.sys_id) ?? r?.sysId;
          const name = r?.name ?? str2(a.name);
          set(sysId || name ? { ...sysId ? { sysId } : {}, ...name ? { name } : {} } : { unknown: true });
        }
        return;
      }
      case "sn_update_set_query": {
        if (str2(a.action)?.toLowerCase() === "current") set(fromResult());
        return;
      }
      case "sn_ensure_active_update_set": {
        const r = fromResult();
        const name = str2(a.name) ?? r?.name;
        set({ ...r?.sysId ? { sysId: r.sysId } : {}, ...name ? { name } : {} });
        return;
      }
      case "sn_switch_application_scope": {
        const r = fromResult();
        set(r ?? { unknown: true });
        return;
      }
    }
  }
};
function needsResult(name, args) {
  const c = classifyTool(name, args);
  return c.access === "write" || CONTEXT_TOOLS.has(c.inner ?? c.name);
}
function buildCapture(call, ctx) {
  const payload = call.result === void 0 || call.skipResult ? void 0 : resultPayload(call.result);
  const res = call.cancelled ? { ok: false, error: "cancelled" } : outcome(call.result, call.rpcError, !!call.skipResult);
  const c = classifyTool(call.name, call.args, payload === void 0 ? {} : { output: payload, ...ctx.instance ? { instance: ctx.instance } : {} });
  const real = c.inner ?? c.name;
  ctx.learn(real, c.args, payload, res.ok);
  if (ctx.instance) {
    for (const t of c.targets) if (!t.instance) t.instance = ctx.instance;
  }
  const ids = payload === void 0 ? [] : resultSysIds(payload);
  const ev = {
    source: call.source ?? "mcp-proxy",
    sessionId: call.sessionId,
    callId: call.callId,
    tool: c.name,
    args: safeArgs(call.name, call.args),
    targets: c.targets.map((t) => isSecretTable(t.table) ? { kind: "record", instance: t.instance, table: t.table, ...t.sysId ? { sysId: t.sysId } : {} } : t),
    resultSysIds: ids,
    start: call.start,
    end: call.end,
    ok: res.ok
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
var MAX_TEXT = 8e3;
function buildText(kind, sessionId, at, text, textId) {
  if (kind === "idle") return { source: "skyforge-plugin", kind, sessionId, at };
  const t = text?.trim();
  if (!t) return void 0;
  return { source: "skyforge-plugin", kind, sessionId, at, text: redactText(t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t), ...textId ? { textId } : {} };
}

// src/proxy/poster.ts
import fs from "node:fs";
import http from "node:http";
import path2 from "node:path";

// src/agents/runtime.ts
import os from "node:os";
import path from "node:path";
function livemapHome() {
  return process.env.LIVEMAP_HOME || path.join(os.homedir(), ".livemap");
}
function runtimeDir() {
  return path.join(livemapHome(), "run");
}

// src/proxy/poster.ts
var QUEUE_MAX = 100;
var POST_TIMEOUT_MS = 500;
var RUNS_TTL_MS = 2e3;
var TOKEN = /^[\x21-\x7e]{1,256}$/;
var pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
function liveRuntimes(dir = runtimeDir()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const e = JSON.parse(fs.readFileSync(path2.join(dir, n), "utf8"));
      if (typeof e.root !== "string" || typeof e.token !== "string" || !TOKEN.test(e.token)) continue;
      if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) continue;
      if (!Number.isInteger(e.pid) || e.pid <= 0 || !pidAlive(e.pid)) continue;
      out.push({ root: e.root, port: e.port, token: e.token, pid: e.pid });
    } catch {
    }
  }
  return out;
}
var isServiceNowRun = (e) => /[\\/]\.livemap[\\/]sn$/.test(e.root);
function normalizeInstance(v) {
  return v.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/\.service-now\.com$/, "");
}
var manifestCache = /* @__PURE__ */ new Map();
function runInstances(e) {
  try {
    const names = fs.readdirSync(e.root).filter((n) => n.endsWith(".manifest.json")).sort();
    const stamp = names.map((n) => {
      try {
        return `${n}:${fs.statSync(path2.join(e.root, n)).mtimeMs}`;
      } catch {
        return n;
      }
    }).join("|");
    const hit = manifestCache.get(e.root);
    if (hit && hit.stamp === stamp) return hit.instances;
    const out = /* @__PURE__ */ new Set();
    for (const n of names) {
      try {
        const m = JSON.parse(fs.readFileSync(path2.join(e.root, n), "utf8"));
        if (typeof m.instance === "string" && m.instance) out.add(normalizeInstance(m.instance));
      } catch {
      }
    }
    const instances = [...out];
    manifestCache.set(e.root, { stamp, instances });
    return instances;
  } catch {
    return [];
  }
}
var HookPoster = class {
  queue = [];
  busy = false;
  runs = [];
  runsAt = -Infinity;
  accept;
  runtimes;
  instance;
  instancesOf;
  timeoutMs;
  queueMax;
  idle = [];
  /** Events dropped because the queue was full. */
  dropped = 0;
  /** Posts that LiveMap answered 200. */
  delivered = 0;
  constructor(opts = {}) {
    this.accept = opts.accept ?? isServiceNowRun;
    this.runtimes = opts.runtimes ?? (() => liveRuntimes());
    this.instance = opts.instance ? normalizeInstance(opts.instance) || void 0 : void 0;
    this.instancesOf = opts.instancesOf ?? runInstances;
    this.timeoutMs = opts.timeoutMs ?? POST_TIMEOUT_MS;
    this.queueMax = opts.queueMax ?? QUEUE_MAX;
  }
  /** Queues one event and returns at once. */
  send(event) {
    try {
      const body = JSON.stringify(event);
      this.queue.push(body);
      while (this.queue.length > this.queueMax) {
        this.queue.shift();
        this.dropped++;
      }
      if (!this.busy) this.drain().catch(() => {
        this.busy = false;
      });
    } catch {
    }
  }
  /** Resolves when the queue is empty and nothing is in flight (tests and shutdown). */
  flushed() {
    if (!this.busy && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }
  /** The runs for this proxy's instance: those that mirror it or cannot tell; all of them when none matches. */
  forInstance(runs) {
    if (!this.instance) return runs;
    const mine = runs.filter((e) => {
      const theirs = this.instancesOf(e).map(normalizeInstance);
      return !theirs.length || theirs.includes(this.instance);
    });
    return mine.length ? mine : runs;
  }
  targets() {
    const now = Date.now();
    if (now - this.runsAt > RUNS_TTL_MS) {
      try {
        this.runs = this.forInstance(this.runtimes().filter((e) => this.accept(e)));
      } catch {
        this.runs = [];
      }
      this.runsAt = now;
    }
    return this.runs;
  }
  async drain() {
    this.busy = true;
    try {
      while (this.queue.length) {
        const body = this.queue.shift();
        const runs = this.targets();
        await Promise.all(runs.map((r) => this.post(r, body)));
      }
    } finally {
      this.busy = false;
      for (const f of this.idle.splice(0)) f();
    }
  }
  post(r, body) {
    return new Promise((resolve) => {
      let done = false;
      let req;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        try {
          req?.destroy();
        } catch {
        }
        resolve();
      };
      try {
        req = http.request({
          host: "127.0.0.1",
          port: r.port,
          path: "/hook",
          method: "POST",
          agent: false,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-livemap-token": r.token }
        }, (res) => {
          if (res.statusCode === 200) this.delivered++;
          res.resume();
          res.on("end", finish);
          res.on("error", finish);
        });
        timer = setTimeout(finish, this.timeoutMs);
        timer.unref?.();
        req.on("error", finish);
        req.end(body);
      } catch {
        finish();
      }
    });
  }
};

// plugins/servicenow/skyforge-plugin/plugin.ts
var rec3 = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var str3 = (v) => typeof v === "string" && v ? v : void 0;
var STATE = /* @__PURE__ */ Symbol.for("livemap.skyforge-plugin.v1");
var MAX_KEEP = 2e3;
var MAX_HELD = 200;
var IDLE_WINDOW_MS = 2e3;
function bounded(m) {
  while (m.size > MAX_KEEP) {
    const first = m.keys().next().value;
    m.delete(first);
  }
}
function state() {
  const g = globalThis;
  g[STATE] ??= { poster: new HookPoster(), calls: /* @__PURE__ */ new Map(), done: /* @__PURE__ */ new Set(), contexts: /* @__PURE__ */ new Map(), roles: /* @__PURE__ */ new Map(), posted: /* @__PURE__ */ new Set(), held: /* @__PURE__ */ new Map(), idleAt: /* @__PURE__ */ new Map(), inits: 0 };
  return g[STATE];
}
function debug(line) {
  if (!process.env.LIVEMAP_PLUGIN_DEBUG) return;
  try {
    const dir = path3.join(livemapHome(), "logs");
    fs2.mkdirSync(dir, { recursive: true });
    fs2.appendFile(path3.join(dir, "skyforge-plugin.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`, () => {
    });
  } catch {
  }
}
var isNexusTool = (name) => toolServer(name) === "nexus" || /^(sn_|tool_execute$)/.test(baseToolName(name));
var send = (s, e) => {
  if (e) s.poster.send(e);
};
function sendPart(s, part, sessionId) {
  const id = str3(part.id);
  const end = rec3(part.time).end;
  if (!id || typeof end !== "number" || s.posted.has(id)) return;
  s.posted.add(id);
  bounded(s.posted);
  send(s, buildText("message", str3(part.sessionID) ?? sessionId ?? "", end, str3(part.text), id));
}
var contextOf = (s, sessionId) => {
  let c = s.contexts.get(sessionId);
  if (!c) {
    c = new SessionContext();
    s.contexts.set(sessionId, c);
    bounded(s.contexts);
  }
  return c;
};
var LivemapSkyforge = async () => {
  const s = state();
  s.inits++;
  return {
    "tool.execute.before": async (input, output) => {
      try {
        const name = str3(input?.tool);
        if (!name || !isNexusTool(name) || !input.sessionID || !input.callID) return;
        const key = `${input.sessionID}\0${input.callID}`;
        if (s.calls.has(key) || s.done.has(key)) return;
        s.calls.set(key, { name, args: output?.args ?? {}, start: Date.now() });
        bounded(s.calls);
        debug(`call ${baseToolName(name)} args: ${argNames(output?.args).join(", ")}`);
      } catch {
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        const name = str3(input?.tool);
        if (!name || !isNexusTool(name) || !input.sessionID || !input.callID) return;
        const key = `${input.sessionID}\0${input.callID}`;
        if (s.done.has(key)) return;
        s.done.add(key);
        bounded(s.done);
        const call = s.calls.get(key);
        s.calls.delete(key);
        const end = Date.now();
        const args = call?.args ?? input.args ?? {};
        const text = typeof output?.output === "string" ? output.output : JSON.stringify(output?.output ?? "");
        const skipResult = text.length > MAX_PARSED_RESULT || !needsResult(name, args);
        const ev = buildCapture({
          source: "skyforge-plugin",
          client: { name: "skyforge" },
          sessionId: input.sessionID,
          callId: input.callID,
          name,
          args,
          result: { content: [{ type: "text", text }] },
          skipResult,
          start: call?.start ?? end,
          end
        }, contextOf(s, input.sessionID));
        debug(`done ${ev.innerTool ?? ev.tool} ok=${ev.ok}`);
        send(s, ev);
      } catch {
      }
    },
    "chat.message": async (input, output) => {
      try {
        const msg = rec3(output?.message);
        const id = str3(msg.id);
        const sessionId = str3(input?.sessionID) ?? str3(msg.sessionID);
        if (!sessionId) return;
        const created = typeof rec3(msg.time).created === "number" ? rec3(msg.time).created : void 0;
        const textId = id ?? (created !== void 0 ? `${sessionId}:${created}` : void 0);
        if (textId && s.posted.has(textId)) return;
        if (textId) {
          s.posted.add(textId);
          bounded(s.posted);
        }
        if (id) {
          s.roles.set(id, "user");
          bounded(s.roles);
          s.held.delete(id);
        }
        const text = (output?.parts ?? []).map(rec3).filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => str3(p.text) ?? "").join("\n");
        send(s, buildText("prompt", sessionId, created ?? Date.now(), text, textId));
      } catch {
      }
    },
    event: async (input) => {
      try {
        const e = rec3(input?.event);
        const props = rec3(e.properties);
        if (e.type === "message.updated") {
          const info = rec3(props.info);
          const id = str3(info.id);
          const role = str3(info.role);
          if (!id || !role) return;
          s.roles.set(id, role);
          bounded(s.roles);
          const waiting = s.held.get(id);
          s.held.delete(id);
          if (waiting && role === "assistant") for (const part of waiting) sendPart(s, part, str3(props.sessionID));
        } else if (e.type === "message.part.updated") {
          const part = rec3(props.part);
          const id = str3(part.id);
          const messageId = str3(part.messageID);
          if (part.type !== "text" || typeof rec3(part.time).end !== "number" || !id || !messageId || s.posted.has(id) || part.synthetic) return;
          const role = s.roles.get(messageId);
          if (role === "assistant") sendPart(s, part, str3(props.sessionID));
          else if (role === void 0) {
            const list = s.held.get(messageId) ?? [];
            if (!list.some((p) => p.id === id)) list.push({ ...part, ...str3(props.sessionID) && !str3(part.sessionID) ? { sessionID: props.sessionID } : {} });
            s.held.set(messageId, list);
            while (s.held.size > MAX_HELD) s.held.delete(s.held.keys().next().value);
          }
        } else if (e.type === "session.idle") {
          const sessionId = str3(props.sessionID);
          if (!sessionId) return;
          const now = Date.now();
          const last = s.idleAt.get(sessionId);
          if (last !== void 0 && now - last < IDLE_WINDOW_MS) return;
          s.idleAt.set(sessionId, now);
          bounded(s.idleAt);
          send(s, buildText("idle", sessionId, now));
        }
      } catch {
      }
    }
  };
};
export {
  LivemapSkyforge
};
