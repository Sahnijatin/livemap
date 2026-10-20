import type { AgentEvent, ChangeSummary } from '@shared/types.js';
import type { SnRecordInfo } from '@shared/sn.js';
import type { ViewFilter } from '../store';
import { CONFIDENCES, levelOf, recordOf, type ConfidenceLevel } from './data';

/**
 * The filter bar's choices. Each is kept in the page URL (`?scope=&set=&session=&who=&conf=`), so a reload or a shared
 * link shows the same view. Unset means "any".
 */
export interface Filters {
  scope?: string;
  /** An update set, by name. */
  set?: string;
  session?: string;
  who?: 'agent' | 'human';
  conf?: ConfidenceLevel;
}
export const FILTER_KEYS = ['scope', 'set', 'session', 'who', 'conf'] as const;

export function readFilters(search: string): Filters {
  const q = new URLSearchParams(search);
  const out: Filters = {};
  const v = (k: string) => q.get(k)?.trim() || undefined;
  if (v('scope')) out.scope = v('scope');
  if (v('set')) out.set = v('set');
  if (v('session')) out.session = v('session');
  const who = v('who');
  if (who === 'agent' || who === 'human') out.who = who;
  const conf = v('conf');
  if (conf && (CONFIDENCES as readonly string[]).includes(conf)) out.conf = conf as ConfidenceLevel;
  return out;
}

/** The page URL with these filters, other query parameters and the hash kept. */
export function filtersUrl(href: string, f: Filters): string {
  const url = new URL(href);
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  return url.pathname + url.search + url.hash;
}

export const activeCount = (f: Filters): number => FILTER_KEYS.filter(k => f[k]).length;

/**
 * What the views show for `f`, or null when no filter is on.
 * - Scope and update set are facts of a record: a file passes when its record (or, for scope, its top folder) matches.
 * - Session, agent or human, and confidence are facts of a change: a change passes when it matches, and a file passes
 *   when one of its changes does.
 * - Agent events pass the session filter and are hidden while "Human" is chosen; the other filters leave them alone.
 */
export function viewFilter(f: Filters, byPath: Map<string, SnRecordInfo>, changes: ChangeSummary[]): ViewFilter | null {
  if (!activeCount(f)) return null;
  const recordOk = (path: string): boolean => {
    if (!f.scope && !f.set) return true;
    const r = recordOf(byPath, path);
    if (f.scope && (r?.scope ?? path.split('/', 1)[0]) !== f.scope) return false;
    if (f.set && r?.updateSetName !== f.set) return false;
    return true;
  };
  const byChange = Boolean(f.session || f.who || f.conf);
  const changeOk = (c: ChangeSummary): boolean => {
    const a = c.attribution;
    if (f.session && a?.sessionId !== f.session) return false;
    if (f.who === 'agent' && !a) return false;
    if (f.who === 'human' && a) return false;
    if (f.conf && levelOf(a) !== f.conf) return false;
    return true;
  };
  const touched = new Set<string>();
  if (byChange) for (const c of changes) if (changeOk(c)) touched.add(c.path);
  return {
    key: FILTER_KEYS.map(k => f[k] ?? '').join('\u0000'),
    path: p => recordOk(p) && (!byChange || touched.has(p)),
    change: c => recordOk(c.path) && changeOk(c),
    event: (e: AgentEvent) => f.who !== 'human' && (!f.session || e.sessionId === f.session),
  };
}
