# Session Rules

Session Rules is a two-part OpenCode plugin.
It keeps session directives and the task list in front of the model across context compaction.
It adds a session layer beneath the existing SYSTEM and PROJECT layers.
It mirrors the todo list into the session rules file on disk.

## Rule cascade

| Layer   | Source                                         | Provided by                  |
| ------- | ---------------------------------------------- | ---------------------------- |
| SYSTEM  | global `SYSTEM.md`                             | OpenCode `instructions`      |
| PROJECT | `AGENTS.md` plus the `PROJECT.md` overlay      | OpenCode and this plugin     |
| SESSION | `.opencode/sessions/<sessionID>.md`            | this plugin                  |

The list is ordered least to most specific.
The server plugin injects the overlay first and the session rules last.
The most specific layer has the final word.

## Files

| File                      | Role                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `session-rules.ts`        | Server plugin: injection, task-list sync, compaction survival   |
| `session-rules-tui.tsx`   | TUI plugin: sidebar panel showing the rule cascade              |

## Server plugin

`session-rules.ts` hooks into three points:

- `experimental.chat.system.transform` runs on every request.
  It re-reads the nearest `PROJECT.md` and the session rules file from disk.
  It appends both to the system prompt so neither depends on conversation history.
- `todo.updated` mirrors the current todo list into the rules file under `## Task list (auto-synced)`.
- `experimental.session.compacting` refreshes the task list.
  It pushes the session rules and task list into the compaction context as verbatim sections.

Every write is best-effort.
A failed read or write never breaks a model request or a compaction.

### Task list sync

The task-list section is replaced in place.
Every other line of the rules file is left untouched.
Completed items render as `[x]`.
Cancelled items render as `[-]`.
In-progress items gain an `(in progress)` note.
If the file does not exist yet, it is created with a short heading and session ID.

### Status sidecar

The plugin writes `.opencode/sessions/<sessionID>.status.json` with the rule count, overlay path, last injection time, and last compaction time.
The TUI panel reads this file.
The sidecar is optional and purely informational.

## TUI plugin

`session-rules-tui.tsx` registers a `sidebar_content` slot (order 150) that lists:

- SYSTEM: the global `SYSTEM.md`, located through the config directory or `/etc/opencode`.
- PROJECT: the nearest `AGENTS.md` and `PROJECT.md`, shown side by side.
- SESSION: the current session rules file, with a shortened session ID.

Each layer shows a green dot and rule count when present.
The footer shows how long ago rules were injected and compacted.
The panel refreshes once a second.
It shows a toast when it loads.

## Notes

- Without a session ID the server plugin falls back to `.opencode/SESSION.md`.
  Task-list sync and the status sidecar are skipped.
- `AGENTS.md` and the global `SYSTEM.md` are still loaded by OpenCode itself.
  This plugin only adds the overlay and session layers.
- Both files target the `@opencode-ai/plugin` API.
  They are intended to load as the server and TUI parts of one plugin.