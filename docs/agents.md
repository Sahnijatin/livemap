# Agents

LiveMap watches your project's files whatever writes them. Agents add the "who" and "why": prompts, messages, tool calls, and the ability to flag or pause the agent from the UI.

| Agent | How LiveMap connects | What you see | Flag and Pause |
|---|---|---|---|
| Claude Code | Hooks, plus the session transcript | Prompts, messages, thinking, tool calls and results | Yes |
| Codex CLI | Hooks, plus the latest assistant message from the session file | Prompts, tool calls with results, messages | Yes |
| Cursor | Hooks | Prompts, responses, thoughts, tool calls, shell commands, file edits | Yes, on tool and shell calls |
| Cloud builders | Git, via `--pull` | Commits: message, author and changed files | No |
| Anything else | File changes only | Full structure of every change | No |

## What `livemap init` writes

Run `livemap init` in the project folder. It detects agents by their config folder (`.claude`, `.codex` or `.cursor`) in the project or in your home folder. Use `--agents claude,codex,cursor` (any subset) to choose them yourself.

| Agent | File in your project | Events hooked |
|---|---|---|
| Claude Code | `.claude/settings.local.json` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop` (tool results come from the transcript) |
| Codex CLI | `.codex/hooks.json` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` |
| Cursor | `.cursor/hooks.json` | `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `preToolUse`, `postToolUse`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`, `stop` |

