# LiveMap: design spec

Status: draft for review
Date: 2026-10-14
Owner: Jatin Sahni
Visual reference: `docs/design/prototype.html` (approved interactive prototype)

## 1. Summary

AI coding agents (Claude Code, Codex, Cursor, cloud builders like Emergent and Lovable) now write code faster than a developer can read it. Developers finish projects without knowing what files exist, what is inside them (functions, schema, routes), or how the parts connect.

LiveMap is a local tool that shows, live and in plain view, what an AI agent is building: every file, the functions and components inside it, the database schema, the API routes, the stack, and the agent's own reasoning for each change. The developer can flag a file or pause the agent from the UI when something looks wrong.

It ships as an npm package: `npx livemap` in a project folder starts a local server and opens a browser UI.

## 2. Goals and success criteria

**Who it's for:** developers who build with AI coding agents. LiveMap is a product shipped to other developers, under an open core model (free local tool, paid team features later).

**Core job (v1):** understand the build. At any moment, a user can answer "what is in my project, how does it fit together, and what did the agent just change and why?"

Success criteria:

1. Within 1 second of an agent saving a file, the UI shows that file's new structure and a meaningful summary of the change (symbols added, changed and removed, plus routes, tables and dependencies).
2. A user who has never read the code can name the main modules, the tables and the API routes of a 50-file project within 5 minutes of opening LiveMap.
3. Setup takes one command, plus one more to enable agent hooks. Nothing to compile, no native dependencies.
4. If LiveMap is not running, every agent behaves exactly as it would without it.
5. The UI feels like a premium product: bright, fluid, animated, responsive. It matches the approved prototype.

## 3. Scope

### In v1

- Live project model for JS/TS, Python, Go, Rust, Java/Kotlin, Swift, Dart (structure), plus stack-specific extraction for the frameworks listed in section 5.
- Views: Activity, Map, Schema, API, Stack, plus the file tree and inspector.
- Agent adapters: Claude Code, Codex CLI, Cursor, cloud builders through GitHub pull. Any other tool gets file-level tracking.
- Steering: flag a file or symbol with a note, pause or resume the agent.
- Session history with a timeline scrubber.
- Shareable read-only snapshot (single HTML file).
- Optional AI summaries using the user's own API key, and the agent's own words by default.

### Not in v1

- Exact call graphs and type-level references (later: an optional language-server plugin).
- Editing code inside LiveMap.
- Hosted or team features (sharing links, synced history). The architecture leaves room for them.
- Windsurf, Copilot, Aider, Cline, Gemini CLI adapters beyond file-level tracking. These can be added as adapters later.

## 4. Architecture

Approach chosen: file watcher plus tree-sitter parsing plus agent hooks. Rejected: language servers as the core (heavy setup, fragile across machines) and per-turn snapshots (not live).

```
 agent hooks / transcripts ──▶ adapters ──┐
                                          ├─▶ attribution ─▶ event store ─▶ WebSocket ─▶ UI
 file system ──▶ watcher ──▶ analyzers ──▶ differ ─┘                      ▲
                                 │                                         │
                                 └──▶ project model ◀── REST (file content, history)
```

### Units

Each unit has one job, a small interface and its own tests.

| Unit | Responsibility | Interface |
|---|---|---|
| `cli` | `livemap [dir]` starts the server and opens the browser. `livemap init [--agents]` installs hooks, `livemap init --remove` removes them. `livemap export` writes a snapshot. | Command line |
| `watcher` | Watches the project root, respects `.gitignore` and built-in ignores (node_modules, dist, build, venv, .git…). Debounces bursts per file (150 ms). Emits `{path, kind: add|change|unlink}`. | Event emitter |
| `analyzers` | Pure functions, `(path, lang, source, ctx) => facts`. One per concern: symbols, imports, routes, schema, deps, env. | Function per analyzer |
| `project model` | In-memory map of `path → FileModel`, plus derived indexes (graph, routes, entities, deps). Re-resolves imports when files appear or disappear. | `get`, `update(path)`, `snapshot()` |
| `differ` | Compares two `FileModel`s plus text and produces a `ChangeSummary`. | Function |
| `adapters` | One per agent. Normalize hook payloads and transcripts into `AgentEvent`s. | Event emitter |
| `attribution` | Links each `ChangeSummary` to the agent event that caused it and to the agent's preceding explanation. | Function plus short time window state |
| `store` | Append-only event log per project in `~/.livemap/projects/<hash>/`, with periodic model snapshots. Serves history and replay. | `append`, `range`, `stateAt(seq)` |
| `summarizer` | Optional. Queue of LLM calls for file and change summaries, cached by content hash, monthly token cap. | `summarizeFile`, `summarizeChange` |
| `control` | Flags and pause state. Answers the hooks' "may I proceed?" question. | `check(agentEvent) → allow | block(reason)` |
| `server` | HTTP (static UI, REST) and WebSocket (live events). Binds to 127.0.0.1 with a per-run token. | HTTP, WS |
| `ui` | React app, prebuilt and shipped inside the package. | Browser |

