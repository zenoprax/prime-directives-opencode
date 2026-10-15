# Session Rules

Session Rules is an OpenCode V2 plugin with two parts: a server plugin and a TUI plugin.

The server plugin injects two non-standard rule layers on every agent-loop request so they survive context compaction:

- **PROJECT.md** — per-project overlay that overrides AGENTS.md on conflict
- **.opencode/sessions/<sessionID>.md** — per-session rules (authoritative, mutable)

The developer's AGENTS.md and the global SYSTEM.md are handled by OpenCode itself (project/ambient discovery and the config `instructions` field). This plugin only adds the overlay and session layers.

It also restores the `todowrite` tool. OpenCode V2 removed the built-in todowrite tool and the session.todo API; this plugin registers a V1-compatible `todowrite` tool (pinned to the chat catalog, not Code Mode) and mirrors the list into the rules file under a `## Task list (auto-synced)` heading. Because the rules file is re-read from disk on every request, the task list outlives compaction.

## Rule cascade

| Layer   | Source                                         | Provided by                  |
| ------- | ---------------------------------------------- | ---------------------------- |
| SYSTEM  | global `SYSTEM.md` (config `instructions`)     | OpenCode                     |
| PROJECT | `AGENTS.md` (developer) + `PROJECT.md` (overlay) | OpenCode + this plugin       |
| SESSION | `.opencode/sessions/<sessionID>.md`            | this plugin                  |

The list is ordered least to most specific. The server plugin injects the PROJECT overlay first and the SESSION rules last. The most specific layer has the final word.

## Files

| File          | Role                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `index.ts`    | Server plugin: injection, todowrite tool, task-list sync, compaction      |
| `tui.tsx`     | TUI plugin: sidebar panel showing the rule cascade                        |

## Server plugin

`index.ts` hooks into three points:

- `ctx.tool.transform` registers the `todowrite` tool (codemode: false) so it stays in the chat catalog.
- `ctx.session.hook("context")` runs on every request. It re-reads the nearest `PROJECT.md` and the session rules file from disk and appends both to the system prompt so neither depends on conversation history.
- `ctx.session.hook("compaction")` runs when history is compacted. It pushes the session rules and task list into the compaction context as verbatim sections.

Every read and write is best-effort. A failure never breaks a model request or a compaction.

### todowrite tool

The tool accepts the full task list on every call (matching V1 semantics). It writes the list into the session rules file under `## Task list (auto-synced)`, replacing that section in place while leaving every other line — the user's directives — untouched.

Status rendering:
- Completed items render as `[x]`
- Cancelled items render as `[-]`
- In-progress items gain an `(in progress)` note
- If the file does not exist yet, it is created with a short heading and session ID

### Task list sync

The task-list section is replaced in place. Every other line of the rules file is left untouched. Completed items render as `[x]`. Cancelled items render as `[-]`. In-progress items gain an `(in progress)` note. If the file does not exist yet, it is created with a short heading and session ID.

### Status sidecar

The plugin writes `.opencode/sessions/<sessionID>.status.json` with the rule count, overlay path, last injection time, and last compaction time. The TUI panel reads this file. The sidecar is optional and purely informational.

## TUI plugin

`tui.tsx` registers a `sidebar_content` slot (order 150) that lists:

- **SYSTEM**: the global `SYSTEM.md`, located through the config directory or `/etc/opencode`.
- **PROJECT**: the nearest `AGENTS.md` and `PROJECT.md`, shown side by side.
- **SESSION**: the current session rules file, with a shortened session ID.

Each layer shows a green dot and rule count when present. The footer shows how long ago rules were injected and compacted. The panel refreshes once a second. It shows a toast when it loads.

## Notes

- Without a session ID the server plugin falls back to `.opencode/SESSION.md`. Task-list sync and the status sidecar are skipped.
- `AGENTS.md` and the global `SYSTEM.md` are still loaded by OpenCode itself. This plugin only adds the overlay and session layers.
- Both files target the `@opencode/plugin` API (tested against `@opencode/plugin@2.0.30`). They are intended to load as the server and TUI parts of one plugin.
- Package exports: `"."` for the server plugin, `"./tui"` for the TUI plugin.