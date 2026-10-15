# Contributing to LiveMap

Thanks for helping. This page covers setup, the commands you need, where things live and the house rules for copy.

## Prerequisites

- Node.js 18 or later, and npm.
- Git.
- For the end-to-end tests: Chromium for Playwright (`npx playwright install chromium`). A Chromium at `/opt/pw-browsers/chromium`, or at the path in `LIVEMAP_CHROMIUM`, is used instead when present.

## Commands

Run these from the repo root. `npm run build` installs the UI's dependencies first when they are missing or out of date.

| Command | What it does |
|---|---|
| `npm install` | Installs the engine's dependencies. |
| `npm run build` | Builds the CLI and hook script into `dist/`, the UI into `dist/ui/` and the export page into `dist/ui-export/`. |
| `node dist/cli.js [dir]` | Runs the built CLI without `npm link`. |
| `npm test` | Engine, server and CLI unit tests (Vitest). |
| `npm --prefix ui test` | UI unit tests (Vitest with jsdom). |
| `npm run build && npm run test:e2e` | End-to-end tests in Chromium (Playwright). They run against `dist/`, so build first. |
| `npm run test:perf` | Performance test: indexing 5,000 files in under 15 s and under 500 MB of memory. |
| `npm run typecheck` | Type-checks the engine. |
| `npm --prefix ui run typecheck` | Type-checks the UI. |
| `npm run demo` | Builds a sample project, drives a scripted agent session and exports the demo replay. `-- --shots` also captures the README screenshots. Needs `npm run build` first. |
| `npm run docs:check` | Checks links, anchors, em dashes and CLI flags in the docs. Add `-- --allow-missing-media` while screenshots are not generated yet. `node scripts/check-docs.mjs --self-test` checks the checker. |

Notes on the end-to-end suite:

- `npm run build` always produces a production UI build, even when `NODE_ENV` is set.
- `tests/e2e/history.spec.ts` saves its timeline, summary and export screenshots to `test-results/history`, or to the folder named by `LIVEMAP_SHOTS`.
- The Map frame budget (median frame 16.7 ms or less, p95 25 ms or less while panning 500 files) is asserted only with `LIVEMAP_PERF_STRICT=1 npx playwright test tests/e2e/map.spec.ts` on a machine with a GPU. Otherwise the test logs the numbers and checks for long tasks.

`node scripts/gen-big.mjs <dir> [count]` generates a large TypeScript project (5,000 files by default) for trying the Map at scale.

## Repo layout

| Folder | What it holds |
|---|---|
| `src/` | The engine, agents, history, summarizer, export and server (TypeScript, built with tsup). |
| `ui/` | The browser UI (React, Vite, Tailwind), with its own `package.json`. |
| `tests/` | Unit tests by area, Playwright specs in `tests/e2e/`, and sample projects in `tests/fixtures/`. |
| `scripts/` | Build helpers, the demo script and the docs check. |
| `docs/` | User docs, images, the design prototype, and plans and specs in `docs/superpowers/`. |
| `dist/` | Build output (not committed). |

## Copy rules

These apply to docs, UI strings, CLI messages and comments:

- No em dashes. Use a colon, a comma, parentheses or two sentences.
- US spelling: "license", "color", "behavior".
- Plain, direct sentences. No marketing words.
- Every flag, default, path and UI string in the docs must match the code. When they disagree, the code wins and the docs get fixed.

## Plans and specs

The design spec and the phase-by-phase implementation plans live in `docs/superpowers/` (`specs/` and `plans/`). Read the spec before a large change, and check the latest plan for what is in progress.

## License of contributions

LiveMap is licensed under MIT with the Commons Clause (see [LICENSE](LICENSE)). By sending a contribution, you agree that it is licensed under the same terms.
