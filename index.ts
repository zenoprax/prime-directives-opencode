// Session-rules — OpenCode V2 server plugin.
//
// Port of the V1 plugin (plugins/session-rules.ts). It injects two
// non-standard rule layers on every agent-loop request, so they survive
// context compaction:
//
//   PROJECT.md                            per-project overlay (overrides AGENTS.md)
//   .opencode/sessions/<sessionID>.md     per-session rules
//
// The developer's AGENTS.md and the global SYSTEM.md are handled by OpenCode
// itself (project/ambient discovery and the config "instructions" field), so
// they are not injected here.
//
// It also owns the session task list. OpenCode V2 removed the built-in
// todowrite tool and the session.todo API, so this plugin registers a
// V1-compatible `todowrite` tool (pinned to the chat catalog, not Code Mode)
// and writes the list to its own per-session file:
//
//   .opencode/sessions/<sessionID>.tasks.md
//
// Keeping tasks out of the rules file means rule counts stay accurate and a
// compaction can never merge tasks into the rule layer. Both files are re-read
// from disk on every request, so the task list outlives compaction.
//
// APIs verified against @opencode/plugin@2.0.30:
//   Plugin.define({ id, setup })
//   ctx.location.directory
//   ctx.tool.transform(editor)            editor.get(id) / editor.add(tool)
//   ctx.session.hook("context", cb)       event.sessionID, event.system: SystemPart[]
//   ctx.session.hook("compaction", cb)    event.sessionID, event.system: SystemPart[]
//   Tool.Result                           { content: string | Content[] }

import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const FALLBACK = ".opencode/SESSION.md"
const LEGACY_TASK_HEADING = "## Task list (auto-synced)"
const TASK_HEADING = "# Task list (auto-synced)"

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
type TodoPriority = "high" | "medium" | "low"
type Todo = { content: string; status: TodoStatus; priority: TodoPriority; activeForm?: string }

function rulesRelPath(sessionID?: string): string {
  return sessionID ? `.opencode/sessions/${sessionID}.md` : FALLBACK
}

function rulesFile(directory: string, sessionID?: string): string {
  return join(directory, rulesRelPath(sessionID))
}

function tasksRelPath(sessionID?: string): string {
  return sessionID ? `.opencode/sessions/${sessionID}.tasks.md` : ".opencode/sessions/SESSION.tasks.md"
}

function tasksFile(directory: string, sessionID?: string): string {
  return join(directory, tasksRelPath(sessionID))
}

function readFileIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
  } catch {
    return ""
  }
}

function readRules(directory: string, sessionID?: string): string {
  return readFileIfExists(rulesFile(directory, sessionID))
}

function readTasks(directory: string, sessionID?: string): string {
  return readFileIfExists(tasksFile(directory, sessionID))
}

// Older versions wrote the task list into the rules file under
// LEGACY_TASK_HEADING. Split it out so callers only ever see rule directives;
// writeTaskList() migrates the file itself on the next todowrite call.
function splitLegacyTasks(rules: string): { rules: string; tasks: string } {
  const index = rules.indexOf(LEGACY_TASK_HEADING)
  if (index < 0) return { rules, tasks: "" }
  return {
    rules: rules.slice(0, index).trim(),
    tasks: rules.slice(index).trim(),
  }
}

function nearest(directory: string, name: string): string | null {
  let dir = directory
  for (let i = 0; i < 32; i++) {
    const path = join(dir, name)
    if (existsSync(path)) return path
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readProjectOverlay(directory: string): { path: string; content: string } | null {
  const path = nearest(directory, "PROJECT.md")
  if (!path) return null
  try {
    const content = readFileSync(path, "utf8").trim()
    return content ? { path, content } : null
  } catch {
    return null
  }
}

const RULE = /^\s*[-*]\s+\S/

function countRules(rules: string): number {
  return splitLegacyTasks(rules)
    .rules.split("\n")
    .filter((line) => RULE.test(line)).length
}

// Best-effort status sidecar for the TUI panel. Never let status reporting
// break a model request or a compaction.
function updateStatus(directory: string, sessionID: string | undefined, patch: Record<string, unknown>): void {
  if (!sessionID) return
  try {
    const dir = join(directory, ".opencode", "sessions")
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${sessionID}.status.json`)
    let prev: Record<string, unknown> = {}
    if (existsSync(path)) {
      try {
        prev = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      } catch {
        prev = {}
      }
    }
    writeFileSync(path, JSON.stringify({ ...prev, ...patch }))
  } catch {
    // ignore
  }
}

function renderTasks(todos: Todo[]): string {
  return todos
    .map((todo) => {
      const box = todo.status === "completed" ? "[x]" : todo.status === "cancelled" ? "[-]" : "[ ]"
      const note =
        todo.status === "in_progress" ? "  (in progress)" : todo.status === "cancelled" ? "  (cancelled)" : ""
      return `- ${box} ${todo.content}${note}`
    })
    .join("\n")
}

function countTasks(tasks: string): number {
  return tasks.split("\n").filter((line) => /^\s*-\s+\[/.test(line)).length
}

// Replace the whole per-session task file. An empty list removes it. Also strips
// the legacy task section from the rules file so it stays directive-only.
function writeTaskList(directory: string, sessionID: string | undefined, todos: Todo[]): void {
  if (!sessionID) return

  // One-time migration from the version that kept tasks inside the rules file.
  const rulesPath = rulesFile(directory, sessionID)
  try {
    const text = readFileIfExists(rulesPath)
    const cut = text.indexOf(LEGACY_TASK_HEADING)
    if (cut >= 0) {
      writeFileSync(rulesPath, text.slice(0, cut).replace(/\s+$/, "") + "\n")
    }
  } catch {
    // ignore: the task file is still the source of truth
  }

  const path = tasksFile(directory, sessionID)
  try {
    if (todos.length === 0) {
      if (existsSync(path)) unlinkSync(path)
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${TASK_HEADING}\n\nSession: ${sessionID}\n\n${renderTasks(todos)}\n`)
  } catch {
    // ignore
  }
}

// The rules body and the task body are read separately; if the legacy section is
// still present (session never called todowrite since the upgrade), use it.
function readLayers(directory: string, sessionID: string | undefined): { rules: string; tasks: string } {
  const raw = readRules(directory, sessionID)
  const legacy = splitLegacyTasks(raw)
  return {
    rules: legacy.rules,
    tasks: readTasks(directory, sessionID) || legacy.tasks,
  }
}

function summarize(todos: Todo[]): string {
  const count = (status: TodoStatus) => todos.filter((todo) => todo.status === status).length
  return (
    `${todos.length} total: ${count("completed")} completed, ` +
    `${count("in_progress")} in progress, ${count("pending")} pending, ${count("cancelled")} cancelled`
  )
}

// JSON Schema input for the restored todowrite tool, matching the V1 tool
// semantics: every call replaces the whole list.
const TODOWRITE_INPUT = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "The full task list. Later calls replace the previous list.",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Brief description of the task" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
          priority: { type: "string", enum: ["high", "medium", "low"] },
          activeForm: {
            type: "string",
            description: "Present-tense description of the work while it is in progress",
          },
        },
        required: ["content", "status", "priority"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
}

