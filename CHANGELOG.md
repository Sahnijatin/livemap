# Changelog

LiveMap is not published yet. This file lists changes that affect data or settings on your machine.

## Unreleased

- **History location can change on Windows and macOS.** LiveMap now resolves a project's real path with the operating system's own call (`fs.realpathSync.native`). On Windows this gives long names instead of 8.3 short names (`C:\Users\RUNNER~1`) and the folder's real casing; on macOS it gives the real casing. History and the project lock are keyed by a hash of that path, so a project whose path resolves differently now starts a new history in `~/.livemap/projects/`. The old folder is left in place; delete it when you no longer need it.
- **Exports on Windows include source code again.** The same path change fixes exports that held no files.
- **`BROWSER`** names the program that opens LiveMap's URL, with arguments and `%s` for the URL; `BROWSER=none` opens nothing.
- **`livemap sn`** mirrors a ServiceNow scope through SkyForge's nexus MCP (read-only) into `.livemap/sn/` and shows it in the Map, Schema and API views. Business rules, client scripts, UI policies and ACLs show as rules on their tables.
- **`livemap sn` works with real nexus.** It no longer stops with `raw.normalize is not a function` while pulling: reference fields that nexus returns as `{link, value}` objects are read as their value.
- **CI** runs the unit tests on Windows (Node 22) as well as Ubuntu and macOS.
