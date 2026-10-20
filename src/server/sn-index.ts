import fs from 'node:fs/promises';
import path from 'node:path';
import type { SnIndex, SnRecordInfo } from '../shared/sn.js';

export type { SnIndex, SnRecordInfo };

/*
 * Reads the records under a `livemap sn` mirror root for the UI (see SnRecordInfo in src/shared/sn.ts). Only the
 * fields SnRecordInfo names are read out, so no other value of a record (a property's value, a script body) ever
 * reaches the UI.
 */

type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** A reference field as nexus returns it: a sys_id string, or `{value, display_value}`. */
const ref = (v: unknown): { id?: string; name?: string } =>
  typeof v === 'string' ? { id: str(v) } : { id: str(rec(v).value), name: str(rec(v).display_value) };

const MANIFEST = /\.manifest\.json$/;
const HEADER = /^\s*\/\/\s*@livemap-sn\s+(\{.*\})\s*$/;
/** Largest record file read for its fields; bigger JSON records keep only what the manifest says. */
const MAX_READ = 1024 * 1024;

/** Inside `root`, after resolving `rel`; null when `rel` would leave it. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

/** A record file's own fields: a script's header line, or a JSON object; {} when neither reads. */
async function fieldsOf(abs: string): Promise<Obj> {
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size > MAX_READ) return {};
    const text = await fs.readFile(abs, 'utf8');
    if (abs.endsWith('.json')) return rec(JSON.parse(text));
    const m = HEADER.exec(text.split('\n', 1)[0]);
    return m ? rec(JSON.parse(m[1])) : {};
  } catch {
    return {};
  }
}

/** The fields the UI may see, from a record's own fields (snake_case from the instance, or camelCase from a header). */
function pick(f: Obj): Pick<SnRecordInfo, 'updateSet' | 'updateSetName' | 'updatedBy' | 'updatedOn'> {
  const set = ref(f.sys_update_set ?? f.update_set ?? f.updateSet);
  const out: Pick<SnRecordInfo, 'updateSet' | 'updateSetName' | 'updatedBy' | 'updatedOn'> = {};
  const name = str(f.update_set_name) ?? str(f.updateSetName) ?? set.name;
  const by = str(f.sys_updated_by) ?? str(f.updatedBy);
  const on = str(f.sys_updated_on) ?? str(f.updatedOn);
  if (set.id) out.updateSet = set.id;
  if (name) out.updateSetName = name;
  if (by) out.updatedBy = by;
  if (on) out.updatedOn = on;
  return out;
}

/**
 * The records under a `livemap sn` mirror root, or null when `root` holds no scope manifest (any other project).
 * Several records can share one file (a table and its dictionary entries share `<table>.sntable.json`): the file
 * names the table, so `sys_db_object` wins, else the first.
 */
export async function readSnIndex(root: string): Promise<SnIndex | null> {
  let names: string[];
  try {
    names = (await fs.readdir(root)).filter(n => MANIFEST.test(n)).sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  const out: SnIndex = { instance: '', scopes: [], records: [] };
  const byPath = new Map<string, SnRecordInfo>();
  for (const n of names) {
    let m: Obj;
    try {
      m = rec(JSON.parse(await fs.readFile(path.join(root, n), 'utf8')));
    } catch {
      continue;
    }
    const scope = rec(m.scope);
    const scopeName = str(scope.scope) ?? n.replace(MANIFEST, '');
    if (!out.instance) out.instance = str(m.instance) ?? '';
    out.scopes.push({ scope: scopeName, ...(str(scope.name) ? { name: str(scope.name) } : {}), ...(str(scope.sys_id) ? { sysId: str(scope.sys_id) } : {}) });
    const jobs: Promise<void>[] = [];
    for (const [sysId, raw] of Object.entries(rec(m.records))) {
      const r = rec(raw);
      const file = str(r.path);
      const table = str(r.class);
      if (!file || !table) continue;
      const abs = inside(root, file);
      if (!abs) continue;
      const dir = file.endsWith('/meta.json');
      const key = dir ? file.slice(0, -'/meta.json'.length) : file;
      const have = byPath.get(key);
      if (have && (have.table === 'sys_db_object' || table !== 'sys_db_object')) continue;
      const info: SnRecordInfo = { path: key, dir, sysId, table, name: (str(r.name) ?? sysId).trim(), scope: scopeName };
      byPath.set(key, info);
      jobs.push(fieldsOf(abs).then(f => { Object.assign(info, pick(f)); }));
    }
    await Promise.all(jobs);
  }
  out.records = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
