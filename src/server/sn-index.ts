import fsSync from 'node:fs';
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

/** Whether `root` is a `livemap sn` mirror: it holds a scope manifest. */
export function isSnMirror(root: string): boolean {
  try {
    return fsSync.readdirSync(root).some(n => MANIFEST.test(n));
  } catch {
    return false;
  }
}
const HEADER = /^\s*\/\/\s*@livemap-sn\s+(\{.*\})\s*$/;
/** Largest record file read for its fields; bigger JSON records keep only what the manifest says. */
const MAX_READ = 1024 * 1024;

/** At most this many record files are read at once. */
const READ_CONCURRENCY = 16;

export interface SnIndexOptions {
  /** Reports a record file that could not be read (each path and error once). */
  warn?: (message: string) => void;
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/** A record file's fields, kept while its size and mtime stay the same. */
interface Cached { size: number; mtimeMs: number; fields: Obj }
/** Per mirror root: each record file's fields, the parsed manifests by mtime, and the read errors already reported. */
interface RootCache { files: Map<string, Cached>; manifests: Map<string, { mtimeMs: number; value: Obj | null }>; warned: Set<string> }
const caches = new Map<string, RootCache>();

/**
 * A record file's own fields: a script's header line, or a JSON object. The file's real path must stay inside the
 * mirror's real root, so a symlinked record never reads a file outside it. {} when it does not, or does not read.
 */
async function fieldsOf(realRoot: string, rel: string, cache: RootCache, warn?: (m: string) => void): Promise<Obj> {
  const report = (why: string) => {
    const key = `${rel}\0${why}`;
    if (warn && !cache.warned.has(key)) { cache.warned.add(key); warn(`ServiceNow record ${rel}: ${why}`); }
    return {};
  };
  let real: string;
  try {
    real = await fs.realpath(path.resolve(realRoot, rel));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? {} : report((e as Error).message);
  }
  if (!inside(realRoot, real)) return report('leaves the mirror folder (symlink), not read');
  try {
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > MAX_READ) return {};
    const hit = cache.files.get(real);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.fields;
    const text = await fs.readFile(real, 'utf8');
    let fields: Obj = {};
    if (real.endsWith('.json')) fields = rec(JSON.parse(text));
    else {
      const m = HEADER.exec(text.split('\n', 1)[0]);
      if (m) fields = rec(JSON.parse(m[1]));
    }
    cache.files.set(real, { size: st.size, mtimeMs: st.mtimeMs, fields });
    return fields;
  } catch (e) {
    return report((e as Error).message);
  }
}

/** Runs `jobs` with at most `n` at a time. */
async function limited(jobs: (() => Promise<void>)[], n: number): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

/** A manifest, parsed again only when its mtime changes. Null when it does not read. */
async function manifestOf(file: string, cache: RootCache, warn?: (m: string) => void): Promise<Obj | null> {
  try {
    const { mtimeMs } = await fs.stat(file);
    const hit = cache.manifests.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    let value: Obj | null = null;
    try {
      value = rec(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (e) {
      warn?.(`ServiceNow manifest ${path.basename(file)}: ${(e as Error).message}`);
    }
    cache.manifests.set(file, { mtimeMs, value });
    return value;
  } catch {
    return null;
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
 * names the table, so `sys_db_object` wins, else the first. Manifests and record files are read again only when they
 * change.
 */
export async function readSnIndex(root: string, opts: SnIndexOptions = {}): Promise<SnIndex | null> {
  let realRoot: string;
  let names: string[];
  try {
    realRoot = await fs.realpath(root);
    names = (await fs.readdir(realRoot)).filter(n => MANIFEST.test(n)).sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  let cache = caches.get(realRoot);
  if (!cache) caches.set(realRoot, (cache = { files: new Map(), manifests: new Map(), warned: new Set() }));
  const out: SnIndex = { instance: '', scopes: [], records: [] };
  const byPath = new Map<string, SnRecordInfo>();
  const jobs: (() => Promise<void>)[] = [];
  for (const n of names) {
    const m = await manifestOf(path.join(realRoot, n), cache, opts.warn);
    if (!m) continue;
    const scope = rec(m.scope);
    const scopeName = str(scope.scope) ?? n.replace(MANIFEST, '');
    if (!out.instance) out.instance = str(m.instance) ?? '';
    out.scopes.push({ scope: scopeName, ...(str(scope.name) ? { name: str(scope.name) } : {}), ...(str(scope.sys_id) ? { sysId: str(scope.sys_id) } : {}) });
    for (const [sysId, raw] of Object.entries(rec(m.records))) {
      const r = rec(raw);
      const file = str(r.path);
      const table = str(r.class);
      // Mirror paths are relative and use /; anything else is not a mirror path.
      if (!file || !table || path.isAbsolute(file) || file.split('/').includes('..')) continue;
      const dir = file.endsWith('/meta.json');
      const key = dir ? file.slice(0, -'/meta.json'.length) : file;
      const have = byPath.get(key);
      if (have && (have.table === 'sys_db_object' || table !== 'sys_db_object')) continue;
      const info: SnRecordInfo = { path: key, dir, sysId, table, name: (str(r.name) ?? sysId).trim(), scope: scopeName };
      byPath.set(key, info);
      const c = cache;
      jobs.push(async () => { Object.assign(info, pick(await fieldsOf(realRoot, file, c, opts.warn))); });
    }
  }
  await limited(jobs, READ_CONCURRENCY);
  out.records = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
