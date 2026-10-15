import type { Lang, Mount, Route } from '../../shared/types.js';
import type { Analyzer } from './index.js';
import { blankStrings, defaultExport, filePath, handlerOf, lineAt, maskCommentsAndStrings, normPath, resetScanBudget, scanBudget, splitArgs } from './util.js';

type MountFact = Omit<Mount, 'target'>;
/** `assigned` marks a name set from a router factory in this file, which is also accepted as `this.<name>`. */
/** `guessed`: a conventional name in a file without a server import, a route only when it looks like one (see `routeLike`). */
interface Receiver { fw: string; prefix: string; assigned?: true; guessed?: true }

const LANGS = new Set<Lang>(['typescript', 'tsx', 'javascript', 'svelte']);
const FILE_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const FILE_VERB = FILE_VERBS.join('|');
const KOA = new Set(['@koa/router', 'koa-router']);
const SERVER_MODULES = new Set(['express', 'fastify', 'hono', ...KOA]);
const DEFAULT_RECEIVERS = ['app', 'router', 'server', 'api'];
const INLINE = /^(?:async\b|function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
const STRING = /^(['"`])([^'"`\n]*)\1$/;
const ID = '[A-Za-z_$][\\w$]*';
/** Longest import clause read; real ones are short, and the cap keeps a run of bare `import` words linear. */
const MAX_CLAUSE = 2000;

const literal = (arg: string | undefined): string | null => {
  const m = arg ? STRING.exec(arg) : null;
  return m && !m[2].includes('${') ? m[2] : null;
};
const isPath = (p: string | null): p is string => p !== null && (p.startsWith('/') || p === '*');

/** Local name to module specifier, from ES imports and CommonJS requires. */
function importsOf(code: string, scan: string): Map<string, string> {
  const out = new Map<string, string>();
  const stop = /['"`;]/g;
  let next = -1;
  for (const m of scan.matchAll(/\bimport\s/g)) {
    const from = m.index + m[0].length;
    if (next < from) { stop.lastIndex = from; next = stop.exec(scan)?.index ?? code.length; }
    const q = code[next];
    if ((q !== "'" && q !== '"') || next - from > MAX_CLAUSE) continue;
    const quoted = q === '"' ? /"([^"\n]+)"/y : /'([^'\n]+)'/y;
    quoted.lastIndex = next;
    const spec = quoted.exec(code)?.[1];
    const clause = code.slice(from, next).trim();
    if (!spec || !clause.endsWith('from')) continue;
    let rest = clause.slice(0, -4).trim().replace(/^type\s+/, '');
    const braces = /\{([^}]*)\}/.exec(rest);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const names = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
        const local = names[names.length - 1].trim();
        if (local) out.set(local, spec);
      }
      rest = rest.replace(braces[0], '');
    }
    for (const part of rest.split(',')) {
      const t = part.trim().replace(/^\*\s*as\s+/, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.set(t, spec);
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}=;]{0,500}\})\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    if (scan[m.index] !== code[m.index]) continue;
    if (!m[1].startsWith('{')) { out.set(m[1], m[3]); continue; }
    for (const part of m[1].slice(1, -1).split(',')) {
      const local = part.split(':').pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) out.set(local, m[3]);
    }
  }
  return out;
}

/** Framework of a router constructor or factory name, by its import or its well-known name. */
function ctorFramework(name: string, imports: Map<string, string>, fileFw: string): string | null {
  const spec = imports.get(name);
  if (spec && KOA.has(spec)) return 'koa';
  if (spec === 'hono' || name === 'Hono') return 'hono';
  if (spec === 'fastify' || name === 'Fastify' || name === 'fastify') return 'fastify';
  if (spec === 'express' || name === 'express') return 'express';
  if (name === 'Router') return fileFw === 'koa' ? 'koa' : 'express';
  return null;
}

/** `const x =`, `this.x =`, or a class field `private x =` at the start of a line. */
const ASSIGN = new RegExp(`(?:\\b(?:const|let|var)\\s+|(?<![\\w$.])this\\s*\\.\\s*|^[ \\t]*(?:(?:private|public|protected|readonly|static)\\s+)*)(${ID})\\s*(?::[^=\\n]{0,200})?=(?![=>])\\s*`, 'gm');
const THIS_RECEIVERS = new Set(['app', 'router', 'server']);

