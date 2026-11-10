# Prime Directives

Prime Directives is an OpenCode V2 plugin with two parts: a server plugin and a TUI plugin.

The server plugin injects two non-standard rule layers on every agent-loop request so they survive context compaction:

- PROJECT.md — per-project overlay that overrides AGENTS.md on conflict
- .opencode/prime-directives/<sessionID>.md — per-session rules, mutable and authoritative

The developer's AGENTS.md and the global SYSTEM.md are handled by OpenCode itself (project/ambient discovery and the config `instructions` field). This plugin only adds the overlay and session layers.

It also restores the `todowrite` tool. OpenCode V2 removed the built-in todowrite tool and the session.todo API; this plugin registers a V1-compatible `todowrite` tool (pinned to the chat catalog, not Code Mode) and writes the list to a dedicated per-session file (`.opencode/prime-directives/<sessionID>.tasks.md`). Because both files are re-read from disk on every request, the task list outlives compaction.

## Rule cascade

| Layer   | Source                                         | Provided by                  |
| ------- | ---------------------------------------------- | ---------------------------- |
| SYSTEM  | global `SYSTEM.md` (config `instructions`)     | OpenCode                     |
| PROJECT | `AGENTS.md` (developer) + `PROJECT.md` (overlay) | OpenCode + this plugin       |
| SESSION | `.opencode/prime-directives/<sessionID>.md`    | this plugin                  |

The list is ordered least to most specific. The server plugin injects the PROJECT overlay first and the SESSION rules last. The most specific layer wins.

## Files

| File          | Role                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `index.ts`    | Server plugin: injection, todowrite tool, task-list sync, compaction      |
| `tui.tsx`     | TUI plugin: sidebar panel showing the rule cascade                        |

## Server plugin

`index.ts` hooks into three points:

- `ctx.tool.transform` registers the `todowrite` tool (codemode: false) so it stays in the chat catalog.
- `ctx.session.hook("context")` runs on every request. It re-reads the nearest `PROJECT.md`, the session rules file, and the session task file from disk and appends all three to the system prompt so neither depends on conversation history.
- `ctx.session.hook("compaction")` runs when history is compacted. It pushes the session rules and task list into the compaction context as separate verbatim sections.

Every read and write is best-effort. A failure never breaks a model request or a compaction.

### todowrite tool

The tool accepts the full task list on every call (matching V1 semantics). It writes the list to the per-session task file (`.opencode/prime-directives/<sessionID>.tasks.md`), replacing the entire file. On first use after upgrading from an older version, it also strips the legacy `## Task list (auto-synced)` section from the session rules file, leaving only user directives.

Status rendering:
- Completed items render as `[x]`
- Cancelled items render as `[-]`
- In-progress items gain an `(in progress)` note
- If the file does not exist yet, it is created with a short heading and session ID

### Task list sync

The task list is written to its own file (`.opencode/prime-directives/<sessionID>.tasks.md`). Every call replaces the entire file. Completed items render as `[x]`. Cancelled items render as `[-]`. In-progress items gain an `(in progress)` note. An empty task list removes the file. The session rules file is never modified by task-list sync; it is only read for user directives.

### Status sidecar

The plugin writes `.opencode/prime-directives/<sessionID>.status.json` with the rule count, overlay path, task file path, last injection time, and last compaction time. The TUI panel reads this file. The sidecar is optional and purely informational.

## TUI plugin

`tui.tsx` registers a `sidebar_content` slot (order 150) that lists:

- SYSTEM: the global `SYSTEM.md`, located through the config directory or `/etc/opencode`.
- PROJECT: the nearest `AGENTS.md` and `PROJECT.md`, shown side by side.
- SESSION: the current session rules file, with a shortened session ID.

Each layer shows a green dot and rule count when present. The footer shows how long ago rules were injected and compacted. The panel refreshes once a second. It shows a toast when it loads.

## Notes

- Without a session ID the server plugin falls back to `.opencode/prime-directives/SESSION.md`. Task-list sync and the status sidecar are skipped.
- `AGENTS.md` and the global `SYSTEM.md` are still loaded by OpenCode itself. This plugin only adds the overlay and session layers.
- Both files target the `@opencode/plugin` API (tested against `@opencode/plugin@2.0.30`). They are intended to load as the server and TUI parts of one plugin.
- Package exports: `"./tui"` for the TUI plugin. The server plugin is loaded via the plugin manifest and does not need a package export.

See [CHANGELOG.md](CHANGELOG.md) for version history.