### Data model (shared types)

```ts
type FileModel = {
  path: string; lang: string; size: number; lines: number;
  symbols: Symbol[];               // nested tree
  imports: { local: string[]; external: string[] };
  routes: Route[]; entities: Entity[]; env: string[];
  deps?: { deps: Dep[]; scripts?: Record<string,string> };
  flags: { binary?: true; tooLarge?: true; secret?: true; parseError?: true };
};
type Symbol = { name: string; qname: string; kind: 'function'|'method'|'class'|'component'|'hook'|'interface'|'type'|'enum'|'struct'|'trait'|'module'|'variable'|'heading';
  signature: string; line: number; endLine: number; exported: boolean; hash: string; children: Symbol[] };
type Route = { method: string; path: string; handler?: string; line: number };
type Entity = { name: string; table: string; orm: string; file: string; line: number; fields: Field[] };
type Field = { name: string; type: string; pk?: true; required?: true; unique?: true; fk?: { table: string; field: string }; relation?: { model: string; many: boolean } };

type ChangeSummary = {
  path: string; kind: 'created'|'modified'|'deleted'; at: number;
  symbols: { added: SymRef[]; removed: SymRef[]; modified: (SymRef & { signatureChanged: boolean; before?: string })[] };
  routes: { added: Route[]; removed: Route[] };
  entities: { added: EntityRef[]; removed: EntityRef[]; changed: { name: string; addedFields: string[]; removedFields: string[]; changedFields: string[] }[] };
  imports: { added: string[]; removed: string[]; externalAdded: string[] };
  deps?: { added: Dep[]; removed: Dep[]; changed: Dep[] };
  env: { added: string[]; removed: string[] };
  lines: { added: number; removed: number }; hunks: Hunk[];
  attribution?: { agent: string; sessionId: string; toolUseId?: string; confidence: 'exact'|'likely'; intent?: string };
  summary?: string; // AI one-liner when enabled
};

type AgentEvent = { agent: 'claude-code'|'codex'|'cursor'|'git'|'other'; sessionId: string; at: number;
  type: 'prompt'|'message'|'thinking'|'tool_start'|'tool_end'|'commit'|'status';
  text?: string; tool?: { id?: string; name: string; label: string; input?: unknown; output?: string; ok?: boolean; paths?: string[] } };
```

Everything the UI shows is derived from two streams: `ChangeSummary` events and `AgentEvent`s, plus `FileModel` updates. The store keeps all three, which makes history, replay and snapshot export the same code path.

## 5. Project model

### Structure (exact, from a real parser)

Tree-sitter grammars run as WebAssembly (`web-tree-sitter` with prebuilt grammars), so there is no native build step on any platform.

| Language | Symbols extracted |
|---|---|
| TypeScript / JavaScript / TSX / JSX | functions, arrow-function constants, classes, methods, React components (capitalized, returns JSX), hooks (`useX`), interfaces, types, enums, namespaces, top-level constants |
| Vue / Svelte | the component plus symbols in its `<script>` block |
| Python | functions, classes, methods, decorators |
| Go | functions, methods (with receiver), structs, interfaces, types |
| Rust | functions, structs, enums, traits, impl blocks with methods, modules |
| Java / Kotlin | classes, interfaces, enums, records, methods, constructors |
| Swift | classes, structs, protocols, functions |
| Dart / Flutter | classes, mixins, functions, methods |
| C# / PHP / Ruby / C / C++ | classes and functions (best effort) |
| Markdown | heading outline |

Each symbol carries its signature, line range, exported flag and a content hash (used to detect modifications).

### Links

- Imports resolved to project files for JS/TS (including tsconfig/jsconfig `paths` aliases and `@/`), Python (absolute and relative), Go (module path from go.mod), Rust (`mod`, `use crate::`), Java/Kotlin (package path), Ruby (`require_relative`), C/C++ (`#include "…"`). Unresolved imports are recorded as external packages.
- "Used by" at the function level: an exported symbol name that appears in a file importing its file. Labeled *approximate* in the UI.

