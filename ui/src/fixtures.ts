import type { ChangeSummary, CodeSymbol, FileModel } from '@shared/types.js';

/** Test helpers: minimal valid models. */
export function file(path: string, symbols: CodeSymbol[] = [], extra: Partial<FileModel> = {}): FileModel {
  return {
    path, lang: 'typescript', size: 10, lines: 3, symbols,
    imports: { local: [], external: [] }, routes: [], entities: [], env: [], flags: {},
    ...extra,
  };
}

export function sym(name: string, kind: CodeSymbol['kind'] = 'function', line = 1, children: CodeSymbol[] = [], qname = name): CodeSymbol {
  return { name, qname, kind, signature: `${name}()`, line, endLine: line + 1, exported: true, hash: name, children };
}

let nextId = 1;
export function change(path: string, kind: ChangeSummary['kind'] = 'modified', extra: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    id: nextId++, path, kind, at: Date.now(), lang: 'typescript',
    symbols: { added: [], removed: [], modified: [] },
    routes: { added: [], removed: [] },
    entities: { added: [], removed: [], changed: [] },
    imports: { added: [], removed: [], externalAdded: [] },
    env: { added: [], removed: [] },
    lines: { added: 0, removed: 0 }, hunks: [], truncated: false,
    ...extra,
  };
}
