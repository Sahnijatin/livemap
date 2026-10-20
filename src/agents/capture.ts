/**
 * Capture events from `livemap mcp-proxy` (and later the SkyForge plugin) as hub events: one tool_start at
 * the call's start and one tool_end at its end, so attribution sees the call's whole run window.
 */
import type { AgentHub } from './hub.js';
import type { AgentKind, AgentTool, RawAgentEvent, SnContext } from '../shared/types.js';
import { classifyTool, type RecordTarget } from '../shared/tools.js';
import { toolLabel } from './labels.js';

export const CAPTURE_SOURCES = new Set(['mcp-proxy']);
const MAX_OUTPUT = 4000;
/** Event times more than this far from the server's clock are clamped: a capture describes a call that just ended. */
const MAX_FUTURE_MS = 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function targetsOf(v: unknown): RecordTarget[] {
  if (!Array.isArray(v)) return [];
  const out: RecordTarget[] = [];
  for (const t of v) {
    if (!isObj(t) || !str(t.table)) continue;
    const r: RecordTarget = { kind: 'record', instance: str(t.instance) ?? '', table: str(t.table) as string };
    if (str(t.sysId)) r.sysId = str(t.sysId);
    if (str(t.name)) r.name = str(t.name);
    out.push(r);
  }
  return out;
}

/** Whether a body is a capture event this server takes. */
export const isCapture = (v: unknown): v is Obj => isObj(v) && typeof v.source === 'string' && CAPTURE_SOURCES.has(v.source);

/**
 * The hub events for one capture, or none when it is malformed or from LiveMap's own session. Access and
 * record targets are classified again here, so a capture cannot claim a read was a write; the sender's
 * targets and result sys_ids add to the classifier's.
 */
export function captureEvents(v: Obj, now: number = Date.now()): RawAgentEvent[] {
  if (v.own === true) return [];
  const sessionId = str(v.sessionId);
  const callId = str(v.callId);
  const tool = str(v.tool);
  let start = num(v.start);
  let end = num(v.end);
  if (!sessionId || !callId || !tool || start === undefined || end === undefined) return [];
  end = Math.min(end, now + MAX_FUTURE_MS);
  start = Math.min(start, end);
  const inner = str(v.innerTool);
  const args = v.args;
  const name = tool;
  const input = inner ? { tool: inner, args } : args;
  const c = classifyTool(name, input);
  const targets: RecordTarget[] = c.access === 'write' ? [...c.targets] : [];
  const add = (t: RecordTarget) => { if (!targets.some((x) => x.table === t.table && x.sysId === t.sysId && x.name === t.name)) targets.push(t); };
  if (c.access === 'write') {
    for (const t of targetsOf(v.targets)) add(t);
    const table = targets[0]?.table;
    const ids = Array.isArray(v.resultSysIds) ? v.resultSysIds.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{32}$/i.test(x)) : [];
    if (table) for (const id of ids) add({ kind: 'record', instance: targets[0].instance, table, sysId: id, ...(targets[0].name ? { name: targets[0].name } : {}) });
  }
  const instance = str(v.instance);
  if (instance) for (const t of targets) if (!t.instance) t.instance = instance;
  const sn: SnContext = {};
  if (instance) sn.instance = instance;
  if (str(v.user)) sn.user = str(v.user);
  if (isObj(v.updateSet) && (str(v.updateSet.sysId) || str(v.updateSet.name))) {
    sn.updateSet = { ...(str(v.updateSet.sysId) ? { sysId: str(v.updateSet.sysId) } : {}), ...(str(v.updateSet.name) ? { name: str(v.updateSet.name) } : {}) };
  }
  const base: AgentTool = {
    id: callId, name: tool, label: toolLabel(name, input), paths: [],
    ...(c.inner ? { inner: c.inner } : {}), access: c.access, ...(targets.length ? { targets } : {}), ...(Object.keys(sn).length ? { sn } : {}),
  };
  const agent: AgentKind = 'mcp-client';
  const ok = v.ok !== false;
  const error = str(v.error);
  const endTool: AgentTool = { ...base, ok, ...(error ? { output: error.slice(0, MAX_OUTPUT) } : {}) };
  return [
    { agent, sessionId, at: start, type: 'tool_start', tool: { ...base, input } },
    { agent, sessionId, at: end, type: 'tool_end', tool: endTool },
  ];
}

/** Records one capture in the hub. Returns false when it was ignored. */
export function ingestCapture(hub: AgentHub, v: Obj, now: number = Date.now()): boolean {
  const events = captureEvents(v, now);
  if (!events.length) return false;
  hub.ingestRaw(events, { agent: 'mcp-client', cwd: '', hooks: true });
  return true;
}
