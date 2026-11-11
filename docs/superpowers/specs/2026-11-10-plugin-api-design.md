# Plugin API and the ServiceNow split

Status: proposed, not built. Tracks issues #53 (plugin system) and #60 (ServiceNow source).

## Goal

The ServiceNow source moves to its own repository, `livemap-servicenow`, so SkyForge can depend on it. LiveMap's core stays in this repository only. SkyForge users install `livemap` as a prerequisite; nothing of the core is copied.

The ServiceNow code stays in this repository too until the external package passes the same tests. Then the bundled copy is removed in a later release.

## What the ServiceNow code uses from core today

Measured from the imports in `plugins/servicenow/` (4,890 lines):

| Kind | What |
|---|---|
| Run the server | `CoreHooks` (`serve`, `resolveRoot`), `Args`, `ServeOptions`, `ServeHandles`, `DEFAULT_PORT` |
| Analyzers | `Analyzer`, `DomainFacts`, `buildDomainIndex`, `newDataRefCache`, `hashText` |
| Data types | `FileModel`, `CodeSymbol`, `Entity`, `Field`, `Route`, `Rule`, `ChangeSummary`, `Attribution`, `RecordKey`, `DomainIndex`, `ProjectState`, `ServerMessage`, `SourceStatus` |
| History | `HistoryStore` (back-dated runs), `emptyState` |
| Capture | `HookPoster`, `liveRuntimes`, `isServiceNowRun`, `buildCapture`, `buildText`, `SessionContext`, `needsResult`, `argNames`, `baseToolName`, `toolServer`, `livemapHome` |

Core refers to the ServiceNow code in three places: the three command imports in `src/cli.ts`, the SkyForge plugin build in `tsup.config.ts`, and the doc check's list of CLI sources.

## Design

### 1. A library entry: `livemap/plugin`

`package.json` gains an `exports` map with `./plugin`, built by tsup with type declarations. It re-exports exactly the names in the table above, and nothing else. This is the supported surface: anything not exported there can change without notice.

It also exports `PLUGIN_API = 1` and:

```ts
export interface LiveMapPlugin {
  name: string;
  /** The PLUGIN_API the plugin was built for. LiveMap refuses a plugin built for a newer one. */
  api: number;
  /** `livemap <command> ...`: the command's arguments and the core hooks. */
  commands: Record<string, (argv: string[], core: CoreHooks) => Promise<void>>;
}
```

A plugin package's default export is a `LiveMapPlugin`.

### 2. Loading

Plugins run with the user's full permissions, so LiveMap loads only what the user named:

- `~/.livemap/config.json` gains `"plugins": ["livemap-servicenow"]`. Each entry is a package name or an absolute path.
- `livemap plugin add NAME`, `livemap plugin remove NAME` and `livemap plugin list` edit and show that list. `add` checks that the package loads and prints its name and commands.
- A package name is resolved next to the running `livemap` (the same `node_modules`), which covers a global install of both and a project that depends on both.

`livemap <command>` looks up the command in the loaded plugins after the built-in ones. A plugin command with the name of a bundled one (`sn`) wins, so the external ServiceNow package replaces the bundled copy as soon as it is added. A plugin that fails to load is one warning; LiveMap still starts.

### 3. What moves, what stays

| Moves to `livemap-servicenow` | Stays in LiveMap |
|---|---|
| `plugins/servicenow/**`, including the SkyForge plugin and its build | `livemap mcp-proxy` and the capture code (generic MCP, used by other sources later) |
| `tests/servicenow/**`, `tests/helpers/mock-nexus.ts`, the ServiceNow e2e specs and fixture | The record attribution rules in `src/agents/` |
| `docs/servicenow.md`, `docs/design/servicenow.md`, the `livemap sn` part of the guide | The ServiceNow UI panels (`ui/src/sn/`), which load only for a ServiceNow project |

The UI panels stay because LiveMap's UI is one compiled bundle. Moving them needs a UI plugin system, which is not worth building for one plugin.

### 4. How SkyForge embeds it

SkyForge declares `livemap` and `livemap-servicenow` as dependencies (or asks the user to install them), runs `livemap plugin add livemap-servicenow` once, and starts `livemap sn --scope ...`. The SkyForge plugin that reports tool calls ships in `livemap-servicenow`.

## Decisions for the owner

1. **Licence.** Settled: LiveMap is MIT licensed, so SkyForge may depend on it, bundle it or copy it.
2. **Licence and visibility of `livemap-servicenow`.** It can be private, or carry the same licence as LiveMap.
3. **Who owns it.** The repository can live under your account with your CTO as collaborator, or under SkyForge's.

## Order of work

1. `livemap/plugin` entry and loader, with the bundled ServiceNow commands ported to a `LiveMapPlugin` in place. No behaviour change; existing tests cover it.
2. `livemap plugin add|remove|list`.
3. Copy the ServiceNow code and tests to `livemap-servicenow`, importing from `livemap/plugin`. Its CI runs the ServiceNow unit and e2e tests against a published or packed `livemap`.
4. After a release where both exist: remove the bundled copy here.

## Tests

- Loader: a fixture plugin is found by name and by path, a failing one warns, a newer `api` is refused, a plugin command overrides a bundled one.
- A check that `livemap/plugin` exports every name the ServiceNow code imports.
