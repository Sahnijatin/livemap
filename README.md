# LiveMap

LiveMap shows you, live, what an AI coding agent is building in your project. It runs locally as a CLI and a browser UI: a file tree with functions, an Activity feed of plain-language change cards, and Schema, API and Stack views of the project.

```sh
livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]]
livemap init [dir=.] [--agents claude,codex,cursor] [--remove]
```

## What LiveMap understands

Code structure (files, functions, classes, imports) comes from real parsers and is exact. Routes, screens, schema, dependencies and environment variables are read with patterns over source text, so they are **approximate**: every item links to its source file and line so you can check it, and links found by name matching (relations, "uses table") are labeled approximate in the UI.

| Area | Sources |
|---|---|
| API routes | Express, Fastify (including `route({...})` and `register` prefixes), Hono (including `basePath`), Koa routers, NestJS (`@Controller` and verb decorators), Next.js app router (`route.ts` verb exports) and pages router (`pages/api`), SvelteKit (`+server.ts`), FastAPI (`APIRouter` prefixes, `include_router`), Flask (blueprints, `url_prefix`), Django (`urls.py` with `path`, `re_path` and `include`), Go net/http (1.22 method patterns), gin, chi, Spring (`@RequestMapping` and verb mappings), Rails (`config/routes.rb`), Laravel (`routes/*.php`). Router mounts (`app.use('/api', router)` and the like) are followed into the mounted file, up to 5 levels. Next.js routes count only when a `next` dependency is declared. |
| Pages and screens | Next.js `page.tsx` and pages router files, SvelteKit `+page.svelte`, Expo Router files under an `app/` folder with a `_layout.tsx`, React Navigation `<X.Screen name=... />`, Flutter GoRouter `GoRoute(path: ...)`. |
| Schema | SQL `CREATE TABLE` and `ALTER TABLE ... ADD` in `.sql` files (and in TypeScript, JavaScript, Python and Go files whose path contains `migration`), Prisma (`model` blocks, `@@map`, `@relation`), Drizzle (`pgTable`, `mysqlTable`, `sqliteTable`), TypeORM, Mongoose, SQLAlchemy (classic `Column` and `Mapped`), SQLModel, Django models, Room (Kotlin and Java `@Entity`), SwiftData (`@Model`). Definitions of the same table from several sources merge into one card, so a migration that adds a column shows on the model's table. |
| Dependency manifests | `package.json` (with scripts), `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `build.gradle` and `build.gradle.kts`, `pubspec.yaml`, `Podfile`. |
| Environment variables | Names read in code: `process.env`, `import.meta.env`, `Deno.env.get`, `os.environ`, `os.getenv`, `os.Getenv`, `os.LookupEnv`, `env::var`, `ENV[]`, `ENV.fetch`, `getenv`, `$_ENV`, `env()`, `System.getenv`. Keys declared in `.env.example`, `.env.sample` and `.env.template` (and variants such as `.env.local.example`). Real `.env` files contribute key names only: their values are never read into the analyzers, stored or sent to the browser. |
| Stack detection | Frameworks, ORMs, databases, styling, testing, AI SDKs and tooling from declared dependencies (for example React, Next.js, Vue, Svelte, Express, NestJS, FastAPI, Flask, Django, gin, Axum, Spring Boot, Rails, Laravel, Expo, Flutter, Prisma, Drizzle, SQLAlchemy), Docker from any `Dockerfile`, and languages with at least 3 files or 10% of the code files. |

## Credits

The Schema view is drawn with [React Flow](https://reactflow.dev) (MIT license) and laid out with [ELK](https://eclipse.dev/elk/) through elkjs (EPL-2.0 license).
