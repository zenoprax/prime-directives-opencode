# Prime Directives

Prime Directives is an OpenCode plugin with two parts: a server plugin and a TUI plugin.

The server plugin injects two non-standard directive layers on every agent-loop request so they survive context compaction:

- PROJECT.md — per-project overlay that overrides AGENTS.md on conflict
- .opencode/prime-directives/<sessionID>.md — per-session directives, mutable and authoritative

The developer's AGENTS.md and the global SYSTEM.md are handled by OpenCode itself (project/ambient discovery and the config `instructions` field).
This plugin only adds the overlay and session layers.

It also registers the `todowrite` tool.
The tool is pinned to the chat catalog rather than Code Mode and writes the list to a dedicated per-session file (`.opencode/prime-directives/<sessionID>.tasks.md`).
Because both files are re-read from disk on every request, the task list outlives compaction.

## Directive cascade

| Layer   | Source                                           | Provided by            |
| ------- | ------------------------------------------------ | ---------------------- |
| SYSTEM  | global `SYSTEM.md` (config `instructions`)       | OpenCode               |
| PROJECT | `AGENTS.md` (developer) + `PROJECT.md` (overlay) | OpenCode + this plugin |
| SESSION | `.opencode/prime-directives/<sessionID>.md`      | this plugin            |

The list is ordered least to most specific.
The server plugin injects the PROJECT overlay before the SESSION directives.
The most specific layer wins.

## Files

| File       | Role                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `index.ts` | Server plugin: injection, todowrite tool, task-list sync, compaction |
| `tui.tsx`  | TUI plugin: sidebar panel showing the directive cascade              |

## Server plugin

`index.ts` hooks into three points:

- `ctx.tool.transform` registers the `todowrite` tool (codemode: false) so it stays in the chat catalog.
- `ctx.session.hook("context")` runs on every request. It re-reads the nearest `PROJECT.md`, the session directives file, and the session task file from disk and appends all three to the system prompt so none of them depends on conversation history.
- `ctx.session.hook("compaction")` runs when history is compacted. It pushes the session directives and task list into the compaction context as separate verbatim sections.

Every read and write is best-effort.
A failure never breaks a model request or a compaction.

### todowrite tool

The tool accepts the full task list on every call.
It writes the list to the per-session task file (`.opencode/prime-directives/<sessionID>.tasks.md`), replacing the entire file.

Status rendering:
- Completed items render as `[x]`
- Cancelled items render as `[-]`
- In-progress items gain an `(in progress)` note
- If the file does not exist yet, it is created with a short heading and session ID

### Task list sync

The task list is written to its own file (`.opencode/prime-directives/<sessionID>.tasks.md`).
Every call replaces the entire file.
Completed items render as `[x]`.
Cancelled items render as `[-]`.
In-progress items gain an `(in progress)` note.
An empty task list removes the file.
The session directives file is never modified by task-list sync; it is only read for user directives.

### Status sidecar

The plugin writes `.opencode/prime-directives/<sessionID>.status.json` with the directive count, overlay path, task file path, last injection time, and last compaction time.
The TUI panel reads the timestamps from this file.
The sidecar is optional and purely informational.

## TUI plugin

`tui.tsx` prepends a `sidebar.content` slot so the panel sits at the top of the sidebar. It lists:

- SYSTEM: the global `SYSTEM.md`, located through the config directory or `/etc/opencode`.
- PROJECT: the nearest `AGENTS.md` and `PROJECT.md`, shown side by side.
- SESSION: the current session directives file, with a shortened session ID.

Each layer shows a green dot and directive count when present.
The footer shows when the directives were last injected and when the history was last compacted.
If the old `.opencode/sessions/` directory still exists, the panel adds a short warning line so it can be removed by hand.
The panel refreshes once a second.
It shows a toast when it loads.

## Notes

- Without a session ID the server plugin falls back to `.opencode/prime-directives/SESSION.md`. Task-list sync and the status sidecar are skipped.
- `AGENTS.md` and the global `SYSTEM.md` are still loaded by OpenCode itself. This plugin only adds the overlay and session layers.
- Both files target the `@opencode/plugin` API. They are intended to load as the server and TUI parts of one plugin.
- Package exports: `"./server"` for the server plugin and `"./tui"` for the TUI plugin.

## Example command

Add this to your `opencode.jsonc` to get a `/directives` command for managing prime directives:

```jsonc
"commands": {
  "directives": {
    "description": "Add, change, or remove a persistent PRIME DIRECTIVE",
    "template": "The user wants to change the prime directive set.\n\n1. Find your prime directives file path in the PRIME DIRECTIVES block of your system\n   prompt (`.opencode/prime-directives/<sessionID>.md`). Read it if it exists.\n2. Apply the request below: add, modify, or delete the relevant directive. Delete\n   directives that are dropped rather than commenting them out.\n3. Keep the file short and normative, and do not duplicate SYSTEM or PROJECT\n   directives into it.\n4. After editing, restate the full current prime directive set for confirmation.\n\nRequest: $ARGUMENTS"
  }
}
```
