# LiveMap guide

How to run LiveMap and what each part of the UI does. For agent setup see [agents.md](agents.md), and for what is stored and sent see [privacy.md](privacy.md).

- [Command line](#command-line)
- [Using LiveMap](#using-livemap)
- [History and the timeline](#history-and-the-timeline)
- [AI summaries](#ai-summaries)
- [Exporting a replay](#exporting-a-replay)
- [What LiveMap understands](#what-livemap-understands)

## Command line

```sh
livemap [dir=.] [--port N] [--no-open] [--pull[=SEC]] [--no-history] [--summaries]
livemap init [dir=.] [--agents claude,codex,cursor] [--remove]
livemap export [dir=.] [--session ID] [--no-code] [--out FILE]
livemap sn [dir=.] --scope NAMESPACE|SYS_ID [--instance NAME] [--nexus URL] [--port N] [--no-open] [--no-history] [--mirror-only]
```

`dir` is the project folder in every command. It defaults to the current folder. `-h` or `--help` prints the usage. Options that take a value also accept `=` (`--port=5000`, `--agents=claude`, `--out=shop.html`).

### `livemap`

Indexes the project, starts the local server and opens the UI in your browser.

| Option | Default | What it does |
|---|---|---|
| `--port N` | `4317` | The first port to try. If it is taken, LiveMap tries the next 20 ports. `--port 0` lets the system pick one. |
| `--no-open` | the browser opens | Does not open a browser. Open the URL LiveMap prints instead. |
| `--pull[=SEC]` / `--pull SEC` | off; `--pull` alone pulls every 15 seconds | Runs `git pull --ff-only` every SEC seconds (5 to 3600), for agents that push to a remote. Use `./30` for a folder named 30. See [agents.md](agents.md#cloud-builders-git-and---pull). |
| `--no-history` | history is recorded | Records nothing; the timeline says "History is off". |
| `--summaries` | off | Turns on AI summaries for this run. You still need to configure a provider (a key, or a local Ollama). See [AI summaries](#ai-summaries). |

On start LiveMap prints `LiveMap is watching <project>` and the URL, which includes the access token (`http://127.0.0.1:<port>/?t=<token>`). The browser it opens gets a one-time link instead, valid for 2 minutes. Stop LiveMap with Ctrl+C.

One LiveMap runs per project. Starting a second one on the same folder exits with "LiveMap is already running for this project (pid N) at http://127.0.0.1:PORT"; use that one or stop it first. If another LiveMap is still starting on the same folder, the new one exits with "Another LiveMap is starting for this project; try again in a moment". The lock is a file in `~/.livemap/locks/` (or under `LIVEMAP_HOME`) that records the pid, port and a random id of the LiveMap holding it. The running LiveMap refreshes the lock every 30 seconds. A lock is replaced when its process is no longer running, or when the program on its port answers with another id or not as LiveMap, as after a crash or restart that left its pid or port to another program. A lock whose LiveMap does not answer at all (still starting, shutting down after Ctrl+C, or suspended) is kept while it is being refreshed, and replaced after 3 minutes without a refresh.

LiveMap skips what your `.gitignore` files ignore and common build and dependency folders (`node_modules`, `dist`, `build`, `.next`, `.venv`, `target`, `vendor` and the like). It indexes at most 25,000 files and prints a warning when a project has more.

### `livemap init`

Adds LiveMap hooks to the project's agent config files. Details in [agents.md](agents.md#what-livemap-init-writes).

| Option | Default | What it does |
|---|---|---|
| `--agents claude,codex,cursor` | agents whose config folder (`.claude`, `.codex`, `.cursor`) exists in the project or your home folder | Sets up only these agents. |
| `--remove` | off | Removes LiveMap's hooks (from all three agents, or those named in `--agents`) and restores what init changed. |

### `livemap export`

Writes the recorded history as one HTML file. See [Exporting a replay](#exporting-a-replay).

| Option | Default | What it does |
|---|---|---|
| `--session ID` | the whole history | Exports one agent session only: its events and the changes attributed to it. |
| `--no-code` | code is embedded | Leaves source code out: file contents, diff lines and agent tool inputs and outputs. |
| `--out FILE` | `livemap-<project>-<YYYYMMDD-HHMM>.html` in the current folder | The output file. |

### `livemap sn`

Mirrors a ServiceNow application scope to files, then runs LiveMap on them. It reads the instance through SkyForge's nexus MCP, so keep SkyForge running. LiveMap holds no ServiceNow credentials and only calls nexus's read tools (`sn_query_table`, `sn_get_table_metadata`, `sn_get_instance_info`, `sn_session_context` and `tool_search`); it refuses any other tool.

| Option | Default | What it does |
|---|---|---|
| `--scope NAMESPACE\|SYS_ID` | required | The scope to mirror: its namespace (`x_snc_cc_offering`) or the sys_id of its `sys_scope` record. |
| `--instance NAME` | the instance nexus is set to | Sent to nexus as the `X-SN-Instance` header. |
| `--nexus URL` | `http://127.0.0.1:3006/mcp` | nexus's MCP endpoint. LiveMap tries Streamable HTTP first, then SSE. |
| `--port N` | `4317` | As for `livemap`. |
| `--no-open` | the browser opens | As for `livemap`. |
| `--no-history` | history is recorded | As for `livemap`. |
| `--mirror-only` | off | Writes the mirror and exits without starting the UI. |

Before it pulls, LiveMap prints the instance, the nexus transport and the scope it resolved (name, namespace and sys_id). It then reads the scope's `sys_metadata` inventory and the full records of every class, 200 at a time, and prints how many records it pulled and how long it took.

The mirror is written to `.livemap/sn/<scope>/` in `dir`, one folder per kind of record: `portal`, `page`, `widget`, `schema`, `business_rule`, `client_script`, `script_include`, `ui_action`, `ui_policy`, `acl`, `flow`, `rest`, `workspace`, `ai_agent` and `other`. Each record's file or folder is named `<name>__<sys_id>`, so a record keeps its identity when it is renamed (its file moves). Names are made safe for Windows, and paths stay under 240 characters. Widget instances live in their page's `layout.json`, dictionary entries in their table's `.sntable.json`, and ACL roles in their ACL.

On the map, a portal links to its home page, a page to its layout, a layout to the widgets it places, and a widget to its code. Scripts link to the script includes they call (`new Utils()`, `new x_scope.Utils()`, `gs.include`, `GlideAjax`) and to the scope tables they name, in a `GlideRecord` call or in any string that matches a mirrored table name. Rules, ACLs and UI actions link to their table.

Credential records (`sys_auth_profile*`, `oauth_entity*`, `discovery_credentials`) are listed by name only, fields named like passwords, secrets, tokens or keys are never written, and system properties are read without their values. The `.livemap` folder is readable only by you. When `dir` is inside a git repository, LiveMap adds `.livemap/` to its `.gitignore`; elsewhere it leaves `.gitignore` alone.

A second `livemap sn` on the same folder updates the mirror in place: unchanged files are not rewritten, and files of records that are gone or renamed are removed.

### Environment variables

| Variable | What it does |
|---|---|
| `LIVEMAP_HOME` | Where LiveMap keeps its data. Default `~/.livemap`. |
| `LIVEMAP_HISTORY_MB` | History size cap per project, in MB. Default 200. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Keys for AI summaries when the config has no `apiKey`. |
| `CLAUDE_CONFIG_DIR` | Where LiveMap looks for Claude Code transcripts. Default `~/.claude`. |
| `BROWSER` | The program that opens LiveMap's URL instead of the default browser, with any arguments (`chrome --incognito`). `%s` stands for the URL; without it the URL goes last. Quote a path with spaces, or give just the path. On Windows it can be a `.exe`, `.cmd` or `.bat` file. `none` opens nothing, like `--no-open`. |

## Using LiveMap

- **Tabs.** Activity is the live feed of prompts, messages, change cards and commits; a merge shows as one quiet line. Map draws every code file as a card inside its folder's region, colored by layer and linked by imports. Schema, API and Stack show the tables, routes and technologies LiveMap found. Schema lays tables out left to right in a wide pane and top to bottom in a tall or narrow one. API groups routes by path prefix, filters them by method, path or file, and draws a route's flow through handlers, services and tables only while you hover or select it (Esc clears the search, then the selection). Each route shows its file; click it to open the file. Tab badges count what each view holds.
- **Schema at scale.** Tables lists every table with its column and relation counts; search it by table or column name, and Esc clears the search. Click a table to focus it: the canvas zooms to it, lights its direct relations and dims the rest (Esc or a click on empty canvas ends the focus). Over 20 tables, the list opens beside the canvas (on a phone it is the main view, and Diagram shows the canvas), related tables are drawn in groups packed close together, tables with no relations sit in a compact grid, and lines to heavily linked tables such as users show only for the table you hover or focus. Over 150 tables, the canvas draws the 150 with the most relations and offers Show all.
- **File tree.** The Project panel nests folders as on disk, folders first. A folder with a single subfolder shares its row (`src/app/(admin)`). Each folder shows how many files it holds and a dot for its most common layer, and a closed folder marks a file the agent is writing or just changed inside it. Projects under 2,000 files start with every folder open; larger ones show only the top level. Open folders are remembered per project in this browser. The filter opens the folders above each match, and selecting a file anywhere opens its folders in the tree. Long names are cut in the middle so their ends stay visible. Arrow keys move, open and close; typing a name jumps to it.
- **Map levels.** Folders shows one card per folder with its file, symbol, route and table counts (double-click or press Enter to open its files). Files shows a card per file. Functions adds each file's symbols, with new ones tinted green and changed ones orange. Projects with more than 500 code files open at Folders; at Files and Functions they show only the folders you open, and a note under the map says how many are still closed. Long folder names are cut in the middle so their ends stay visible; hover a name for the full path.
- **Zoomed out.** Below about half size, folders turn into tinted areas with labels that keep their normal size on screen. New folders, then larger ones, get their label first; others show theirs as you zoom in or pan. New folders stay marked. The note, hint and zoom buttons sit in a bar below the map, so they never cover a card.
- **Layers.** A file's layer comes from its folder names (`components`, `routes`, `services`, `models` and the like). Code in a top-level `docs` or `documentation` folder (or one at the top of a monorepo package, like `packages/sdk/docs`) is Docs unless a folder or file name says otherwise, files in coding agents' folders (`.agents`, `.claude`, `.cursor`) are Config, and on the map a folder whose files are mostly Markdown (READMEs and changelogs aside) is Docs even when it holds a script.
- **Live map.** The file an agent is writing glows orange, new files spring in from a related file, and new links draw in a green-to-blue gradient for a few seconds. Existing cards never reshuffle: a growing folder only pushes the folders below it down.
- **Follow.** With Follow on (the default), the camera eases to the file the agent is writing. Panning or zooming pauses it for 8 seconds ("Paused" shows next to the switch).
- **Pins and Reset layout.** Drag a card to move it. It stays there, across reloads, for this project in this browser. "Reset layout" in the map's options menu (the "⋯" button) clears every pin and lays the map out again.
- **Search everything.** Press ⌘K (Ctrl+K on Windows and Linux) to search files, functions, routes and tables. Enter opens the result in the inspector and brings it into view in the current tab.
- **Steering.** "Pause agent" in the toolbar and the Flag boxes send instructions to a connected agent. The inspector shows a Flag box for the open file, and, with no file open, a "Flag the project" box in its Live session panel. That panel also lists the latest commits (author, files changed, time), apart from the agent's own steps. See [agents.md](agents.md#flag-and-pause).
- **Panels.** From 1080 px wide, drag the edge of the file tree or the inspector to resize it (double-click the edge to restore the default width), widen the inspector with the button in its header to give it all the room it can (the file tree narrows to its minimum and the center to 420 px; press it again to put both back; moving a panel with its edge ends the widened state and keeps the new widths), or hide either one with the button in its header or in the toolbar. `[` toggles the file tree and `]` the inspector. Selecting a file shows a hidden inspector. Widths and hidden panels are remembered in this browser.
- **Narrow windows and phones.** Below 1080 px the file tree and the inspector become slide-over panels opened from the toolbar (or with `[` and `]`). On a phone the tabs show icons only, the toolbar condenses, and the map's level and Follow move into its options menu.

## History and the timeline

LiveMap records what the UI receives (file changes, agent prompts, messages and tool calls, sessions, flags and summaries) so you can scroll back through a session.

- **Timeline.** The bar under the center view shows colored ticks for prompts, messages, tool calls, changes and commits. Drag the thumb (or use the arrow keys, Home and End) to rewind the whole UI: the Activity feed, file tree, Map, Schema, API and Stack all show the project as it was. The timeline then reads `REWOUND` and a banner says "Viewing <time>. Changes made since then are hidden." Click "Back to live" (or release the thumb at the right end) to return to `LIVE`. Play replays the session from the start, or from where you rewound, eight times faster than it happened (long pauses are cut short), and stops when it reaches live.
- **Read-only past.** While rewound, the Flag box, removing flags, Pause, Reset layout and dragging Map cards are disabled. The code view shows the file as it is now, with a notice, because past file contents are not stored.
- **Restarts.** Each start of LiveMap begins a new run, marked on the timeline with a separator, so you can scrub back into earlier runs.
- **Storage.** History lives in `~/.livemap/projects/<id>/` (or under `LIVEMAP_HOME` when it is set), where `<id>` is the SHA-1 of the project's real path. It holds one `events-<run>.jsonl` file per run, gzip snapshots in `snapshots/` and an `index.json`. Folders are readable only by you (mode 0700, files 0600). On Windows, which has no such modes, the permissions of your user profile folder protect them. History contains only what the UI already received, so `.env` values never appear in it.
- **Size cap.** Each project keeps at most 200 MB of history. Set `LIVEMAP_HISTORY_MB` to change it (for example `LIVEMAP_HISTORY_MB=500`). When a project goes over, its oldest runs are deleted first; the current run is never deleted. If the current run alone is over the cap, its older events are dropped and it keeps only its newest snapshot onward.
- **Turning it off.** Start with `livemap --no-history` to record nothing; the timeline then says "History is off". If history cannot be written (a full disk, for example), the live UI keeps working and shows "History is unavailable" with the reason. Rewinding then shows only what was recorded before the failure, and "Back to live" still returns to the current state without repeating or dropping updates.

## AI summaries

LiveMap can add one-line, plain-English summaries: a sentence on each change card that adds, removes or changes a function, route or table, and an "In plain English" block in the inspector for each file you open. Without summaries the inspector shows the agent's own words for the change, labeled "In the agent's words".

- **Opt-in.** Summaries are off by default. They turn on only when `~/.livemap/config.json` (or `$LIVEMAP_HOME/config.json`) has `"summaries": {"enabled": true}`, or when you start LiveMap with `--summaries`. An API key in your environment alone never turns them on.
- **Config.**

  ```json
  {
    "summaries": {
      "enabled": true,
      "provider": "anthropic",
      "apiKey": "your-api-key"
    }
  }
  ```

  `provider` is required when you set `apiKey`; LiveMap never guesses which provider a key belongs to. Without `apiKey`, a `url` with no `provider` means Ollama, and with neither, LiveMap uses `ANTHROPIC_API_KEY`, else `OPENAI_API_KEY`.

  Optional fields: `model` (overrides the default model), `url` (overrides the provider's base URL, for a proxy or a self-hosted endpoint) and `monthlyTokenCap`.
- **Providers.**

  | Provider | Default model | Key |
  |---|---|---|
  | `anthropic` | `claude-haiku-5-5` | `apiKey`, else `ANTHROPIC_API_KEY` |
  | `openai` | `gpt-6-luna` | `apiKey`, else `OPENAI_API_KEY` |
  | `ollama` | none: `model` is required | none; `url` defaults to `http://127.0.0.1:11434` (a `url` without `apiKey` or `provider` selects Ollama) |

- **Token cap.** Summaries use at most 2,000,000 tokens a month by default (`monthlyTokenCap` changes it). Use is counted in `~/.livemap/usage.json`; when the cap is reached, summaries stop until the next month. Every LiveMap process on your machine shares this count: each re-reads it before a request and adds its own spend to the file's current total after the request, so LiveMaps running at once share one cap, rarely lose spend, and can overshoot the cap by requests already in flight. The Stack tab's "AI summaries" box shows the provider, the model, its state and this month's use. Summaries are cached in `~/.livemap/cache/summaries/`, so the same file or change is not requested twice. Like the config, `usage.json` and the cache live under `LIVEMAP_HOME` when it is set.
- **Privacy.** Summary requests go only to the provider you configured. Secret files (such as `.env`), binary files and files over 1 MB are never sent. File summaries send at most the first 300 lines of a file; change summaries send the diff of the change: the changed lines plus up to 3 unchanged lines around each change. API keys are never logged, recorded in history or sent to the browser.

## Exporting a replay

`livemap export` writes the recorded history as one self-contained HTML file that you can open in any browser, offline and without LiveMap running. It opens at the end of the history and you can scrub, play and inspect it like the live UI.

```sh
livemap export                          # the whole history of the current folder
livemap export ~/code/shop --out shop.html
livemap export --session <id> --no-code
```

- `dir` is the project folder (the current one by default).
- `--session ID` exports only one agent session: its prompts, messages and tool calls and the changes attributed to it. The replay starts from the project state just before the session's first event (the nearest earlier record when the one right before it could not be read), or, if history was trimmed, from the state at the session's first event. That start state, and the start state of any LiveMap restart inside the session, keeps only this session's events and changes; file, route and table updates between the session's first and last event stay, so the Map and the other views stay accurate. By default the whole history is exported.
- `--no-code` leaves source code out: file contents, diff lines and agent tool inputs and outputs. Shell tool calls keep only the command name (`$ npm`), and fenced code blocks (backtick or tilde) and inline `code` spans in prompts, agent messages and thinking, commit messages, session titles, change intents, other tool labels, flag notes and AI summaries are replaced with `[code removed]`; the rest of that text stays, including code that is not marked as code, such as indented blocks. A code block ends only at a line holding nothing but its closing fence. Other tool labels (such as `Edit src/a.ts` or `Search "name"`) otherwise stay, as do file, function and route names and signatures. Without it the file embeds the current contents of every file the history touches, so the code view works offline, and LiveMap prints: "This export contains source code for <n> files. Share it only with people who may see this code."
- `--out FILE` sets the file name. The default is `livemap-<project>-<YYYYMMDD-HHMM>.html` in the current folder.

The export loads nothing from the network. Secret, binary and over-1 MB files are never embedded. Outside the embedded code, your project's absolute path is removed: paths become relative to the project, and the bare project path becomes the project name.

## What LiveMap understands

Code structure (files, functions, classes, imports) comes from real parsers and is exact. Routes, screens, schema, dependencies and environment variables are read with patterns over source text, so they are **approximate**: every item links to its source file and line so you can check it, and links found by name matching (relations, "uses table") are labeled approximate in the UI.

Structure is parsed with tree-sitter for TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Kotlin, C#, PHP, Ruby, Swift, C, C++ and Dart.

| Area | Sources |
|---|---|
| API routes | Express, Fastify (including `route({...})` and `register` prefixes), Hono (including `basePath`), Koa routers, NestJS (`@Controller` and verb decorators), Next.js app router (`route.ts` verb exports) and pages router (`pages/api`), SvelteKit (`+server.ts`), FastAPI (`APIRouter` prefixes, `include_router`), Flask (blueprints, `url_prefix`), Django (`urls.py` with `path`, `re_path` and `include`), Go net/http (1.22 method patterns), gin, chi, Spring (`@RequestMapping` and verb mappings), Rails (`config/routes.rb`), Laravel (`routes/*.php`). Router mounts (`app.use('/api', router)` and the like) are followed into the mounted file, up to 5 levels. Next.js routes count only when a `next` dependency is declared. In files that import no server framework, calls like `api.get('/users')` count only when they pass a handler, so HTTP client calls are not listed as routes. |
| Pages and screens | Next.js `page.tsx` and pages router files, SvelteKit `+page.svelte`, Expo Router files under an `app/` folder with a `_layout.tsx`, React Navigation `<X.Screen name=... />`, Flutter GoRouter `GoRoute(path: ...)`. |
| Schema | SQL `CREATE TABLE` and `ALTER TABLE ... ADD` in `.sql` files (and in TypeScript, JavaScript, Python and Go files whose path contains `migration`), Prisma (`model` blocks, `@@map`, `@relation`), Drizzle (`pgTable`, `mysqlTable`, `sqliteTable`), TypeORM, Mongoose, SQLAlchemy (classic `Column` and `Mapped`), SQLModel, Django models, Room (Kotlin and Java `@Entity`), SwiftData (`@Model`). Definitions of the same table from several sources merge into one card, so a migration that adds a column shows on the model's table. |
| Dependency manifests | `package.json` (with scripts), `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `build.gradle` and `build.gradle.kts` (dependency configurations such as `implementation`, `api`, `compileOnly`, `runtimeOnly`, `kapt` and `ksp` and their test and variant forms, with `libs.*` accessors resolved through `gradle/libs.versions.toml`), `pubspec.yaml`, `Podfile`. |
| Environment variables | Names read in code: `process.env` and `import.meta.env` (including destructuring such as `const { A, B } = process.env`), `Deno.env.get`, `os.environ`, `os.getenv`, `os.Getenv`, `os.LookupEnv`, `env::var`, `ENV[]`, `ENV.fetch`, `getenv`, `$_ENV`, `env()`, `System.getenv`. Keys declared in `.env.example`, `.env.sample` and `.env.template` (and variants such as `.env.local.example`). Real `.env` files contribute key names only: their values are never read into the analyzers, stored or sent to the browser. |
| Stack detection | Frameworks, ORMs, databases, styling, testing, AI SDKs and tooling from declared dependencies (for example React, Next.js, Vue, Svelte, Express, NestJS, FastAPI, Flask, Django, gin, Axum, Spring Boot, Rails, Laravel, Expo, Flutter, Prisma, Drizzle, SQLAlchemy), Docker from any `Dockerfile`, and languages with at least 3 files or 10% of the code files. |
