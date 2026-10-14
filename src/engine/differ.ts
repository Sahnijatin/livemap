import { structuredPatch } from 'diff';
import type { ChangeSummary, CodeSymbol, Dep, Entity, FileModel, Hunk, SymRef } from '../shared/types.js';
import type { UpdateResult } from './project.js';
import { flattenSymbols } from './symbols/index.js';

const MAX_HUNK_LINES = 800;

const symKey = (s: CodeSymbol): string => `${s.kind === 'function' || s.kind === 'method' ? 'fn' : s.kind}:${s.qname}`;
const ref = (s: CodeSymbol): SymRef => ({ name: s.name, qname: s.qname, kind: s.kind, signature: s.signature, line: s.line });

function keyed<T>(list: T[], key: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const t of list) if (!m.has(key(t))) m.set(key(t), t);
  return m;
}

/**
 * Keys every symbol as `<group>:<qname>#<n>`, n being its occurrence among same-key symbols in
 * document order, so overloads, property getter/setter pairs and repeated headings all count.
 */
function keyedSymbols(list: CodeSymbol[]): Map<string, CodeSymbol> {
  const seen = new Map<string, number>();
  const m = new Map<string, CodeSymbol>();
  for (const s of list) {
    const k = symKey(s);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    m.set(`${k}#${n}`, s);
  }
  return m;
}

function diffSymbols(before: FileModel | null, after: FileModel | null): ChangeSummary['symbols'] {
  const b = keyedSymbols(flattenSymbols(before?.symbols ?? []));
  const a = keyedSymbols(flattenSymbols(after?.symbols ?? []));
  const out: ChangeSummary['symbols'] = { added: [], removed: [], modified: [] };
  for (const [k, s] of a) {
    const old = b.get(k);
    if (!old) out.added.push(ref(s));
    else if (old.hash !== s.hash) {
      const signatureChanged = old.signature !== s.signature;
      out.modified.push({ ...ref(s), signatureChanged, ...(signatureChanged ? { before: old.signature } : {}) });
    }
  }
  for (const [k, s] of b) if (!a.has(k)) out.removed.push(ref(s));
  return out;
}

function diffEntities(before: Entity[], after: Entity[]): ChangeSummary['entities'] {
  const b = keyed(before, e => e.name);
  const a = keyed(after, e => e.name);
  const out: ChangeSummary['entities'] = { added: [], removed: [], changed: [] };
  for (const [name, e] of a) {
    const old = b.get(name);
    if (!old) { out.added.push({ name, fields: e.fields.length, orm: e.orm }); continue; }
    const of = keyed(old.fields, f => f.name);
    const nf = keyed(e.fields, f => f.name);
    const addedFields = [...nf.keys()].filter(n => !of.has(n));
    const removedFields = [...of.keys()].filter(n => !nf.has(n));
    const changedFields = [...nf.keys()].filter(n => of.has(n) && JSON.stringify(of.get(n)) !== JSON.stringify(nf.get(n)));
    if (addedFields.length || removedFields.length || changedFields.length) out.changed.push({ name, addedFields, removedFields, changedFields });
  }
  for (const name of b.keys()) if (!a.has(name)) out.removed.push({ name });
  return out;
}

function diffDeps(before: FileModel | null, after: FileModel | null): ChangeSummary['deps'] | undefined {
  if (!before?.deps && !after?.deps) return undefined;
  const dk = (d: Dep) => `${d.eco}:${d.name}${d.dev ? ':dev' : ''}`;
  const b = keyed(before?.deps?.deps ?? [], dk);
  const a = keyed(after?.deps?.deps ?? [], dk);
  const out: NonNullable<ChangeSummary['deps']> = { added: [], removed: [], changed: [] };
  for (const [k, d] of a) {
    const old = b.get(k);
    if (!old) out.added.push(d);
    else if (old.version !== d.version) out.changed.push({ ...d, from: old.version });
  }
  for (const [k, d] of b) if (!a.has(k)) out.removed.push(d);
  return out;
}

const minus = (x: string[], y: string[]): string[] => { const s = new Set(y); return x.filter(i => !s.has(i)); };

function diffText(beforeText: string, afterText: string): { added: number; removed: number; hunks: Hunk[]; truncated: boolean } {
  const patch = structuredPatch('a', 'b', beforeText, afterText, '', '', { context: 3 });
  let added = 0, removed = 0, emitted = 0, truncated = false;
  const hunks: Hunk[] = [];
  for (const h of patch.hunks) {
    const lines = h.lines.filter(l => !l.startsWith('\\'));
    for (const l of lines) { if (l[0] === '+') added++; else if (l[0] === '-') removed++; }
    if (truncated) continue;
    const room = MAX_HUNK_LINES - emitted;
    if (lines.length > room) {
      truncated = true;
      if (room > 0) hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines: lines.slice(0, room) });
      emitted = MAX_HUNK_LINES;
    } else {
      hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
      emitted += lines.length;
    }
  }
  return { added, removed, hunks, truncated };
}

export function buildChange(u: UpdateResult, id: number, now = Date.now()): ChangeSummary {
  const { before, after } = u;
  const ref0 = after ?? before;
  const bi = before?.imports ?? { local: [], external: [] };
  const ai = after?.imports ?? { local: [], external: [] };
  const benv = before?.env ?? [];
  const aenv = after?.env ?? [];
  const br = keyed(before?.routes ?? [], r => `${r.method} ${r.path}`);
  const ar = keyed(after?.routes ?? [], r => `${r.method} ${r.path}`);

  const secret = !!(before?.flags.secret || after?.flags.secret);
  const opaque = !!(before?.flags.binary || after?.flags.binary || before?.flags.tooLarge || after?.flags.tooLarge);
  const env = { added: minus(aenv, benv), removed: minus(benv, aenv) };

  let lines = { added: 0, removed: 0 };
  let hunks: Hunk[] = [];
  let truncated = false;
  if (secret) lines = { added: env.added.length, removed: env.removed.length };
  else if (!opaque) {
    const d = diffText(u.beforeText ?? '', u.afterText ?? '');
    lines = { added: d.added, removed: d.removed };
    hunks = d.hunks;
    truncated = d.truncated;
  }

  const deps = diffDeps(before, after);
  return {
    id, path: u.path, kind: u.kind, at: now, lang: ref0 ? ref0.lang : 'other',
    symbols: diffSymbols(before, after),
    routes: { added: [...ar].filter(([k]) => !br.has(k)).map(([, r]) => r), removed: [...br].filter(([k]) => !ar.has(k)).map(([, r]) => r) },
    entities: diffEntities(before?.entities ?? [], after?.entities ?? []),
    imports: { added: minus(ai.local, bi.local), removed: minus(bi.local, ai.local), externalAdded: minus(ai.external, bi.external) },
    ...(deps ? { deps } : {}),
    env, lines, hunks, truncated,
  };
}
