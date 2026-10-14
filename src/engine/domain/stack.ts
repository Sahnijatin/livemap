import type { Tech } from '../../shared/domain.js';
import type { Dep, FileModel, Lang } from '../../shared/types.js';

type Category = Tech['category'];
/** id, display name, category, and the dep names that trigger it (`x/*` matches a prefix, Go module names also match `/vN` suffixes). */
type Rule = [id: string, name: string, category: Category, deps: string[]];

/** The complete v1 list, in display order of categories. */
const RULES: Rule[] = [
  ['react', 'React', 'frontend', ['react']],
  ['next', 'Next.js', 'frontend', ['next']],
  ['vue', 'Vue', 'frontend', ['vue']],
  ['nuxt', 'Nuxt', 'frontend', ['nuxt']],
  ['svelte', 'Svelte', 'frontend', ['svelte']],
  ['sveltekit', 'SvelteKit', 'frontend', ['@sveltejs/kit']],
  ['solid', 'Solid', 'frontend', ['solid-js']],
  ['astro', 'Astro', 'frontend', ['astro']],
  ['angular', 'Angular', 'frontend', ['@angular/core']],
  ['express', 'Express', 'backend', ['express']],
  ['fastify', 'Fastify', 'backend', ['fastify']],
  ['hono', 'Hono', 'backend', ['hono']],
  ['koa', 'Koa', 'backend', ['koa']],
  ['nestjs', 'NestJS', 'backend', ['@nestjs/core']],
  ['fastapi', 'FastAPI', 'backend', ['fastapi']],
  ['flask', 'Flask', 'backend', ['flask']],
  ['django', 'Django', 'backend', ['django']],
  ['gin', 'Gin', 'backend', ['github.com/gin-gonic/gin']],
  ['chi', 'chi', 'backend', ['github.com/go-chi/chi']],
  ['echo', 'Echo', 'backend', ['github.com/labstack/echo']],
  ['axum', 'Axum', 'backend', ['axum']],
  ['actix-web', 'Actix Web', 'backend', ['actix-web']],
  ['spring', 'Spring Boot', 'backend', ['org.springframework.boot:*']],
  ['rails', 'Rails', 'backend', ['rails']],
  ['laravel', 'Laravel', 'backend', ['laravel/framework']],
  ['expo', 'Expo', 'mobile', ['expo']],
  ['react-native', 'React Native', 'mobile', ['react-native']],
  ['flutter', 'Flutter', 'mobile', ['flutter']],
  ['prisma', 'Prisma', 'orm', ['prisma', '@prisma/client']],
  ['drizzle', 'Drizzle', 'orm', ['drizzle-orm']],
  ['typeorm', 'TypeORM', 'orm', ['typeorm']],
  ['mongoose', 'Mongoose', 'orm', ['mongoose']],
  ['sqlalchemy', 'SQLAlchemy', 'orm', ['sqlalchemy']],
  ['sqlmodel', 'SQLModel', 'orm', ['sqlmodel']],
  ['room', 'Room', 'orm', ['androidx.room:*']],
  ['postgres', 'PostgreSQL', 'database', ['pg']],
  ['mysql', 'MySQL', 'database', ['mysql2']],
  ['sqlite', 'SQLite', 'database', ['better-sqlite3']],
  ['mongodb', 'MongoDB', 'database', ['mongodb']],
  ['redis', 'Redis', 'database', ['redis', 'ioredis']],
  ['psycopg', 'Psycopg', 'database', ['psycopg', 'psycopg2', 'psycopg-binary', 'psycopg2-binary']],
  ['supabase', 'Supabase', 'database', ['@supabase/supabase-js']],
  ['firebase', 'Firebase', 'database', ['firebase']],
  ['tailwindcss', 'Tailwind CSS', 'styling', ['tailwindcss']],
  ['styled-components', 'styled-components', 'styling', ['styled-components']],
  ['sass', 'Sass', 'styling', ['sass']],
  ['vitest', 'Vitest', 'testing', ['vitest']],
  ['jest', 'Jest', 'testing', ['jest']],
  ['pytest', 'pytest', 'testing', ['pytest']],
  ['playwright', 'Playwright', 'testing', ['@playwright/test']],
  ['openai', 'OpenAI SDK', 'ai', ['openai']],
  ['anthropic', 'Anthropic SDK', 'ai', ['@anthropic-ai/sdk', 'anthropic']],
  ['langchain', 'LangChain', 'ai', ['langchain']],
  ['ai', 'Vercel AI SDK', 'ai', ['ai']],
  ['vite', 'Vite', 'tooling', ['vite']],
  ['typescript', 'TypeScript', 'tooling', ['typescript']],
  ['webpack', 'webpack', 'tooling', ['webpack']],
  ['turbo', 'Turborepo', 'tooling', ['turbo']],
];

