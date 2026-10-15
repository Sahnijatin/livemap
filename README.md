# LiveMap

LiveMap shows you, live, what an AI coding agent is building in your project. It runs locally as a CLI and a browser UI: a file tree with functions, an Activity feed of plain-language change cards, and Schema, API and Stack views of the project.

```sh
livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]]
livemap init [dir=.] [--agents claude,codex,cursor] [--remove]
```

## Using LiveMap

- **Tabs.** Activity is the live feed of prompts, messages and change cards. Map draws every code file as a card inside its folder's region, colored by layer and linked by imports. Schema, API and Stack show the tables, routes and technologies LiveMap found. Tab badges count what each view holds.
- **Map levels.** Folders shows one card per folder with its file, symbol, route and table counts (double-click or press Enter to open its files). Files shows a card per file. Functions adds each file's symbols, with new ones tinted green and changed ones orange. Projects with more than 500 code files open at Folders; open a folder to see its files.
- **Live map.** The file an agent is writing glows orange, new files spring in from a related file, and new links draw in a green-to-blue gradient for a few seconds. Existing cards never reshuffle: a growing folder only pushes the folders below it down.
- **Follow.** With Follow on (the default), the camera eases to the file the agent is writing. Panning or zooming pauses it for 8 seconds ("Paused" shows next to the switch).
- **Pins and Reset layout.** Drag a card to move it. It stays there, across reloads, for this project in this browser. "Reset layout" in the map's options menu (the "⋯" button) clears every pin and lays the map out again.
- **Search everything.** Press ⌘K (Ctrl+K on Windows and Linux) to search files, functions, routes and tables. Enter opens the result in the inspector and brings it into view in the current tab.
- **Narrow windows and phones.** Below 1080 px the file tree and the inspector become slide-over panels opened from the toolbar. On a phone the tabs show icons only, the toolbar condenses, and the map's level and Follow move into its options menu.

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

The Map and Schema views are drawn with [React Flow](https://reactflow.dev) (MIT license) and laid out with [ELK](https://eclipse.dev/elk/) through elkjs (EPL-2.0 license). Motion uses [Framer Motion](https://github.com/motiondivision/motion) (framer-motion, MIT license), and the ⌘K palette uses [cmdk](https://github.com/pacocoursey/cmdk) (MIT license).

## Development

`npm run build && npx playwright test` runs the end-to-end suite. The Map frame budget (median frame 16.7 ms or less, p95 25 ms or less while panning 500 files) is asserted only with `LIVEMAP_PERF_STRICT=1 npx playwright test tests/e2e/map.spec.ts` on a machine with a GPU; otherwise the test logs the numbers and checks for long tasks.