const TODOWRITE_DESCRIPTION = [
  "Create and maintain a structured task list for the current coding session.",
  "Tracks progress, organizes multi-step work, and surfaces status to the user.",
  "",
  "Use proactively when the work is 3+ distinct steps, non-trivial, or the user",
  "lists multiple tasks. Skip single straightforward edits and purely",
  "informational questions.",
  "",
  "States: pending, in_progress (exactly one at a time), completed, cancelled.",
  "Update status as you go. Mark completed only after the work - including",
  "verification - is actually done. Every call replaces the full list.",
].join("\n")

export default Plugin.define({
  id: "local.session-rules",
  async setup(ctx) {
    const directory = ctx.location.directory

    // OpenCode V2 removed the built-in todowrite tool. Restore it here so the
    // established workflow (and SYSTEM.md) keeps working; the tool writes to
    // the per-session task file, which is what survives compaction.
    // codemode:false keeps the tool in the chat catalog instead of hiding it
    // behind the Code Mode `execute` tool.
    await ctx.tool.transform((editor) => {
      if (editor.get("todowrite")) return // a host-provided tool wins
      editor.add({
        name: "todowrite",
        description: TODOWRITE_DESCRIPTION,
        options: { codemode: false },
        input: TODOWRITE_INPUT,
        async execute(input, context) {
          const { todos } = input as { todos: Todo[] }
          const list = Array.isArray(todos) ? todos : []
          writeTaskList(directory, context.sessionID, list)
          updateStatus(directory, context.sessionID, { tasks: list.length })
          return { content: `Task list updated (${summarize(list)}).\n\n${renderTasks(list)}` }
        },
      })
    })

    // Runs immediately before every agent-loop model request. Keeps the
    // project overlay, session rules, and task list in front of the model
    // instead of relying on memory that compaction can discard.
    await ctx.session.hook("context", (event) => {
      const rel = rulesRelPath(event.sessionID)
      const { rules, tasks } = readLayers(directory, event.sessionID)
      const overlay = readProjectOverlay(directory)

      // The overlay goes first so the session rules (most specific) come last.
      if (overlay) {
        event.system.push({
          type: "text",
          text:
            "\n# PROJECT OVERLAY (project-specific; overrides SYSTEM/AGENTS.md on conflict)\n" +
            `File: ${overlay.path}\n\n` +
            overlay.content,
        })
      }

      event.system.push({
        type: "text",
        text:
          "\n# SESSION RULES (authoritative, mutable)\n" +
          `File: ${rel}\n` +
          "These rules outrank interactive prompts. When the user asks to add, " +
          `change, or drop a rule, edit ${rel}, then restate the full rule set ` +
          "to confirm. The task list is a separate file and is preserved across " +
          "compaction.\n\n" +
          (rules || "(no session rules set)"),
      })

      if (tasks) {
        event.system.push({
          type: "text",
          text:
            "\n# TASK LIST (preserve across compaction)\n" +
            `File: ${tasksRelPath(event.sessionID)}\n\n` +
            tasks,
        })
      }

      updateStatus(directory, event.sessionID, {
        at: Date.now(),
        rules: countRules(rules),
        file: rel,
        tasksFile: tasksRelPath(event.sessionID),
        overlay: overlay?.path ?? null,
      })
    })

    // Runs when the history is compacted. Preserve the session rules and the
    // task list so the summariser carries them forward. The task list is
    // already on disk (written on every todowrite call), so it is read
    // straight from its own file.
    await ctx.session.hook("compaction", (event) => {
      const { rules, tasks } = readLayers(directory, event.sessionID)
      const sections = [
        "## SESSION RULES (preserve verbatim; authoritative)\n" + (rules || "(no session rules set)"),
        tasks ? "## TASK LIST (preserve exactly; keep every item)\n" + tasks : "",
      ].filter(Boolean)
      event.system.push({ type: "text", text: sections.join("\n\n") })

      updateStatus(directory, event.sessionID, {
        compacted: Date.now(),
        rules: countRules(rules),
        tasks: countTasks(tasks),
      })
    })

    // No event subscriptions and no owned resources: hook and transform
    // registrations are disposed automatically when the plugin unloads.
  },
})
