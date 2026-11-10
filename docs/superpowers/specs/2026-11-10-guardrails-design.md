# Guardrails

Rules that stop an agent before it touches what it must not, built on the hook that already delivers flags and pause.

## Who it is for

Solo developers and small teams running coding agents. Today LiveMap shows what the agent did; guardrails let it refuse a tool call the user ruled out in advance, without the user watching.

## Rules file

`.livemap/guardrails.json` in the project folder. LiveMap reads it, and writes it only when the user changes rules in Settings. A rule with `"enabled": false` is kept but not enforced.

```json
{
  "rules": [
    { "paths": ["db/migrations/**", ".env*"], "action": "block", "message": "Do not edit migrations; ask first." },
    { "commands": ["git push", "rm -rf"], "action": "pause" }
  ]
}
```

| Field | Meaning |
|---|---|
| `paths` | Gitignore-style patterns, relative to the project folder. No `!` negation. |
| `commands` | Text a shell command must contain (case-sensitive). |
| `action` | `block` refuses the call. `pause` refuses it and pauses every agent until Resume. Default `block`. |
| `on` | `write` (default): path patterns apply to tools that write. `any`: also to tools that read. |
| `message` | Sent to the agent with the refusal. |

A rule needs `paths` or `commands`. An invalid rule is skipped and reported in the UI and on stderr; the valid rules stay active. Limits: 100 rules, 50 patterns per rule, 500 characters per pattern or message, 256 KB per file.

The file is re-read when its size or modification time changes: on every hook, and every 2 seconds for the UI.

## Decision

On a blockable hook (`PreToolUse` for Claude Code and Codex, `preToolUse` and `beforeShellExecution` for Cursor):

1. Pause and waiting flags are checked first, as before. If they block, guardrails are not consulted.
2. Otherwise the call's project-relative paths and its shell command are matched against the rules in file order. The first matching rule wins.
3. A match answers the hook with a block and the reason. `pause` also turns Pause on.

A hook that can no longer receive an answer is never blocked. If the answer does not reach the hook, the hit is withdrawn (a pause it set stays on).

## What the user sees

- The blocked tool call in Activity, as blocked calls show today, with the guardrail's reason.
- A Guardrails section in the inspector's Live session panel: the active rules, file errors, and the latest hits (time, agent, path or command pattern).
- `ControlState.guard` carries this, so it is recorded in history and replayed. A hit for a command stores the rule's pattern, never the command text.

## Limits

- Shell commands carry no file paths: a rule can match the command text, not the files a script touches.
- Cursor file edits cannot be blocked by any hook.
- Agents without hooks are not covered.

## Units

- `src/agents/guardrails.ts`: parsing (`parseGuardrails`), matching (`matchRule`) and the reloading store (`Guardrails`). No dependency on the hub.
- `src/agents/normalize.ts`: `NormalizedHook.call` (tool name, paths, command, access) for blockable tool events.
- `src/agents/hub.ts`: consults the store after `control.check`.
- `src/agents/control.ts`: holds the guard state inside `ControlState`.
- `ui/src/components/Guardrails.tsx`: the inspector section.

## Tests

Unit tests for parsing, matching, reload and the hub decision per agent; a UI test for the section.
