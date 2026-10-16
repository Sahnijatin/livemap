/**
 * Mirror paths that are safe on Windows, macOS and Linux. A record's file or folder is
 * `<name>__<sys_id>`: the name keeps the Map readable, and the sys_id keeps the path unique and lets
 * LiveMap follow a renamed record (same sys_id, new path).
 */

/** Longest name part of a segment, before `__<sys_id>` (keeps paths deterministic and short). */
export const NAME_MAX = 60;
/** Longest full path, mirror root included: below Windows' 260 with room for temp-file suffixes. */
export const PATH_MAX = 240;

const SYS_ID = /^[0-9a-f]{32}$/i;
// Characters Windows forbids in a name, and control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** Device names Windows reserves, with or without an extension (CON, CON.txt). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Fails clearly when a record field that names a path is not a string, instead of a TypeError deep in the
 * mirror. Records are flattened at the nexus client (`flattenRecord`), so this is a guard, not a converter.
 */
function requireText(v: unknown, field: string): string {
  if (typeof v === 'string') return v;
  const shown = JSON.stringify(v) ?? String(v);
  throw new TypeError(`${field} must be a string to name a mirror path, got ${v === null ? 'null' : typeof v}: ${shown.length > 80 ? `${shown.slice(0, 80)}...` : shown}`);
}

/**
 * One path segment safe on every OS: forbidden characters become `_`, trailing dots and spaces go, reserved
 * names get a `_` prefix. `field` names the record field in the error when `raw` is not a string.
 */
export function safeSegment(raw: string, field = 'segment'): string {
  let s = requireText(raw, field).normalize('NFC').replace(FORBIDDEN, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (!s || s === '.' || s === '..') return '_';
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Cuts a string to `max` UTF-16 units without splitting a surrogate pair, and drops trailing dots and spaces. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(out)) out = out.slice(0, -1);
  return out.replace(/[. ]+$/, '') || '_';
}

/** `<name>__<sys_id><ext>`, the name made safe and cut to NAME_MAX; just `<sys_id><ext>` when there is no name. */
export function recordSegment(name: string | undefined, sysId: string, ext = '', field = 'name'): string {
  if (!SYS_ID.test(requireText(sysId, 'sys_id'))) throw new Error(`not a sys_id: ${sysId}`);
  const n = name === undefined || name === '' ? '' : safeSegment(name, field);
  return n && n !== '_' ? `${cut(n, NAME_MAX)}__${sysId}${ext}` : `${sysId}${ext}`;
}

const WITH_ID = /^(.*)__([0-9a-f]{32})(.*)$/i;

/**
 * A mirror-relative POSIX path that fits PATH_MAX once joined to `rootAbs`. Name parts of `<name>__<sys_id>`
 * segments are shortened, last segment first; sys_ids and other segments are never touched. Throws when
 * even nameless segments do not fit (the mirror root itself is too deep).
 */
export function fitPath(rootAbs: string, rel: string): string {
  const total = (segs: string[]) => rootAbs.length + 1 + segs.join('/').length;
  const segs = rel.split('/');
  if (total(segs) <= PATH_MAX) return rel;
  for (let i = segs.length - 1; i >= 0 && total(segs) > PATH_MAX; i--) {
    const m = WITH_ID.exec(segs[i]);
    if (!m) continue;
    const over = total(segs) - PATH_MAX;
    const name = cut(m[1], Math.max(0, m[1].length - over));
    segs[i] = name && name !== '_' && m[1].length > over ? `${name}__${m[2]}${m[3]}` : `${m[2]}${m[3]}`;
  }
  if (total(segs) > PATH_MAX) throw new Error(`mirror path too long even without names (${total(segs)} > ${PATH_MAX}): move the project to a shorter folder`);
  return segs.join('/');
}
