# Privacy

LiveMap runs on your machine. It has no account, no telemetry and no cloud service. LiveMap contacts other machines in two opt-in cases only: AI summaries send code to the provider you chose, and `--pull` contacts your git remote.

## What runs where

| Part | Where | Who can reach it |
|---|---|---|
| Server | `127.0.0.1` only, port 4317 by default | Requests that carry this run's token |
| Browser UI | Your browser, loaded from that server | You |
| Agent hooks | Your agent, on your machine | Send to `127.0.0.1` only |
| AI summaries (opt-in) | The provider you configured | That provider |
| Git pulls with `--pull` (opt-in) | Your git remote | Runs `git pull --ff-only` |

The server listens only on the loopback address, so other machines cannot connect to it. Other users of the same machine can reach the port, so every run makes a new random 128-bit token and they still need it:

- Every `/api` request and the WebSocket must carry the token (the `?t=` query or the `x-livemap-token` header). The agent hook endpoint `/hook` accepts the header only. There is no cookie, because cookies are shared by every server on `127.0.0.1`.
- The `Host` header must be `127.0.0.1` or `localhost`, which blocks DNS rebinding. The WebSocket and the requests that change state (flags, pause) refuse other origins.
- The URL LiveMap prints holds the token. The browser it opens gets a single-use link instead, valid for 2 minutes, so the token never appears in the browser opener's arguments. The page shell loads without a token but holds no project data.

## What is stored

Everything LiveMap stores lives in its home folder, `~/.livemap` (or `$LIVEMAP_HOME`).

| Path | What it holds |
|---|---|
| `projects/<id>/` | History per project: the messages the UI received (file structure, changes and diffs, prompts, agent messages, tool calls, flags, summaries). Folders are mode 0700 and files 0600. Capped at 200 MB per project (`LIVEMAP_HISTORY_MB`). |
| `config.json` | Your settings, if you create the file. It can hold a summaries API key. |
| `usage.json` | This month's summary token count, shared by every LiveMap process on the machine. |
| `cache/summaries/` | Summaries already written, so they are not requested twice. |
| `init/` | What `livemap init` created in each agent config file, so `--remove` can restore it. |
| `locks/` | One lock file per running project, with the pid, port and a random id of the LiveMap holding it, so a second LiveMap on the same project exits. The server answers `/__livemap/lock` with that id without a token; it says nothing about the project. Removed when LiveMap stops. |
| `run/` | The port and token of each running LiveMap, for the hooks. Removed when LiveMap stops. |
| `bin/livemap-hook.mjs` | The hook script. |

In your project, LiveMap writes only the agent config files `livemap init` creates or edits and the lines it adds to `.git/info/exclude`. With `--pull`, it also runs `git pull --ff-only`, which fast-forwards your working tree to the remote branch. In your browser, the tab keeps the run's token in sessionStorage (so a reload works; it is gone when the tab closes), and local storage keeps the theme, tab, Follow setting and map pins. The pins key includes the project's absolute path (`livemap:pins:<path>`). `livemap --no-history` records no history.

History holds the diff of each change (the changed lines plus up to 3 unchanged lines around each change), but not whole files: the code view always reads the file as it is now.

## `.env` and other secrets

LiveMap treats `.env` files (and variants such as `.env.local`) and credential files such as `.npmrc`, `.netrc` and `.pypirc` as secret. Example files such as `.env.example` are not secret.

- Secret files appear in the file tree, but their contents are never shown. From `.env` files LiveMap takes key names only. Values are never stored, shown, sent to the browser, recorded in history, summarized or exported.
- A shell command that names a secret file is stored as `<touches a secret file>` instead of the command.
- API keys from `config.json` or the environment are never logged, recorded in history or sent to the browser.

## What summaries send

Summaries are off until you turn them on (see [the guide](guide.md#ai-summaries)). When on, LiveMap sends to your configured provider only:

- for a file: its path, language, symbol names and signatures, and at most its first 300 lines;
- for a change: its path, the names of added, removed and changed symbols, routes, tables and dependencies, and the diff of the change: the changed lines plus up to 3 unchanged lines around each change;
- for a question in the Ask tab: the question, the project name, detected stack, routes, tables, the paths and top-level symbol names of up to 400 files, the imports and used-by links of the file asked about and of the most relevant files, the last 10 changes with their summaries or intents, and the text of the file asked about (up to 12,000 characters) plus up to 4 relevant files (up to 5,000 characters each), about 36,000 characters in all.

Secret files, binary files and files over 1 MB are never sent.

## What exports contain

`livemap export` writes one HTML file holding the recorded history: file structure, changes and diffs, prompts, agent messages, tool calls and summaries. With `--session`, it holds only that session's prompts, messages, tool calls and changes, also in the state the replay starts from, so other sessions' prompts are left out. Unless you pass `--no-code`, it also embeds the current text of every file the history touches, and LiveMap warns you that the file contains source code. With `--no-code`, it holds no file contents, diff lines or agent tool inputs and outputs (symbol names and signatures stay; shell commands are cut to the command name, and code blocks and inline code in prompts, agent messages and thinking, commit messages, session titles, change intents, tool labels, flag notes and AI summaries become `[code removed]`, but the plain text around them, code not marked as code, and tool labels such as file paths and search terms stay). Secret, binary and over-1 MB files are never embedded. Your project's absolute path is removed outside the embedded code. The file loads nothing from the network.

An export can still contain prompts and code you would not share. Read it before you send it.

## Deleting everything

1. Stop LiveMap.
2. In each project, run `livemap init --remove`. It removes the hooks and restores your original agent settings (content, not formatting). Remove the three LiveMap lines from `.git/info/exclude` if you want.
3. Delete the LiveMap home folder: `rm -rf ~/.livemap` (or your `$LIVEMAP_HOME`).

To delete one project's history only, delete its folder under `~/.livemap/projects/`. Run step 2 before step 3, because `--remove` uses the records in the home folder to restore your files.
