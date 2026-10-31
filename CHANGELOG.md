# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Commit `16e6122` — Bug fixes (2026-10-31)

**Task list now lives in its own file**
The `todowrite` tool no longer embeds the task list inside the session rules file (`.opencode/sessions/<sessionID>.md`). Instead, it writes to a dedicated per-session file:
```
.opencode/sessions/<sessionID>.tasks.md
```
This change:
- Keeps rule counts accurate (tasks no longer inflate the directive count)
- Prevents compaction from ever merging tasks into the rule layer
- Both files are still re-read from disk on every request, so the task list outlives compaction

**Automatic migration from legacy format**
Sessions created with older versions stored the task list under `## Task list (auto-synced)` inside the rules file. On the first `todowrite` call after upgrade, the plugin:
1. Strips the legacy section from the rules file, leaving only user directives
2. Writes the current task list to the new `.tasks.md` file

No manual action is required; the migration is one-way and idempotent.

**Package exports trimmed**
The main entry point (`"."`) was removed from `package.json`. The plugin now only exports the TUI component:
```json
"exports": { "./tui": "./tui.tsx" }
```
The server plugin is loaded directly by OpenCode via the plugin manifest; it does not need a package export.

**Internal refinements**
- Rule counting now strips the legacy task section before counting directives
- New `readLayers()` helper reads rules and tasks from their separate files, falling back to the legacy section only when a session has not yet called `todowrite` since upgrade
- Compaction hook injects rules and task list as separate verbatim sections
- Status sidecar now includes `tasksFile` path for TUI reference