# Changelog

LiveMap is not published yet. This file lists changes that affect data or settings on your machine.

## Unreleased

- **Ask tab.** Ask questions about the project, or about the open file and its connections, answered by your AI summaries provider.
- **AI summaries no longer vanish on failure.** The inspector shows why a summary could not be written and offers Try again. OpenAI requests use `max_completion_tokens`, and an empty reply is reported as an error.
- **History location can change on Windows and macOS.** LiveMap now resolves a project's real path with the operating system's own call (`fs.realpathSync.native`). On Windows this gives long names instead of 8.3 short names (`C:\Users\RUNNER~1`) and the folder's real casing; on macOS it gives the real casing. History and the project lock are keyed by a hash of that path, so a project whose path resolves differently now starts a new history in `~/.livemap/projects/`. The old folder is left in place; delete it when you no longer need it.
- **Exports on Windows include source code again.** The same path change fixes exports that held no files.
- **`BROWSER`** names the program that opens LiveMap's URL, with arguments and `%s` for the URL; `BROWSER=none` opens nothing.
- **`livemap sn`** mirrors a ServiceNow scope through SkyForge's nexus MCP (read-only) into `.livemap/sn/` and shows it in the Map, Schema and API views. Business rules, client scripts, UI policies and ACLs show as rules on their tables.
- **`livemap sn` imports the scope's history** to `.livemap/sn/<scope>.history.json`: dated events from `sys_update_version` (or `sys_update_xml`), matched to SkyForge's MCP log where a tool call on the same instance names the record.
- **`livemap sn` works with real nexus.** It no longer stops with `raw.normalize is not a function` while pulling: reference fields that nexus returns as `{link, value}` objects are read as their value.
- **`livemap mcp-proxy`** lets LiveMap see the tool calls of a desktop MCP client. The client's nexus entry launches the proxy, which forwards everything unchanged and reports each call, with secrets redacted, to `livemap sn`. Instance changes are matched to calls by record, update set, run window and time, with confidence `exact`, `likely` or `ambiguous`.
- **SkyForge plugin.** `livemap sn install-plugin` copies LiveMap's plugin into `~/.skyforge/plugin/` after a yes at a prompt (`--uninstall` removes it). It reports SkyForge's nexus tool calls, prompts and assistant text to `livemap sn`. `livemap sn backfill-sessions --since DATE` sends past SkyForge sessions the same way.
- **ServiceNow inspector, filters and diagnostics.** In a `livemap sn` project the inspector shows each record's update set, last update, what it uses, the latest change's confidence and why, and an Open in ServiceNow link. A filter bar (scope, update set, session, agent or human, confidence) narrows the Map, Schema, Activity and diffs, and is kept in the page address. The toolbar counts unattributed changes, and Unknown tools lists tools LiveMap could not classify. See `docs/servicenow.md`.
- **CI** runs the unit tests on Windows (Node 22) as well as Ubuntu and macOS.
