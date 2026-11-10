# LiveMap

See what your AI coding agent is building, live.

LiveMap watches your project while a coding agent works on it, and shows every file, function, route and table it touches as it happens. It runs locally as a CLI and a browser UI, so you can follow the build, rewind it, and flag or pause the agent when something looks wrong.

![The LiveMap Map following an agent as it writes a file, with a plain-English summary in the inspector](https://livemap.in/images/hero.png)

**Try it without installing:** [livemap.in/demo](https://livemap.in/demo) replays a real agent session in your browser.

## Quick start

Requires Node 20 or later. In the project your agent works on:

```sh
npx livemap init      # adds hooks for the agents it finds
npx livemap           # indexes the project and opens the UI in your browser
```

Or install it once:

```sh
npm install -g livemap
livemap init
livemap
```

`livemap init` sets up the agents whose config folder it finds; name them with `--agents claude,codex,cursor` if it finds none. Run `livemap --help` for every command and flag.

## What you get

**Activity feed.** The agent's prompts, messages and tool calls, with a card for every change: functions, routes and tables added, changed or removed, and the diff.

![The Activity feed](https://livemap.in/images/activity.png)

**Map.** Every code file as a card in its folder, linked by imports. The file being written glows, new files spring in, and the camera follows the agent.

![The Map at the Files level](https://livemap.in/images/map.png)

**Schema, API and Stack.** The tables, routes and technologies LiveMap found, each linked to its source line.

**Inspector.** Select any file to see what is inside it, what it connects to, and why it changed. With AI summaries turned on (opt-in), changes also get a one-sentence summary in plain English.

**Timeline.** Drag back through the session to see the whole project as it was at any moment, or replay it.

![The timeline, rewound](https://livemap.in/images/timeline.png)

**Steering.** Flag a file or the project with a note, or pause the agent. The agent gets the note at its next tool call.

**Guardrails.** Rules in `.livemap/guardrails.json` stop the agent before it edits files or runs commands you ruled out, such as migrations, `.env` files or `git push`.

**Settings.** The gear button opens Settings: turn AI summaries on or off, choose a provider and paste your API key, and add, disable or remove guardrails. Changes apply at once.

**Export.** `livemap export` writes the history as one HTML file that anyone can open offline. Add `--no-code` to leave out file contents, diffs and tool inputs and outputs, or `--session ID` to export one agent session.

## Works with

| Agent | How LiveMap connects |
|---|---|
| Claude Code | Hooks |
| Codex CLI | Hooks |
| Cursor | Hooks |
| Cloud builders | Git, via `--pull` |

Any other tool still shows up through its file changes.

## Privacy

LiveMap runs entirely on your machine: the server listens on `127.0.0.1` only, and its API needs a token that changes every run. History, settings and caches stay in `~/.livemap`. LiveMap keeps only the key names from `.env` files, never their values. Nothing leaves your machine unless you turn on AI summaries, which send code only to the provider you choose, or run with `--pull`, which contacts your git remote.

## License

LiveMap is free to use, including at work and for commercial projects. It is not open source: you may not resell, redistribute, modify or reverse engineer it. See the [LICENSE](LICENSE) file for the exact terms. This summary is not legal advice.

LiveMap includes open source components under their own licenses, listed with their license texts in `THIRD_PARTY_NOTICES.md` inside the package. The Map and Schema views are drawn with React Flow (MIT) and laid out with ELK through elkjs (EPL-2.0, source at https://github.com/kieler/elkjs).

## Links

- Website: [livemap.in](https://livemap.in)
- Demo: [livemap.in/demo](https://livemap.in/demo)