### Stack-specific extraction (pattern matching, labeled with source file)

| Area | Frameworks |
|---|---|
| Routes | Express, Fastify, Hono, Koa-style routers, NestJS, Next.js app and pages routers, SvelteKit, FastAPI, Flask (with blueprints), Django URLs, Go net/http (1.22 patterns), gin, chi, Spring, Rails routes, Laravel |
| Screens | Expo Router (file-based), React Navigation (`Stack.Screen name=`), Flutter GoRouter (`GoRoute(path:)`) |
| Schema | SQL migrations and `CREATE TABLE`/`ALTER TABLE` in any file, Prisma, Drizzle, TypeORM, Mongoose, SQLAlchemy (classic and `Mapped`), SQLModel, Django models, Room (Kotlin `@Entity`), SwiftData (`@Model`) |
| Dependencies | package.json, requirements*.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, build.gradle(.kts), pubspec.yaml, Podfile |
| Stack detection | Framework labels derived from dependencies (React, Next.js, Vue, Svelte, Express, NestJS, Prisma, Drizzle, FastAPI, Django, Flask, gin, axum, Spring, Rails, Laravel, Expo, Flutter…) |
| Env vars | Names used in code (`process.env`, `import.meta.env`, `os.environ`, `os.getenv`, `os.Getenv`, `env::var`, `ENV[]`) and keys in `.env.example`. Real `.env` files: key names only, values are never read into memory beyond parsing keys, never stored, never sent. |

Accuracy rule: structure is exact. Routes and schema are pattern-based, and every item links to its source file and line so the user can verify it. Anything approximate is labeled.

## 6. Change descriptions

On every file change the differ produces a `ChangeSummary`. The UI renders it as plain statements, for example:

- Added `function createOrder(input: OrderInput): Promise<Order>`
- Changed `listOrders` (signature: `(userId)` → `(userId, status?)`)
- Removed `class LegacyCache`
- New route `POST /orders` → `createOrder`
- Schema `orders`: new column `status`, new foreign key → `users`
- New dependency `zod ^3.23`
- Now imports `lib/validation.ts`

The unified diff is always available underneath, truncated at 800 lines per change with a "show full file" link. With a summarizer key set, a one-line plain-English summary sits on top.

## 7. Agents

### Setup

`livemap init` detects agents (by config directories in the project and home folder) and writes hooks to the project-level config, merging with existing settings and printing every change:

| Agent | Config file | Events used |
|---|---|---|
| Claude Code | `.claude/settings.local.json` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart` |
| Codex CLI | `.codex/hooks.json` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Codex asks the user once to trust the hook through `/hooks`; `init` says so. |
| Cursor | `.cursor/hooks.json` | `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `stop` |

All hooks call one small script, `livemap-hook <agent> <event>`, which forwards stdin to the local server with a 3-second timeout and exits 0 if the server is unreachable.

### What each agent contributes

| Agent | Live feed | The "why" | Steering |
|---|---|---|---|
| Claude Code | Tails the session transcript (path from the hook payload): prompts, messages, thinking, every tool call and result | Claude's text before each edit | Pause and flags (PreToolUse, exit 2) |
| Codex | Hook events: prompts, tool calls (shell, apply_patch, MCP) with results | Latest assistant message from the session file, parsed tolerantly | Pause and flags (PreToolUse, exit 2) |
| Cursor | Hook events: prompts, agent responses and thoughts, tool calls, shell commands, file edits | `afterAgentResponse` text | Pause and flags on tool and shell calls. File edits cannot be blocked. |
| Cloud builders | `livemap --pull[=seconds]` runs `git pull --ff-only` on an interval (default 15 s) | Commit message and author | None |
| Anything else | File changes only, full structural detail | None | None |

Local commits by any agent are also picked up (HEAD polled every 3 s) and shown as commit events.

### Attribution

A `ChangeSummary` for path P is matched to the most recent tool event within 10 seconds whose target paths include P (confidence `exact`). Otherwise, to the agent session active in the last 15 seconds (confidence `likely`, e.g. files generated by a shell command). Otherwise it is shown as "outside an agent". Late-arriving tool events back-fill attribution on recent changes. The `intent` is the session's last assistant message before the change.

### Steering

