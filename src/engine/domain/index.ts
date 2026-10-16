import type { CodeSymbol, Dep, Entity, Lang, Mount, Route, Rule } from '../../shared/types.js';
import { deps } from './deps.js';
import { env } from './env.js';
import { routesJs } from './routes-js.js';
import { routesOther } from './routes-other.js';
import { schemaJs } from './schema-js.js';
import { schemaMobile } from './schema-mobile.js';
import { schemaPy } from './schema-py.js';
import { schemaSql } from './schema-sql.js';
import { screens } from './screens.js';

export interface DomainFacts {
  routes: Route[];
  entities: Entity[];
  env: string[];
  deps?: { deps: Dep[]; scripts?: Record<string, string> };
  mounts: Omit<Mount, 'target'>[];
  /** Symbols that replace the parser's for this file (a platform whose files the grammars do not read). */
  symbols?: CodeSymbol[];
  rules?: Rule[];
}

/** A pattern-based extractor; `applies` gates it by path and language so unrelated files cost nothing. */
export interface Analyzer {
  name: string;
  applies(rel: string, lang: Lang): boolean;
  run(rel: string, lang: Lang, text: string): Partial<DomainFacts>;
  /**
   * Project files this file depends on beyond its language's imports (a ServiceNow script naming a script
   * include, a page placing a widget). `has` says whether a path exists. Merged into `imports.local` on
   * every build and relink.
   */
  links?(rel: string, lang: Lang, text: string, has: (path: string) => boolean): string[];
}

export const ANALYZERS: Analyzer[] = [deps, env, routesJs, routesOther, screens, schemaJs, schemaSql, schemaPy, schemaMobile];

const logged = new Set<string>();

/** Runs every applying analyzer; one that throws loses only its own facts and is logged once per name. */
export function analyzeFile(rel: string, lang: Lang, text: string, analyzers = ANALYZERS): DomainFacts {
  const out: DomainFacts = { routes: [], entities: [], env: [], mounts: [] };
  const names = new Set<string>();
  for (const a of analyzers) {
    let facts: Partial<DomainFacts>;
    try {
      if (!a.applies(rel, lang)) continue;
      facts = a.run(rel, lang, text);
    } catch (e) {
      if (!logged.has(a.name)) {
        logged.add(a.name);
        process.stderr.write(`livemap: analyzer ${a.name} failed on ${rel}: ${(e as Error)?.message ?? String(e)}\n`);
      }
      continue;
    }
    if (facts.routes) out.routes.push(...facts.routes);
    if (facts.entities) out.entities.push(...facts.entities);
    if (facts.mounts) out.mounts.push(...facts.mounts);
    if (facts.env) for (const k of facts.env) names.add(k);
    if (facts.deps && !out.deps) out.deps = facts.deps;
    if (facts.symbols) out.symbols = [...(out.symbols ?? []), ...facts.symbols];
    if (facts.rules?.length) out.rules = [...(out.rules ?? []), ...facts.rules];
  }
  out.routes.sort((a, b) => a.line - b.line || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
  out.env = [...names].sort();
  return out;
}
