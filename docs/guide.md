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
```

`dir` is the project folder in every command. It defaults to the current folder. `-h` or `--help` prints the usage. Options that take a value also accept `=` (`--port=5000`, `--agents=claude`, `--out=shop.html`), except `--pull`, which takes its value only after `=`.

### `livemap`

Indexes the project, starts the local server and opens the UI in your browser.

| Option | Default | What it does |
|---|---|---|
| `--port N` | `4317` | The first port to try. If it is taken, LiveMap tries the next 20 ports. `--port 0` lets the system pick one. |
| `--no-open` | the browser opens | Does not open a browser. Open the URL LiveMap prints instead. |
| `--pull[=SEC]` | off; `--pull` alone pulls every 15 seconds | Runs `git pull --ff-only` every SEC seconds (5 to 3600), for agents that push to a remote. See [agents.md](agents.md#cloud-builders-git-and---pull). |
| `--no-history` | history is recorded | Records nothing; the timeline says "History is off". |
| `--summaries` | off | Turns on AI summaries for this run. You still need to configure a provider (a key, or a local Ollama). See [AI summaries](#ai-summaries). |

On start LiveMap prints `LiveMap is watching <project>` and the URL, which includes the access token (`http://127.0.0.1:<port>/?t=<token>`). The browser it opens gets a one-time link instead, valid for 2 minutes. Stop LiveMap with Ctrl+C.

One LiveMap runs per project. Starting a second one on the same folder exits with "LiveMap is already running for this project (pid N) at http://127.0.0.1:PORT"; use that one or stop it first. The lock is a file in `~/.livemap/locks/` (or under `LIVEMAP_HOME`) and records the pid and port of the LiveMap holding it. The running LiveMap refreshes the lock every 30 seconds. A lock is replaced when its process is no longer running or no longer listens on its port. A lock left by a LiveMap that stopped before it started listening is also replaced once it has gone 3 minutes without a refresh, as after a crash or restart that left its pid to another program.

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

### Environment variables

| Variable | What it does |
|---|---|
| `LIVEMAP_HOME` | Where LiveMap keeps its data. Default `~/.livemap`. |
| `LIVEMAP_HISTORY_MB` | History size cap per project, in MB. Default 200. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Keys for AI summaries when the config has no `apiKey`. |
| `CLAUDE_CONFIG_DIR` | Where LiveMap looks for Claude Code transcripts. Default `~/.claude`. |

## Using LiveMap

