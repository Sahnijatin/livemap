import type { Dep, Field, Route } from './types.js';

/** A route with the router mount prefixes applied; `id` = `${method} ${fullPath} ${file}:${line}`. */
export interface ApiRoute extends Route { id: string; file: string; fullPath: string; mountedVia?: string[] }
/** One table merged across every ORM model and SQL statement that defines it. */
export interface Table {
  name: string; table: string; orm: string;
  sources: { file: string; line: number }[];
  fields: (Field & { file: string })[];
  relations: { field: string; to: string; many: boolean; via: 'fk' | 'relation' }[];
}
export interface Tech {
  id: string; name: string;
  category: 'frontend' | 'backend' | 'mobile' | 'database' | 'orm' | 'language' | 'tooling' | 'styling' | 'testing' | 'ai';
  /** The manifest that declares it, or `files` for language and Dockerfile detection. */
  source: string;
}
export interface EnvVar { name: string; files: string[]; inExample: boolean; definedInEnvFile: boolean }
export interface DomainIndex {
  routes: ApiRoute[];
  tables: Table[];
  dataRefs: { file: string; tables: string[] }[];
  stack: Tech[];
  deps: (Dep & { file: string })[];
  scripts: { file: string; name: string; command: string }[];
  env: EnvVar[];
  counts: { routes: number; pages: number; screens: number; tables: number; deps: number; env: number };
}