- **The hook script.** Init copies `livemap-hook.mjs` to the `bin/` folder of the LiveMap home (`~/.livemap/bin/`, or `$LIVEMAP_HOME/bin/`). Each hook entry runs `node '<home>/bin/livemap-hook.mjs' <agent> <event>` (double quotes on Windows, where init refuses a LiveMap home whose path contains `"`, `%`, `!`, `^`, `&`, `|`, `<` or `>`), where `<agent>` is `claude-code`, `codex` or `cursor`. Claude Code and Codex entries have a 5 second timeout.
- **Your settings are kept.** Init adds its entries next to yours and leaves your own hooks in place. Running it again updates LiveMap's entries in place, removes entries for events it no longer hooks (such as an older init's Claude Code `PostToolUse`), and prints `unchanged` when nothing differs. A file that is not valid JSON, or whose `hooks` has an unexpected shape, is skipped with the reason and left alone.
- **Git excludes.** When the project has a `.git` folder, init adds `.claude/settings.local.json`, `.codex/hooks.json` and `.cursor/hooks.json` to `.git/info/exclude`, so the hook files (which hold a path on your machine) are not committed by accident.
- **Codex.** Codex asks you to trust new hooks. Init reminds you: run `/hooks` inside Codex once.
- **Records.** Init notes what it created in each file (the file itself, its `hooks` object, event lists, Cursor's `version`) under `<home>/init/`.

Each line init prints is the action and the file, for example `created .claude/settings.local.json`.

### Removing the hooks

`livemap init --remove` removes LiveMap's hooks from all three files, or only from the agents named in `--agents`. It uses the records above to restore your original settings (content, not formatting): whatever init added is taken out, your own entries stay as they were, and a file init created is deleted. The file is written back as JSON with 2-space indentation, so your own spacing may change. It does not touch `.git/info/exclude` or the hook script in the LiveMap home.

## How hooks reach LiveMap

A running LiveMap writes its port and access token to `<home>/run/` (readable only by you) and removes the file when it stops. The hook script finds the LiveMap running for the project folder (or the nearest parent folder), sends the event to `http://127.0.0.1:<port>/hook` with the token, and exits.

When LiveMap is not running, the hook exits at once and does nothing. The hook gives up after about 1.6 seconds, so a slow or stuck LiveMap never holds up the agent for long. Hooks never change what the agent does, except to deliver a flag or a pause.

Claude Code sessions show up even without hooks: LiveMap reads the transcripts of Claude Code sessions in this project that were active in the last 10 minutes (under `~/.claude/projects/`, or `$CLAUDE_CONFIG_DIR`). Flag and Pause need the hooks.

## Cloud builders: git and `--pull`

LiveMap checks the project's git `HEAD` every 3 seconds. Each new commit, from any agent or person, appears in the Activity feed with its message, its author and the files it changed. A merge shows as one quiet line, and the files it brings in are credited to the commits that changed them. The inspector's Live session panel lists the five latest commits (merges left out), so work that arrives through git shows there even with no agent connected.

Builders that work in the cloud and push to a remote (for example Emergent or Lovable) never touch your local files. Start LiveMap with `--pull` to bring their work in:

```sh
livemap --pull        # git pull --ff-only every 15 seconds
livemap --pull=60     # every 60 seconds (5 to 3600)
```

The pull is fast-forward only, so it never creates a merge in your copy. The branch needs an upstream, and a pull fails while your local branch has diverged; LiveMap prints each distinct git error once (`livemap: git: ...`). Files changed by a pulled commit are attributed to that commit, with its subject as the reason.

## Flag and Pause

Both work by blocking the agent's next action that can be blocked and telling it why.

| Agent | Actions LiveMap can block |
|---|---|
| Claude Code | `PreToolUse` (any tool call) |
| Codex CLI | `PreToolUse` |
| Cursor | `preToolUse` and `beforeShellExecution`. File edits cannot be blocked. |

- **Pause.** "Pause agent" in the toolbar. While it is on, every blockable action of every connected agent is blocked, and the agent is told: "The user paused this session in LiveMap. Stop and wait for their instructions." The blocked tool call does not run. Click "Resume agent" to let agents carry on.
- **Flag.** Write a note in a file's Flag box in the inspector, or in "Flag the project" (shown in the inspector when no file is open), and press Flag. The note waits ("Waiting for the agent's next action") until a connected agent next tries a blockable action. That action is blocked and the agent receives every waiting flag at once:

  ```text
  The user flagged this in LiveMap:
  - src/routes/orders.ts: Use the existing db client, not a new one.
  ```

  The flag then shows "Delivered <when> to <agent>", for example "Delivered just now to Claude Code". You can remove a flag before it is delivered. While Pause is on, flags wait.
- **Timing.** The agent sees a flag or pause only when it next tries a blockable action, not mid-step. If its hook already gave up waiting, nothing is blocked and the flag stays queued for the next action.
- **Lifetime.** Flags and the pause state live in the running LiveMap. Restarting LiveMap clears them.

## Guardrails

Guardrails stop an agent before it touches files or runs commands you ruled out, without you watching. Write the rules in `.livemap/guardrails.json` in the project folder:

```json
{
  "rules": [
    { "paths": ["db/migrations/**", ".env*"], "action": "block", "message": "Do not edit migrations; ask first." },
    { "commands": ["git push", "rm -rf"], "action": "pause" }
  ]
}
```

| Field | What it does |
|---|---|
| `paths` | Patterns for files, relative to the project folder, written as in `.gitignore` (`db/migrations/`, `*.lock`, `src/**/secrets.ts`). `!` patterns are not supported. |
| `commands` | Text to look for in a shell command. The match is case-sensitive: `git push` matches `cd app && git push origin main`. |
| `action` | `block` (the default) refuses the tool call. `pause` refuses it and turns on Pause for every agent, until you click "Resume agent". |
| `on` | `write` (the default): `paths` apply to tools that write, edit or patch files. `any`: also to tools that read them. |
| `message` | Sent to the agent with the refusal, so it knows what to do instead. |

A rule needs `paths` or `commands`. Rules are checked in file order and the first match wins. The agent is told, for example:

```text
Blocked by a LiveMap guardrail: db/migrations/001.sql matches the rule "db/migrations/**". Do not edit migrations; ask first.
```

- **Where you see it.** The inspector's Live session view has a Guardrails section with the active rules and the latest blocked calls. The blocked tool call also shows in the Activity feed.
- **Editing the rules.** LiveMap re-reads the file when it changes: before every tool call, and every 2 seconds for the UI. A rule it cannot read is skipped and named in the Guardrails section; the other rules stay active. Limits: 100 rules, 50 patterns per rule, 500 characters per pattern or message.
- **Sharing.** The file is yours and LiveMap never writes it. Commit it to share the rules with your team.
- **Order.** Pause and waiting flags are delivered first. A tool call they already stop is not checked against the rules.
- **Limits.** Guardrails work through the same hooks as Flag and Pause (see the table above), so they need `livemap init` and a running LiveMap. A shell command carries no file list: a rule can match the command's text, but not the files a script changes. Cursor file edits cannot be blocked. A hit records the path, or the rule's command pattern, never the command itself.

## Attribution: "exact" and "likely"

Each change card says which agent made the change, with a confidence label.

| Label | Meaning |
|---|---|
| exact | Matched to the tool call that wrote this file: a write, edit, patch, notebook or shell call that names the file, from 10 seconds before to 5 seconds after the change. MCP tools count when their name says they write (for example `write_file`) and their paths are local files, which holds for local filesystem servers but not for GitHub. Gateway calls such as `tool_execute` are judged by the tool they run. A git commit that lists the file also counts. |
| likely | No tool call named the file, but an agent was active in the 15 seconds before the change, for example when a shell command generated files. |
| (none) | No agent was active. The Activity feed groups the change under "Outside an agent". |

A tool call that arrives a little after the change upgrades its label to exact. Tool calls that LiveMap blocked never count. The reason shown with an attributed change is the agent's last message before it (or the prompt, as "Asked: ..."), or the commit subject for a commit.
