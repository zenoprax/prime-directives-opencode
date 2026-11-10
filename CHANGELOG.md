# Changelog

All notable changes to this project are documented here.

## [Unreleased]

## [1.0.0] - 2026-11-10

### Renamed from `session-rules` to `prime-directives`

**Package renamed**
- `@local/opencode-session-rules` → `@local/prime-directives`

**Plugin IDs renamed**
- Server: `local.session-rules` → `local.prime-directives`
- TUI: `local.session-rules.tui` → `local.prime-directives.tui`

**File paths updated**
- `.opencode/sessions/<sessionID>.md` → `.opencode/prime-directives/<sessionID>.md`
- `.opencode/sessions/<sessionID>.tasks.md` → `.opencode/prime-directives/<sessionID>.tasks.md`
- `.opencode/sessions/<sessionID>.status.json` → `.opencode/prime-directives/<sessionID>.status.json`

**Terminology updated**
- "session rules" → "prime directives"
- "rule" (in session context) → "directive"
- All user-facing messages, comments, and documentation updated accordingly

**Functionality unchanged** — only naming and paths changed.

---

## [0.3.0] - 2026-10-31

### Bug fixes

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

---

## [0.2.0] - 2026-10-15

### Features
- Ported plugin to OpenCode V2 plugin API
- Server plugin with `context` and `compaction` hooks
- TUI plugin with sidebar panel showing rule cascade
- `todowrite` tool restored (codemode: false)

---

## [0.1.0] - 2026-10-13

### Initial release
- Session rules persistence across compaction
- Basic project/session rule layer injection