const CATEGORY_ORDER: Category[] = ['frontend', 'backend', 'mobile', 'orm', 'database', 'styling', 'testing', 'ai', 'tooling', 'language'];

const LANGUAGES: [id: string, name: string, langs: Lang[]][] = [
  ['typescript', 'TypeScript', ['typescript', 'tsx']],
  ['javascript', 'JavaScript', ['javascript']],
  ['python', 'Python', ['python']],
  ['go', 'Go', ['go']],
  ['rust', 'Rust', ['rust']],
  ['java', 'Java', ['java']],
  ['kotlin', 'Kotlin', ['kotlin']],
  ['swift', 'Swift', ['swift']],
  ['dart', 'Dart', ['dart']],
  ['ruby', 'Ruby', ['ruby']],
  ['php', 'PHP', ['php']],
  ['csharp', 'C#', ['csharp']],
];
const MIN_LANG_FILES = 3;
const MIN_LANG_SHARE = 0.1;

/** Python package names compare case-insensitively with `_` and `.` equal to `-` (PEP 503). */
const norm = (d: Dep): string => (d.eco === 'pypi' ? d.name.toLowerCase().replace(/[_.]+/g, '-') : d.name);

const exact = new Map<string, Rule>();
const prefixes: [string, Rule][] = [];
for (const r of RULES) {
  for (const n of r[3]) {
    if (n.endsWith(':*')) prefixes.push([n.slice(0, -1), r]);
    else exact.set(n, r);
  }
}

function ruleFor(d: Dep): Rule | undefined {
  const name = norm(d);
  const hit = exact.get(name) ?? prefixes.find(([p]) => name.startsWith(p))?.[1];
  if (hit || d.eco !== 'go') return hit;
  // Go major versions: `github.com/go-chi/chi/v5`.
  return exact.get(name.replace(/\/v\d+$/, ''));
}

const isDockerfile = (p: string): boolean => /^Dockerfile(\.[\w-]+)?$/.test(p.slice(p.lastIndexOf('/') + 1)) && !/\.md$/i.test(p);

/** Techs from declared dependencies (first manifest by path wins as `source`), Dockerfiles and language file counts. */
export function detectStack(deps: (Dep & { file: string })[], files: FileModel[]): Tech[] {
  const out = new Map<string, Tech>();
  const sorted = [...deps].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const d of sorted) {
    const r = ruleFor(d);
    if (r && !out.has(r[0])) out.set(r[0], { id: r[0], name: r[1], category: r[2], source: d.file });
  }
  if (files.some(f => isDockerfile(f.path)) && !out.has('docker')) out.set('docker', { id: 'docker', name: 'Docker', category: 'tooling', source: 'files' });

  const counts = new Map<Lang, number>();
  for (const f of files) counts.set(f.lang, (counts.get(f.lang) ?? 0) + 1);
  const perLang = LANGUAGES.map(([id, name, langs]) => [id, name, langs.reduce((n, l) => n + (counts.get(l) ?? 0), 0)] as const);
  const code = perLang.reduce((n, [, , c]) => n + c, 0);
  const langs: Tech[] = perLang
    .filter(([, , c]) => c > 0 && (c >= MIN_LANG_FILES || c >= code * MIN_LANG_SHARE))
    .map(([id, name]) => ({ id, name, category: 'language', source: 'files' }));

  // Ids stay unique: a detected language replaces the same-named tooling dep (TypeScript).
  for (const l of langs) out.delete(l.id);
  const rank = (t: Tech) => CATEGORY_ORDER.indexOf(t.category);
  const byName = (a: Tech, b: Tech) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'en');
  return [...out.values(), ...langs].sort(byName);
}