- **Flag:** a note on a file, symbol or the whole project. Queued in `control`. At the next blockable action of any connected agent, the hook blocks it and returns the note(s) as the reason, so the agent reads them and adjusts. The flag is then marked delivered (visible in the UI).
- **Pause:** every blockable action is blocked with "The user paused this session in LiveMap. Stop and wait for their instructions." until resumed.

## 8. History and snapshots

- Event log: JSONL, append-only, in `~/.livemap/projects/<sha1(root)>/events.jsonl`, with a model snapshot every 500 events for fast seeking. Default cap 200 MB per project, oldest sessions dropped first.
- On startup, the server loads the latest snapshot and replays the tail, so the timeline survives restarts.
- The timeline scrubber requests `stateAt(seq)` and the UI renders that state read-only, with a "Back to live" control.
- `livemap export [--session id]` writes one self-contained HTML file with the UI in replay mode and the recorded events embedded. It includes source code for files touched in the session. The CLI warns before export and supports `--no-code`.

## 9. AI summaries

- Off by default. Enabled with a key in `~/.livemap/config.json` or env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or a local Ollama URL.
- File summary: generated when a file is first viewed or created, regenerated when its symbol set changes. Change summary: one line per `ChangeSummary` with at least one symbol, route or entity change.
- Cached by content hash on disk. Monthly token cap (default 2M tokens), with usage shown in the Stack view.
- Without a key, the inspector's "In plain English" block shows the agent's own explanation for the file's latest change, or is hidden.

## 10. UI

The approved prototype in `docs/design/prototype.html` is the visual and interaction reference. Production UI matches it.

### Layout: Workspace

- **Toolbar** (full width): app mark, project switcher, one chip per connected agent with live status (animated ring while working), a "Now" line describing the current step, ⌘K search, theme toggle, Pause agent.
- **Sidebar** (left, translucent): filter box, layer legend, file tree grouped by folder. Each file shows a layer-colored icon, NEW / NOW badges and a symbol count, and expands to its symbols. The file being written auto-expands and scrolls into view.
- **Center**, with a segmented control and a sliding knob:
  - **Activity:** a "Now" hero card (current step, progress, animated counters for new files, functions, routes, tables) above the feed: prompts as chat bubbles, agent messages typed out live, tool calls with spinners, change cards with fact chips and an expandable diff.
  - **Map:** canvas of files grouped into tinted folder regions, colored by layer (Interface, API, Server, Logic, Validation, Data). Detail levels Folders / Files / Functions, with animated transitions. The file being written glows amber with a moving sheen; new files spring in from the file they connect to; new links draw themselves as green-to-blue gradient lines. "Follow agent" moves the camera to the agent's current file.
  - **Schema:** ER diagram of entities with PK/FK markers, relation lines, new rows highlighted.
  - **API:** request-flow lanes (Routes → Handlers → Services → Tables). Hovering a route animates its path through the code.
  - **Stack:** detected technologies, "what exists" bars, dependencies (new ones highlighted), env var names.
  - Tab badges show counts and bump when they change.