- **Tabs.** Activity is the live feed of prompts, messages and change cards. Map draws every code file as a card inside its folder's region, colored by layer and linked by imports. Schema, API and Stack show the tables, routes and technologies LiveMap found. Tab badges count what each view holds.
- **Map levels.** Folders shows one card per folder with its file, symbol, route and table counts (double-click or press Enter to open its files). Files shows a card per file. Functions adds each file's symbols, with new ones tinted green and changed ones orange. Projects with more than 500 code files open at Folders; open a folder to see its files.
- **Live map.** The file an agent is writing glows orange, new files spring in from a related file, and new links draw in a green-to-blue gradient for a few seconds. Existing cards never reshuffle: a growing folder only pushes the folders below it down.
- **Follow.** With Follow on (the default), the camera eases to the file the agent is writing. Panning or zooming pauses it for 8 seconds ("Paused" shows next to the switch).
- **Pins and Reset layout.** Drag a card to move it. It stays there, across reloads, for this project in this browser. "Reset layout" in the map's options menu (the "⋯" button) clears every pin and lays the map out again.
- **Search everything.** Press ⌘K (Ctrl+K on Windows and Linux) to search files, functions, routes and tables. Enter opens the result in the inspector and brings it into view in the current tab.
- **Steering.** "Pause agent" in the toolbar and the Flag boxes send instructions to a connected agent. The inspector shows a Flag box for the open file, and, with no file open, a "Flag the project" box in its Live session panel. See [agents.md](agents.md#flag-and-pause).
- **Narrow windows and phones.** Below 1080 px the file tree and the inspector become slide-over panels opened from the toolbar. On a phone the tabs show icons only, the toolbar condenses, and the map's level and Follow move into its options menu.

## History and the timeline

LiveMap records what the UI receives (file changes, agent prompts, messages and tool calls, sessions, flags and summaries) so you can scroll back through a session.

- **Timeline.** The bar under the center view shows colored ticks for prompts, messages, tool calls, changes and commits. Drag the thumb (or use the arrow keys, Home and End) to rewind the whole UI: the Activity feed, file tree, Map, Schema, API and Stack all show the project as it was. The timeline then reads `REWOUND` and a banner says "Viewing <time>. Changes made since then are hidden." Click "Back to live" (or release the thumb at the right end) to return to `LIVE`. Play replays the session from the start, or from where you rewound, eight times faster than it happened (long pauses are cut short), and stops when it reaches live.
- **Read-only past.** While rewound, the Flag box, Pause and dragging Map cards are disabled. The code view shows the file as it is now, with a notice, because past file contents are not stored.
- **Restarts.** Each start of LiveMap begins a new run, marked on the timeline with a separator, so you can scrub back into earlier runs.
- **Storage.** History lives in `~/.livemap/projects/<id>/` (or under `LIVEMAP_HOME` when it is set), where `<id>` is the SHA-1 of the project's real path. It holds one `events-<run>.jsonl` file per run, gzip snapshots in `snapshots/` and an `index.json`. Folders are readable only by you (mode 0700, files 0600). History contains only what the UI already received, so `.env` values never appear in it.
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
- `--no-code` leaves source code out: file contents, diff lines and agent tool inputs and outputs. Shell tool calls keep only the command name (`$ npm`), and fenced code blocks (backtick or tilde) and inline `code` spans in prompts, agent messages and thinking, session titles, change intents and other tool labels are replaced with `[code removed]`; the rest of that text stays, including code that is not marked as code, such as indented blocks. Other tool labels (such as `Edit src/a.ts` or `Search "name"`) otherwise stay, as do file, function and route names and signatures, commit messages, flags and AI summaries stay. Without it the file embeds the current contents of every file the history touches, so the code view works offline, and LiveMap prints: "This export contains source code for <n> files. Share it only with people who may see this code."
- `--out FILE` sets the file name. The default is `livemap-<project>-<YYYYMMDD-HHMM>.html` in the current folder.

The export loads nothing from the network. Secret, binary and over-1 MB files are never embedded. Outside the embedded code, your project's absolute path is removed: paths become relative to the project, and the bare project path becomes the project name.

## What LiveMap understands

Code structure (files, functions, classes, imports) comes from real parsers and is exact. Routes, screens, schema, dependencies and environment variables are read with patterns over source text, so they are **approximate**: every item links to its source file and line so you can check it, and links found by name matching (relations, "uses table") are labeled approximate in the UI.

Structure is parsed with tree-sitter for TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Kotlin, C#, PHP, Ruby, Swift, C, C++ and Dart.

| Area | Sources |
|---|---|
| API routes | Express, Fastify (including `route({...})` and `register` prefixes), Hono (including `basePath`), Koa routers, NestJS (`@Controller` and verb decorators), Next.js app router (`route.ts` verb exports) and pages router (`pages/api`), SvelteKit (`+server.ts`), FastAPI (`APIRouter` prefixes, `include_router`), Flask (blueprints, `url_prefix`), Django (`urls.py` with `path`, `re_path` and `include`), Go net/http (1.22 method patterns), gin, chi, Spring (`@RequestMapping` and verb mappings), Rails (`config/routes.rb`), Laravel (`routes/*.php`). Router mounts (`app.use('/api', router)` and the like) are followed into the mounted file, up to 5 levels. Next.js routes count only when a `next` dependency is declared. |
| Pages and screens | Next.js `page.tsx` and pages router files, SvelteKit `+page.svelte`, Expo Router files under an `app/` folder with a `_layout.tsx`, React Navigation `<X.Screen name=... />`, Flutter GoRouter `GoRoute(path: ...)`. |
| Schema | SQL `CREATE TABLE` and `ALTER TABLE ... ADD` in `.sql` files (and in TypeScript, JavaScript, Python and Go files whose path contains `migration`), Prisma (`model` blocks, `@@map`, `@relation`), Drizzle (`pgTable`, `mysqlTable`, `sqliteTable`), TypeORM, Mongoose, SQLAlchemy (classic `Column` and `Mapped`), SQLModel, Django models, Room (Kotlin and Java `@Entity`), SwiftData (`@Model`). Definitions of the same table from several sources merge into one card, so a migration that adds a column shows on the model's table. |
| Dependency manifests | `package.json` (with scripts), `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, `build.gradle` and `build.gradle.kts`, `pubspec.yaml`, `Podfile`. |
| Environment variables | Names read in code: `process.env`, `import.meta.env`, `Deno.env.get`, `os.environ`, `os.getenv`, `os.Getenv`, `os.LookupEnv`, `env::var`, `ENV[]`, `ENV.fetch`, `getenv`, `$_ENV`, `env()`, `System.getenv`. Keys declared in `.env.example`, `.env.sample` and `.env.template` (and variants such as `.env.local.example`). Real `.env` files contribute key names only: their values are never read into the analyzers, stored or sent to the browser. |
| Stack detection | Frameworks, ORMs, databases, styling, testing, AI SDKs and tooling from declared dependencies (for example React, Next.js, Vue, Svelte, Express, NestJS, FastAPI, Flask, Django, gin, Axum, Spring Boot, Rails, Laravel, Expo, Flutter, Prisma, Drizzle, SQLAlchemy), Docker from any `Dockerfile`, and languages with at least 3 files or 10% of the code files. |
