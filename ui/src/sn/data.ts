import { create } from 'zustand';
import type { AgentEvent, AgentSession, Attribution, ChangeSummary } from '@shared/types.js';
import type { SnIndex, SnRecordInfo } from '@shared/sn.js';
import { baseToolName } from '@shared/tools.js';
import { authHeaders } from '../connection';

/*
 * The ServiceNow records of a `livemap sn` project (`/api/sn`), and the plain words the inspector and filters use
 * for them. Loaded only when the server answers `/api/sn`, so other projects never load this module.
 */

/** How sure an attribution is, strongest first; `none` is a change no agent made (or none was matched to). */
export const CONFIDENCES = ['exact', 'log', 'likely', 'ambiguous', 'none'] as const;
export type ConfidenceLevel = (typeof CONFIDENCES)[number];
export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  exact: 'Exact', log: 'Log', likely: 'Likely', ambiguous: 'Ambiguous', none: 'Unattributed',
};
/** What each level means, for the badge's tooltip when the attribution gives no reason of its own. */
export const CONFIDENCE_HINT: Record<ConfidenceLevel, string> = {
  exact: 'The agent call named this record.',
  log: 'Matched to a line in the agent tool log by table, action and time.',
  likely: 'One agent session fits by update set, run window or time.',
  ambiguous: 'More than one agent session fits.',
  none: 'No agent call matched. A person, or a tool LiveMap does not see, made this change.',
};

export const levelOf = (a: Attribution | undefined): ConfidenceLevel => (a ? (CONFIDENCES as readonly string[]).includes(a.confidence) ? (a.confidence as ConfidenceLevel) : 'likely' : 'none');

/** Plain names for record tables; others fall back to the table name. */
const KIND: Record<string, string> = {
  sp_portal: 'Portal', sp_page: 'Page', sp_widget: 'Widget', sp_instance: 'Widget instance', sp_theme: 'Theme',
  sys_db_object: 'Table', sys_dictionary: 'Field', sys_choice: 'Choice',
  sys_script: 'Business rule', sys_script_client: 'Client script', sys_script_include: 'Script include',
  sys_ui_action: 'UI action', sys_ui_policy: 'UI policy', sys_security_acl: 'ACL', sys_hub_flow: 'Flow',
  sys_ws_definition: 'Scripted REST API', sys_ws_operation: 'REST operation', sys_properties: 'System property',
  sys_ux_app_route: 'Workspace route', sys_ux_screen: 'Workspace screen', sys_ux_client_script: 'UX client script',
  sn_aia_agent: 'AI agent', sn_aia_tool: 'AI agent tool', sys_update_set: 'Update set',
};
export const kindOf = (table: string): string => KIND[table] ?? table;

/**
 * The record's page on its instance. `instance` is a name (`acme`), a host (`acme.service-now.com`) or a URL; a plain
 * link, opened in a new tab. LiveMap never writes to the instance.
 */
export function openUrl(instance: string, table: string, sysId: string): string | null {
  const host = instance.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host) || !/^[a-z0-9_]+$/i.test(table) || !/^[0-9a-f]{32}$/i.test(sysId)) return null;
  const full = host.includes('.') ? host : `${host}.service-now.com`;
  return `https://${full}/${table}.do?sys_id=${sysId}`;
}

interface SnState {
  index: SnIndex | null;
  /** Records by path: file records by file, folder records by folder. */
  byPath: Map<string, SnRecordInfo>;
}

export const useSn = create<SnState>(() => ({ index: null, byPath: new Map() }));

export function setIndex(index: SnIndex | null): void {
  useSn.setState({ index, byPath: new Map((index?.records ?? []).map(r => [r.path, r])) });
}

/** The record a mirror path belongs to: the record of that file, or of the nearest folder above it. */
export function recordOf(byPath: Map<string, SnRecordInfo>, path: string): SnRecordInfo | undefined {
  const hit = byPath.get(path);
  if (hit) return hit;
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const r = byPath.get(path.slice(0, i));
    if (r?.dir) return r;
  }
  return undefined;
}

/** Whether `path` is a file of `r` (the record's file, or any file under its folder). */
export const inRecord = (r: SnRecordInfo, path: string): boolean => path === r.path || (r.dir && path.startsWith(`${r.path}/`));

/** Loads `/api/sn`. False when the project is not a ServiceNow mirror (404) or the request fails. */
export async function loadSn(): Promise<boolean> {
  try {
    const res = await fetch('/api/sn', { headers: authHeaders() });
    if (!res.ok) return false;
    setIndex((await res.json()) as SnIndex);
    return true;
  } catch {
    return false;
  }
}

/** A tool name in plain words: `sn_record_manage` is "record manage". */
export const toolWords = (name: string): string => baseToolName(name).replace(/^sn_/, '').replace(/_/g, ' ').trim();

export interface Why {
  /** The user prompt that started the turn. */
  goal?: string;
  /** The assistant's words just before the call. */
  step?: string;
  /** The call, in plain words: "Updated widget via record manage". */
  action?: string;
  session?: AgentSession;
}

/**
 * The why of an attributed change, from the agent events LiveMap holds: the turn's prompt (Goal), the last message
 * before the call (Step) and the call itself (Action). Parts the events do not hold are left out.
 */
export function whyOf(change: ChangeSummary, kind: string, events: AgentEvent[], sessions: Record<string, AgentSession>): Why {
  const a = change.attribution;
  if (!a) return {};
  const out: Why = { session: sessions[a.sessionId] };
  let at = -1;
  if (a.eventId !== undefined) for (let i = events.length - 1; i >= 0; i--) if (events[i].id === a.eventId) { at = i; break; }
  const call = at >= 0 ? events[at] : undefined;
  if (call?.tool) {
    const verb = change.kind === 'created' ? 'Created' : change.kind === 'deleted' ? 'Deleted' : 'Updated';
    out.action = `${verb} ${kind.toLowerCase()} via ${toolWords(call.tool.inner ?? call.tool.name)}`;
  }
  // Without the call event there is no turn to read: only the attribution's own intent.
  for (let i = at - 1; i >= 0; i--) {
    const e = events[i];
    if (e.sessionId !== a.sessionId) continue;
    if (e.type === 'message' && !out.step && e.text) out.step = e.text;
    if (e.type === 'prompt') { if (e.text) out.goal = e.text; break; }
  }
  if (!out.goal && a.intent) out.goal = a.intent;
  return out;
}