- **Inspector** (right, translucent): defaults to **Live session** (current step, the agent's latest message, session counters, recently changed files, your flags). Selecting any file switches it to the file view: plain-English summary, symbols with NEW/CHANGED tags, Uses / Used by chips, code with changed lines highlighted, "Why it changed" history quoting the agent, and a Flag box.
- **Timeline** (bottom of center): play/pause, colored ticks per event type, draggable thumb, LIVE / REWOUND state.
- **⌘K palette:** files, functions and components, routes, tables, with keyboard navigation. Selecting an item opens it in the inspector and flies the map to it.

### Visual language

- Light by default with a crafted dark mode (deep blue-black, vivid accents, not flat grey). Follows the OS setting, with a manual toggle.
- Translucent "glass" chrome (backdrop blur and saturation) over a soft, slowly drifting color ambience. Content surfaces are solid cards with layered soft shadows.
- System font stack (SF Pro on Apple devices) with Geist as fallback, Geist Mono / SF Mono for code.
- Layer colors are fixed and meaningful: purple Interface, blue API, indigo Server, teal Logic, pink Validation, orange Data. Green means new, orange means happening now, red means flagged or blocked.

### Motion principles

- Every change is explained by motion: things appear where they come from, links draw from source to target, and the current step glows.
- Easing: Apple-style `cubic-bezier(.32,.72,0,1)` for movement, a gentle spring for selection and toggles. Layout moves use critically damped interpolation so nothing jumps.
- Map positions are stable: existing nodes never reshuffle when new ones arrive. User-moved nodes stay pinned (saved per project).
- `prefers-reduced-motion` turns animation into instant state changes.

### Responsive

- Wide (≥1280 px): three columns. Medium: narrower panels. Below 1080 px: the sidebar and inspector become slide-over panels opened from the toolbar. Phone width: icon-only tabs, condensed toolbar, single-column feed.

### Implementation

React 18 + TypeScript + Vite; Tailwind CSS with Radix primitives (shadcn-style components); React Flow for the Map, Schema and API canvases, with ELK layout running in a Web Worker and custom node components matching the prototype; Framer Motion for enter/exit and layout transitions; Shiki for code and diff highlighting; cmdk for the palette; Zustand for state. Fonts are bundled. The built UI ships inside the npm package.

## 11. Distribution

- npm package `livemap` (name to be confirmed), Node 18+, macOS, Linux, Windows. `npx livemap` or a global install.
- Dependencies: `chokidar`, `web-tree-sitter`, `tree-sitter-wasms` (grammars), `ignore`, `diff`, `ws`. No native modules.
- License: open core. The local tool is MIT. Future paid features (hosted snapshot links, team history sync, LSP deep-analysis plugin) are separate packages that consume the same event log.
  - Note (2026-10-15): the license is now MIT + Commons Clause, not plain MIT (see [LICENSE](../../../LICENSE)).
- No telemetry in v1.

## 12. Privacy and security

- Server binds to `127.0.0.1` only. A random token is generated per run and included in the opened URL. HTTP and WebSocket requests without it are rejected (prevents other local web pages from reading project code).
- Nothing leaves the machine except optional summarizer calls to the provider the user configured.
- `.env` values are never stored, displayed or sent. Only key names.
- Hooks never modify agent behavior unless the user flags or pauses.
- Snapshot export warns that it contains code.

## 13. Performance targets

| Measure | Target |
|---|---|
| Initial index, 5,000-file repo | under 15 s, UI usable after the first 2 s (progress shown) |
| File save → UI updated | under 500 ms for files under 5,000 lines |
| Memory, 5,000-file repo | under 500 MB |
| Map rendering | 60 fps pan/zoom with 500 file nodes. At the Folders level beyond that, clusters are used. |
| Repo limit | 25,000 indexed files. Beyond that, LiveMap asks the user to choose subfolders. |

## 14. Error handling

- Parse failure: keep the last good structure, mark the file "parse error", show a badge.
- Binary, generated or files over 1 MB: listed in the tree, not parsed.
- Adapter cannot find its agent or transcript: shows "not connected" with a fix-it hint.
- Hook server unreachable: hook exits 0 instantly.
- Store write failure: live UI continues, banner says history is unavailable.
- Port in use: try the next port, print the URL.

## 15. Testing

- **Analyzers:** fixture files per language and framework with golden JSON outputs (symbols, imports, routes, entities). Every supported framework in section 5 has at least one fixture.
- **Differ:** pairs of before/after fixtures with expected `ChangeSummary`.
- **Adapters:** recorded real hook payloads and transcript excerpts from Claude Code, Codex and Cursor, replayed through the adapter with expected `AgentEvent`s. Hook script tested for timeout and server-down behavior.
- **Attribution:** scripted event sequences with timing.
- **End to end:** a scripted agent session against a fixture repo, with Playwright asserting the UI (tree, map nodes, feed cards, inspector) and screenshot checks in light and dark themes.
- **Dogfooding:** run LiveMap while a real agent builds a small app, compare the extracted model with the actual code.

## 16. Delivery phases (within v1)

1. **Engine:** watcher, analyzers (structure, imports), project model, differ, server, minimal UI (tree, inspector). Verified on fixture repos.
2. **Agents:** hook script, `init`, Claude Code, Codex, Cursor adapters, attribution, steering, git pull mode.
3. **Domain views:** routes, schema, deps, env analyzers; Schema, API, Stack views.
4. **Full UI:** production React app matching the prototype, Map with ELK, animations, ⌘K, responsive layouts, themes.
5. **History and sharing:** event store, timeline, export, AI summaries.
6. **Packaging:** npm publish, README, docs site, demo replay.

## 17. Open questions

1. Product name: "LiveMap" is a working title. The npm name needs checking.
2. Cursor transcript format: whether to parse `transcript_path` for richer history or rely on hook events alone.
3. Whether Codex `apply_patch` calls reach PreToolUse in all versions (documentation is unclear). The file watcher covers the effect either way. Steering on Codex may only work on shell commands in some versions.