/**
 * Router receivers of this file: identifiers assigned from a router factory, plus the conventional names.
 * Without a server import those names are only guessed (`api.get('/users')` is usually an HTTP client),
 * so their calls count as routes only when they look like route registrations (see `routeLike`).
 */
function receiversOf(code: string, scan: string, imports: Map<string, string>, fileFw: string): Map<string, Receiver> {
  const recv = new Map<string, Receiver>();
  const importsServer = [...imports.values()].some(s => SERVER_MODULES.has(s) || s.startsWith('hono/'));
  const guessed = importsServer ? {} : { guessed: true as const };
  for (const n of DEFAULT_RECEIVERS) if (importsServer || !imports.has(n)) recv.set(n, { fw: fileFw, prefix: '', ...guessed });
  if (importsServer || !imports.has('fastify')) recv.set('fastify', { fw: 'fastify', prefix: '', ...guessed });
  const basePathFrom = new RegExp(`(${ID})\\s*\\.\\s*basePath\\s*\\(\\s*(['"\`])([^'"\`\\n]*)\\2\\s*\\)`, 'y');
  const init = new RegExp(`(?:await\\s+)?(?:new\\s+)?(${ID})(\\s*\\.\\s*Router)?\\s*(?:<[^>\\n]{0,200}>)?\\s*\\(`, 'y');
  const basePath = /\s*\.\s*basePath\s*\(\s*(['"`])([^'"`\n]*)\1\s*\)/y;
  for (const m of scan.matchAll(ASSIGN)) {
    const name = m[1];
    const at = m.index + m[0].length;
    basePathFrom.lastIndex = at;
    const bp = basePathFrom.exec(code);
    if (bp && recv.has(bp[1])) {
      const from = recv.get(bp[1])!;
      recv.set(name, { fw: from.fw, prefix: from.prefix + '/' + bp[3], assigned: true });
      continue;
    }
    init.lastIndex = at;
    const im = init.exec(code);
    const fw = !im ? null : im[2] ? (im[1] === 'express' ? 'express' : null) : ctorFramework(im[1], imports, fileFw);
    if (!im || !fw) { recv.delete(name); continue; }
    basePath.lastIndex = splitArgs(code, init.lastIndex - 1).end;
    const b = basePath.exec(code);
    recv.set(name, { fw, prefix: b ? '/' + b[2] : '', assigned: true });
  }
  return recv;
}

/** The module a mounted router came from: an imported identifier (or member of one) or an inline import/require. */
function specOf(arg: string | undefined, imports: Map<string, string>): string | null {
  if (!arg) return null;
  const dyn = /^(?:await\s+)?(?:import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)$/.exec(arg);
  if (dyn) return dyn[2];
  const id = /^([A-Za-z_$][\w$]*)(?:\s*\.\s*[\w$]+(?:\s*\(\s*\))?)*$/.exec(arg);
  return id ? imports.get(id[1]) ?? null : null;
}

/** Longest type argument list skipped between a verb and its call. */
const MAX_TYPE_ARGS = 500;

/**
 * Index of the `(` that calls the member ending at `i`, past optional TypeScript type arguments
 * (`post<{ Body: User }>(`); -1 when no call follows. `=>` inside the type arguments is not a closer.
 */
function callOpen(scan: string, i: number): number {
  const ws = (k: number): number => { while (k < scan.length && k - i < MAX_TYPE_ARGS && /\s/.test(scan[k])) k++; return k; };
  let k = ws(i);
  if (scan[k] === '<' && scanBudget() > 0) {
    const stop = Math.min(scan.length, k + MAX_TYPE_ARGS);
    let depth = 0;
    let j = k;
    for (; j < stop; j++) {
      const c = scan[j];
      if (c === '<') depth++;
      else if (c === '>' && scan[j - 1] !== '=' && --depth === 0) break;
    }
    // Charged to the scan budget so a run of unclosed `<` stays linear in file size.
    resetScanBudget(scanBudget() - (j - k));
    if (j >= stop) return -1;
    k = ws(j + 1);
  }
  return scan[k] === '(' ? k : -1;
}

function codeRoutes(code: string, scan: string): { routes: Route[]; mounts: MountFact[] } {
  const routes: Route[] = [];
  const mounts: MountFact[] = [];
  const imports = importsOf(code, scan);
  const specs = [...imports.values()];
  const fileFw = specs.some(s => KOA.has(s)) ? 'koa'
    : specs.some(s => s === 'hono' || s.startsWith('hono/')) ? 'hono'
      : specs.includes('fastify') ? 'fastify' : 'express';
  const recv = receiversOf(code, scan, imports, fileFw);
  const add = (method: string, path: string, handler: string | undefined, index: number, r: Receiver): void => {
    const route: Route = { method, path: normPath(r.prefix + '/' + path), line: lineAt(code, index), kind: 'api', framework: r.fw };
    if (handler) route.handler = handler;
    routes.push(route);
  };
  const mount = (prefix: string, spec: string | null, index: number, r: Receiver): void => {
    if (spec) mounts.push({ prefix: normPath(r.prefix + '/' + prefix), spec, line: lineAt(code, index), framework: r.fw });
  };

  const call = new RegExp(`(?<![\\w$.])(this\\s*\\.\\s*)?(${ID})\\s*\\.\\s*(get|post|put|patch|delete|options|head|all|on|use|route|register)\\b`, 'g');
  const chained = /\s*\.\s*(get|post|put|patch|delete|options|head|all)\b/y;
  const then = /\s*\.\s*(?:then|catch)\s*\(/y;
  /** A guessed receiver's call at `end` registers a route; `used` when the chain's value is consumed. */
  const ok = (r: Receiver, rest: string[], used: boolean, end: number): boolean => {
    if (!r.guessed) return true;
    then.lastIndex = end;
    return routeLike(rest, used || then.test(scan));
  };
  /** `verb(path, ...handlers)` and any `.verb(path, ...)` calls chained after it. */
  const verbCalls = (verb: string, args: string[], index: number, end: number, r: Receiver, used: boolean): void => {
    for (;;) {
      let rest = args.slice(1);
      let path = literal(args[0]);
      if (!isPath(path) && r.fw === 'koa' && isPath(literal(args[1]))) { path = literal(args[1]); rest = args.slice(2); }
      if (isPath(path) && ok(r, rest, used, end)) add(verb === 'all' ? 'ANY' : verb.toUpperCase(), path, handlerOf(rest), index, r);
      chained.lastIndex = end;
      const c = chained.exec(scan);
      const open = c ? callOpen(scan, chained.lastIndex) : -1;
      if (!c || open < 0 || scanBudget() <= 0) return;
      ({ args, end } = splitArgs(code, open));
      verb = c[1];
      index = c.index + c[0].indexOf(c[1]);
    }
  };
  for (const m of scan.matchAll(call)) {
    if (scanBudget() <= 0) break;
    const r = recv.get(m[2]);
    if (!r || (m[1] && !r.assigned && !THIS_RECEIVERS.has(m[2]))) continue;
    const verb = m[3];
    const open = callOpen(scan, m.index + m[0].length);
    if (open < 0) continue;
    const { args, end } = splitArgs(code, open);
    const used = !!r.guessed && valueUsed(scan, m.index);
    if (verb === 'use') {
      const prefix = literal(args[0]);
      if (isPath(prefix) && args.length > 1) mount(prefix, specOf(args[args.length - 1], imports), m.index, r);
    } else if (verb === 'register') {
      const prefix = args[1] ? /\bprefix\s*:\s*(['"`])([^'"`\n]*)\1/.exec(args[1]) : null;
      if (prefix) mount(prefix[2], specOf(args[0], imports), m.index, r);
    } else if (verb === 'on') {
      const path = literal(args[1]);
      if (!isPath(path) || !args[0]) continue;
      const methods = args[0].startsWith('[') ? [...args[0].matchAll(/['"`]([A-Za-z]+)['"`]/g)].map(x => x[1]) : [literal(args[0])].filter((x): x is string => !!x);
      if (!ok(r, args.slice(2), used, end)) continue;
      for (const method of methods) add(method.toUpperCase(), path, handlerOf(args.slice(2)), m.index, r);
    } else if (verb === 'route') {
      if (args.length > 1) {
        const prefix = literal(args[0]);
        if (isPath(prefix)) mount(prefix, specOf(args[1], imports), m.index, r);
      } else if (args[0]?.startsWith('{')) {
        routeOptions(args[0], m.index, r, add);
      } else {
        const path = literal(args[0]);
        if (!isPath(path)) continue;
        chained.lastIndex = end;
        for (let c = chained.exec(scan); c && scanBudget() > 0; c = chained.exec(scan)) {
          const open = callOpen(scan, chained.lastIndex);
          if (open < 0) break;
          const cargs = splitArgs(code, open);
          if (ok(r, cargs.args, used, cargs.end)) add(c[1] === 'all' ? 'ANY' : c[1].toUpperCase(), path, handlerOf(cargs.args), c.index + c[0].indexOf(c[1]), r);
          chained.lastIndex = cargs.end;
        }
      }
    } else {
      verbCalls(verb, args, m.index, end, r, used);
    }
  }
  return { routes, mounts };
}

const FN_ARG = /^(?:async\s+)?(?:function\b|(?:\([^()]*\)|[\w$]+)\s*(?::[^=]{0,200})?=>)/;
/**
 * Whether `arg` is a handler reference or a middleware factory call: `list`, `ctl.show`, `requireAuth()`,
 * `validate(schema)`, `h.bind(ctl)`. Names, dots and balanced call parentheses only, so an expression such as
 * `a(x) || b(y)` or a literal is not one.
 */
function refArg(arg: string): boolean {
  const a = arg.trim();
  const id = /[A-Za-z_$][\w$]*/y;
  id.lastIndex = 0;
  if (!id.test(a)) return false;
  let i = id.lastIndex;
  while (i < a.length) {
    while (/\s/.test(a[i] ?? '')) i++;
    if (a[i] === '.') {
      i++;
      while (/\s/.test(a[i] ?? '')) i++;
      id.lastIndex = i;
      if (!id.test(a)) return false;
      i = id.lastIndex;
    } else if (a[i] === '(') {
      let depth = 0;
      for (; i < a.length; i++) {
        const q = a[i];
        if (q === "'" || q === '"' || q === '`') {
          // Parentheses inside a string argument (`match(')')`) do not count.
          for (i++; i < a.length && a[i] !== q; i++) if (a[i] === '\\') i++;
        } else if (q === '(') depth++;
        else if (q === ')' && --depth === 0) break;
      }
      if (depth !== 0) return false;
      i++;
    } else if (i < a.length) {
      return false;
    }
  }
  return true;
}
/** Request parts and config, passed to an HTTP client bare or as members (`body`, `req.body`, `opts`). */
const REQUEST_PARTS = new Set(['body', 'data', 'payload', 'params', 'query', 'config', 'cfg', 'conf', 'options', 'opts', 'init', 'headers', 'form', 'formdata', 'values', 'input', 'signal']);
/** Nouns that are payloads as bare variables (`api.post('/u', user)`) but handlers as members (`ctl.user`). */
const PAYLOAD_NOUNS = new Set(['event', 'evt', 'user', 'item', 'record', 'entity', 'file', 'blob']);
/** Calls that build a request body, not a handler (`api.post('/u', JSON.stringify(user))`). */
const CLIENT_CALLS = new Set(['JSON.stringify', 'String', 'Number', 'Boolean', 'encodeURIComponent', 'encodeURI', 'URLSearchParams', 'FormData', 'Blob']);
/** Words after which an expression's value is used. */
const USING_WORDS = new Set(['await', 'return', 'void', 'yield', 'typeof', 'new', 'throw', 'in', 'of', 'case', 'delete', 'instanceof']);
/**
 * Line ends that continue an expression onto the next line: `=`, `,`, `(`, `[`, `?`, `:`, `&&`, `||`, `!`, `.`,
 * `=>`. `+`, `-`, `*`, `/`, `<` and `>` are left out: lines ending in `x++`, a regex literal or a generic
 * type end statements far more often than they break an expression across lines.
 */
const CONTINUES = /(?:[=,(\[?:&|!.]|=>)$/;
/**
 * Whether the call starting at `index` is part of a larger expression rather than a statement of its own:
 * route registrations are statements, while a client call's value is awaited, returned, assigned, passed
 * on, put in an array or used in a condition. On its own line, a call is a statement unless the line before
 * ends in something that continues an expression (code without semicolons); after code on the same line it
 * is one only after `;`, `{`, `}` or `)` (`if (x) app.get(...)`).
 */
function valueUsed(scan: string, index: number): boolean {
  let i = index - 1;
  let newline = false;
  while (i >= 0 && /\s/.test(scan[i])) { if (scan[i] === '\n') newline = true; i--; }
  if (i < 0) return false;
  const c = scan[i];
  if (/[\w$]/.test(c)) {
    let j = i;
    while (j > 0 && /[\w$]/.test(scan[j - 1])) j--;
    return USING_WORDS.has(scan.slice(j, i + 1));
  }
  if (newline) return CONTINUES.test(scan.slice(Math.max(0, i - 1), i + 1));
  return !(c === ';' || c === '{' || c === '}' || c === ')');
}
/**
 * Route registrations, as opposed to HTTP client calls: an inline function, or only handler references
 * (the last not named like a payload or config) in a call whose value is not used.
 */
function routeLike(rest: string[], used: boolean): boolean {
  if (rest.some(a => FN_ARG.test(a.trim()))) return true;
  if (used || !rest.length || !rest.every(refArg)) return false;
  const last = rest[rest.length - 1].trim();
  // A factory call names its handler before the parentheses: `validate(schema)` is `validate`.
  const callee = last.replace(/\s*\([^]*$/, '').replace(/\s+/g, '');
  if (callee !== last.replace(/\s+/g, '')) return !CLIENT_CALLS.has(callee.replace(/^new/, ''));
  const seg = callee.slice(callee.lastIndexOf('.') + 1).toLowerCase();
  if (REQUEST_PARTS.has(seg)) return false;
  // A bare noun is a payload; as a member (`ctl.user`, `stripe.event`) it is a controller's handler.
  return callee.includes('.') || !PAYLOAD_NOUNS.has(seg);
}

/** Fastify `route({ method, url, handler })`; a method array gives one route per method. */
function routeOptions(obj: string, index: number, r: Receiver, add: (m: string, p: string, h: string | undefined, i: number, r: Receiver) => void): void {
  const url = /\b(?:url|path)\s*:\s*(['"`])([^'"`\n]*)\1/.exec(obj);
  const method = /\bmethod\s*:\s*(?:(['"`])([A-Za-z]+)\1|\[([^\]]*)\])/.exec(obj);
  if (!url || !isPath(url[2]) || !method) return;
  const methods = method[2] ? [method[2]] : [...method[3].matchAll(/['"`]([A-Za-z]+)['"`]/g)].map(x => x[1]);
  const h = /\bhandler\b\s*(:?)\s*/.exec(obj);
  let handler: string | undefined;
  if (h) {
    const after = obj.slice(h.index + h[0].length);
    if (!h[1]) handler = after.startsWith('(') ? 'inline' : 'handler';
    else if (INLINE.test(after)) handler = 'inline';
    else handler = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(after)?.[0];
  }
  for (const m of methods) add(m.toUpperCase(), url[2], handler, index, r);
}

const NEST_VERB = /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(/g;
const NEST_DECORATOR = /\s*@[\w$.]+\s*/y;
const NEST_METHOD = new RegExp(`\\s*(?:(?:public|private|protected|static|async|override)\\s+)*(${ID})\\s*[(<]`, 'y');

/** NestJS: `@Controller(prefix)` classes and their verb-decorated methods. */
function nestRoutes(code: string, scan: string): Route[] {
  const ctrls: { index: number; prefix: string }[] = [];
  for (const m of scan.matchAll(/@Controller\s*\(/g)) {
    if (scanBudget() <= 0) break;
    const arg = splitArgs(code, m.index + m[0].length - 1).args[0];
    const obj = arg?.startsWith('{') ? /\bpath\s*:\s*(['"`])([^'"`\n]*)\1/.exec(arg) : null;
    ctrls.push({ index: m.index, prefix: obj ? obj[2] : literal(arg) ?? '' });
  }
  if (!ctrls.length) return [];
  const routes: Route[] = [];
  let ci = -1;
  for (const m of scan.matchAll(NEST_VERB)) {
    if (scanBudget() <= 0) break;
    while (ci + 1 < ctrls.length && ctrls[ci + 1].index < m.index) ci++;
    if (ci < 0) continue;
    const ctrl = ctrls[ci];
    const { args, end } = splitArgs(code, m.index + m[0].length - 1);
    const path = args.length ? literal(args[0]) : '';
    if (path === null) continue;
    const route: Route = {
      method: m[1] === 'All' ? 'ANY' : m[1].toUpperCase(), path: normPath(ctrl.prefix + '/' + path),
      line: lineAt(code, m.index), kind: 'api', framework: 'nest',
    };
    const handler = nestMethodName(scan, end);
    if (handler) route.handler = handler;
    routes.push(route);
  }
  return routes;
}

/** Name of the method after a decorator ending at `i`, skipping further decorators and modifiers. */
function nestMethodName(code: string, i: number): string | undefined {
  const dec = NEST_DECORATOR;
  for (let guard = 0; guard < 16; guard++) {
    dec.lastIndex = i;
    if (!dec.exec(code)) break;
    i = dec.lastIndex;
    if (code[i] === '(') i = splitArgs(code, i).end;
  }
  const name = NEST_METHOD;
  name.lastIndex = i;
  return name.exec(code)?.[1];
}

function verbExports(code: string): { verb: string; index: number }[] {
  const out: { verb: string; index: number }[] = [];
  const seen = new Set<string>();
  const push = (verb: string, index: number): void => { if (!seen.has(verb)) { seen.add(verb); out.push({ verb, index }); } };
  for (const m of code.matchAll(new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s*\\*?\\s*(${FILE_VERB})\\b`, 'g'))) push(m[1], m.index);
  for (const m of code.matchAll(new RegExp(`\\bexport\\s+(?:const|let|var)\\s+(${FILE_VERB})\\b`, 'g'))) push(m[1], m.index);
  for (const m of code.matchAll(/\bexport\s*\{([^}]{0,200})\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop()!.trim();
      if (FILE_VERBS.includes(name)) push(name, m.index);
    }
  }
  return out;
}

function page(path: string, code: string, framework: string, kind: Route['kind'] = 'page', method = 'PAGE'): Route {
  const d = defaultExport(code);
  const route: Route = { method, path, line: d.line, kind, framework };
  if (d.name) route.handler = d.name;
  return route;
}

/** Next.js and SvelteKit file-based routes; null when the file is not a routing file. */
function fileRoutes(rel: string, code: string): Route[] | null {
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  if (/^\+server\.(ts|js)$/.test(base) || base === '+page.svelte') {
    const at = segs.findIndex((s, i) => s === 'src' && segs[i + 1] === 'routes');
    if (at < 0) return null;
    const path = filePath(segs.slice(at + 2, -1));
    if (base === '+page.svelte') return [{ method: 'PAGE', path, line: 1, kind: 'page', framework: 'sveltekit' }];
    return verbExports(code).map(v => ({ method: v.verb, path, handler: v.verb, line: lineAt(code, v.index), kind: 'api', framework: 'sveltekit' }));
  }
  const app = segs.indexOf('app');
  const isRoute = /^route\.(ts|js)$/.test(base);
  if (app >= 0 && app < segs.length - 1 && (isRoute || /^page\.(tsx|jsx|ts|js)$/.test(base))) {
    const dirs = segs.slice(app + 1, -1);
    if (dirs.some(s => s.startsWith('_'))) return [];
    const path = filePath(dirs);
    if (!isRoute) return [page(path, code, 'next')];
    return verbExports(code).map(v => ({ method: v.verb, path, handler: v.verb, line: lineAt(code, v.index), kind: 'api', framework: 'next' }));
  }
  const pages = segs.indexOf('pages');
  const ext = /\.(tsx|jsx|ts|js)$/.exec(base);
  if (pages < 0 || pages === segs.length - 1 || !ext) return null;
  const name = base.slice(0, -ext[0].length);
  if (/\.(test|spec|d)$/.test(name)) return null;
  if (name === '_app' || name === '_document' || name === '_error') return [];
  const parts = [...segs.slice(pages + 1, -1), name];
  if (name === 'index') parts.pop();
  const path = filePath(parts);
  return parts[0] === 'api' ? [page(path, code, 'next', 'api', 'ANY')] : [page(path, code, 'next')];
}

/** HTTP routes and router mounts from JS/TS servers (Express, Fastify, Hono, Koa, NestJS) and file-based routers (Next.js, SvelteKit). */
export const routesJs: Analyzer = {
  name: 'routes-js',
  applies: (_rel, lang) => LANGS.has(lang),
  run(rel, lang, text) {
    const code = maskCommentsAndStrings(text, lang);
    const scan = blankStrings(code);
    resetScanBudget(2 * code.length + 50_000);
    const files = fileRoutes(rel, scan);
    if (files) return { routes: files };
    if (lang === 'svelte') return {};
    const { routes, mounts } = codeRoutes(code, scan);
    return { routes: [...routes, ...nestRoutes(code, scan)], mounts };
  },
};
