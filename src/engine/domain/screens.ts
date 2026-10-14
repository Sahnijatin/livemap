import type { Lang, Route } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { blankStrings, bracketPairs, defaultExport, filePath, lineAt, maskCommentsAndStrings, normPath, quotingOf, resetScanBudget, scanBudget, splitArgs } from './util.js';

const JS_LANGS = new Set<Lang>(['typescript', 'tsx', 'javascript']);
const EXPO_IMPORT = /\bfrom\s*(['"])expo-router\1|\brequire\s*\(\s*(['"])expo-router\2\s*\)/;
/** Longest JSX opening tag read for one screen's attributes. */
const MAX_TAG = 2000;

const screen = (path: string, handler: string | undefined, line: number, framework: string): Route => {
  const r: Route = { method: 'SCREEN', path, line, kind: 'screen', framework };
  if (handler) r.handler = handler;
  return r;
};

/**
 * Expo Router: a file under `app/` (the nearest such folder) that imports `expo-router` is a screen at its file path (`index` is
 * its folder). `_layout`, `+` special files and `page.*` (Next.js, see routes-js) give no screen.
 */
function expo(rel: string, code: string): Route[] {
  const segs = rel.split('/');
  const app = segs.lastIndexOf('app');
  const ext = /\.(tsx|ts|jsx|js)$/.exec(segs[segs.length - 1]);
  if (app < 0 || app === segs.length - 1 || !ext) return [];
  const name = segs[segs.length - 1].slice(0, -ext[0].length);
  if (name.startsWith('_') || name.includes('+') || name === 'page' || /\.(test|spec|d)$/.test(name)) return [];
  const parts = [...segs.slice(app + 1, -1), name];
  if (name === 'index') parts.pop();
  const d = defaultExport(code);
  return [screen(filePath(parts), d.name, d.line, 'expo-router')];
}

/** React Navigation `<X.Screen name="..." component={...} />` for any navigator `X`. */
function reactNavigation(code: string, scan: string): Route[] {
  const out: Route[] = [];
  let budget = 2 * code.length + 50_000;
  for (const m of scan.matchAll(/<\s*[A-Za-z_$][\w$]*\s*\.\s*Screen\b/g)) {
    if (budget <= 0) break;
    const start = m.index + m[0].length;
    const limit = Math.min(scan.length, start + MAX_TAG, start + budget);
    let depth = 0;
    let i = start;
    for (; i < limit; i++) {
      const c = scan[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth <= 0) break;
    }
    budget -= i - start;
    const tag = code.slice(start, i);
    const name = /\bname\s*=\s*(?:\{\s*)?(['"`])([^'"`\n]*)\1/.exec(tag);
    if (!name) continue;
    const comp = /\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$.]*)\s*\}/.exec(tag);
    out.push(screen(name[2], comp?.[1], lineAt(code, m.index), 'react-navigation'));
  }
  return out;
}

/** Flutter GoRouter `GoRoute(path: ...)`, with nested `routes:` paths joined to their parent's. */
function goRouter(code: string): Route[] {
  const q = quotingOf('dart');
  const scan = blankStrings(code, q);
  const out: Route[] = [];
  const pairs = bracketPairs(scan);
  const frames: { end: number; path: string }[] = [];
  resetScanBudget(2 * code.length + 50_000);
  for (const m of scan.matchAll(/(?<![\w$.])GoRoute\s*\(/g)) {
    if (scanBudget() <= 0) break;
    while (frames.length && frames[frames.length - 1].end <= m.index) frames.pop();
    const parent = frames.length ? frames[frames.length - 1].path : '';
    const { args, end } = splitArgs(code, m.index + m[0].length - 1, q, { pairs });
    const value = (key: string): string | undefined => args.find(a => a.startsWith(key + ':'))?.slice(key.length + 1).trim();
    const lit = /^(['"])([^'"\n]*)\1$/.exec(value('path') ?? '');
    const path = lit ? (parent ? `${parent}/${lit[2]}` : lit[2]) : parent;
    frames.push({ end, path });
    if (!lit) continue;
    const builder = value('builder');
    const page = value('pageBuilder');
    const handler = builder !== undefined
      ? /(?:=>|\breturn\b)\s*(?:const\s+|new\s+)?([A-Z][\w$]*)/.exec(builder)?.[1]
      : page !== undefined ? /\bchild\s*:\s*(?:const\s+)?([A-Z][\w$]*)/.exec(page)?.[1] : undefined;
    out.push(screen(normPath(path), handler, lineAt(code, m.index), 'gorouter'));
  }
  return out;
}

/** Mobile screens: Expo Router files, React Navigation screens and Flutter GoRouter routes. */
export const screens: Analyzer = {
  name: 'screens',
  applies: (_rel, lang) => JS_LANGS.has(lang) || lang === 'dart',
  run(rel, lang, text) {
    const code = maskCommentsAndStrings(text, lang);
    if (lang === 'dart') return { routes: goRouter(code) };
    const scan = blankStrings(code);
    const imp = EXPO_IMPORT.exec(code);
    if (imp && scan[imp.index] === code[imp.index]) return { routes: expo(rel, scan) };
    if (/(?:^|\/)_layout\.(tsx|ts|jsx|js)$/.test(rel)) return {};
    return { routes: reactNavigation(code, scan) };
  },
};
