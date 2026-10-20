/**
 * Maps a mirror path back to the record it holds, so the Attributor can match a tool call that names a
 * record (`{table, sys_id}`) to the change of that record's file. Folder records (widgets, pages, portals,
 * flows, AI agents) own every file in their folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RecordKey } from '../../src/agents/attribution.js';
import { snTime } from './history.js';
import type { StoredManifest } from './writer.js';

const FOLDER_KINDS = new Set(['widget', 'page', 'portal', 'flow', 'ai_agent', 'rest']);

/**
 * Builds `path -> record` from a manifest. A file named after a record (`__<sys_id>`) is that record's; a file
 * in a folder record's folder is the folder record's (a page's layout.json is the page's, not the containers
 * and widget instances placed in it); any other file is the first record stored in it.
 */
export function indexManifest(m: StoredManifest): Map<string, RecordKey> {
  const out = new Map<string, RecordKey>();
  const owners = new Map<string, RecordKey>();
  const keyOf = (sysId: string, e: StoredManifest['records'][string]): RecordKey => {
    const key: RecordKey = { instance: m.instance || undefined, table: e.class, sysId, name: e.name };
    // The record's last change, for the update set, run window and time rules.
    const on = snTime(e.updatedOn);
    if (!Number.isNaN(on)) key.updatedOn = on;
    if (e.updatedBy) key.updatedBy = e.updatedBy;
    if (e.updateSet) key.updateSet = e.updateSet;
    if (e.updateSetName) key.updateSetName = e.updateSetName;
    return key;
  };
  const folderOf = (p: string): string | null => {
    const parts = p.split('/');
    return FOLDER_KINDS.has(parts[1]) && parts.length === 4 ? parts.slice(0, 3).join('/') : null;
  };
  for (const [sysId, e] of Object.entries(m.records)) {
    const folder = folderOf(e.path);
    if (folder?.endsWith(`__${sysId}`)) owners.set(folder, keyOf(sysId, e));
  }
  for (const [sysId, e] of Object.entries(m.records)) {
    const own = new RegExp(`__${sysId}(\\.[a-z]+)?$`, 'i').test(e.path);
    const owner = folderOf(e.path);
    if (own) out.set(e.path, keyOf(sysId, e));
    else if (owner && owners.has(owner)) out.set(e.path, owners.get(owner)!);
    else if (!out.has(e.path)) out.set(e.path, keyOf(sysId, e));
  }
  for (const f of m.files) {
    if (out.has(f)) continue;
    const owner = folderOf(f);
    if (owner && owners.has(owner)) out.set(f, owners.get(owner)!);
  }
  return out;
}

/** A resolver over the manifests in `root`, re-read when one changes. */
export function recordResolver(root: string): (p: string) => RecordKey | undefined {
  let stamp = '';
  let index = new Map<string, RecordKey>();
  const load = () => {
    let names: string[];
    try { names = fs.readdirSync(root).filter(n => n.endsWith('.manifest.json')).sort(); } catch { names = []; }
    const next = names.map(n => { try { return `${n}:${fs.statSync(path.join(root, n)).mtimeMs}`; } catch { return n; } }).join('|');
    if (next === stamp) return;
    stamp = next;
    index = new Map();
    for (const n of names) {
      try {
        for (const [k, v] of indexManifest(JSON.parse(fs.readFileSync(path.join(root, n), 'utf8')) as StoredManifest)) index.set(k, v);
      } catch { /* a manifest being rewritten: the next lookup reloads it */ }
    }
  };
  return (p) => { load(); return index.get(p); };
}
