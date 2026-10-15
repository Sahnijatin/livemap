# Changelog

LiveMap is not published yet. This file lists changes that affect data or settings on your machine.

## Unreleased

- **History location can change on Windows and macOS.** LiveMap now resolves a project's real path with the operating system's own call (`fs.realpathSync.native`). On Windows this gives long names instead of 8.3 short names (`C:\Users\RUNNER~1`) and the folder's real casing; on macOS it gives the real casing. History and the project lock are keyed by a hash of that path, so a project whose path resolves differently now starts a new history in `~/.livemap/projects/`. The old folder is left in place; delete it when you no longer need it.
- **Exports on Windows include source code again.** The same path change fixes exports that held no files.
- **`BROWSER`** names the program that opens LiveMap's URL; `BROWSER=none` opens nothing.
- **CI** runs the unit tests on Windows (Node 22) as well as Ubuntu and macOS.
