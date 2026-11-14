import { Plugin } from "@opencode/plugin"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const FALLBACK = ".opencode/prime-directives/SESSION.md"
const TASK_HEADING = "# Task list (auto-synced)"

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
type TodoPriority = "high" | "medium" | "low"
type Todo = { content: string; status: TodoStatus; priority: TodoPriority; activeForm?: string }

function directivesRelPath(sessionID?: string): string {
  return sessionID ? `.opencode/prime-directives/${sessionID}.md` : FALLBACK
}

function directivesFile(directory: string, sessionID?: string): string {
  return join(directory, directivesRelPath(sessionID))
}

function tasksRelPath(sessionID?: string): string {
  return sessionID ? `.opencode/prime-directives/${sessionID}.tasks.md` : ".opencode/prime-directives/SESSION.tasks.md"
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

function readDirectives(directory: string, sessionID?: string): string {
  return readFileIfExists(directivesFile(directory, sessionID))
}

function readTasks(directory: string, sessionID?: string): string {
  return readFileIfExists(tasksFile(directory, sessionID))
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

const DIRECTIVE = /^\s*[-*]\s+\S/

function countDirectives(directives: string): number {
  return directives.split("\n").filter((line) => DIRECTIVE.test(line)).length
}

// Best-effort status sidecar for the TUI panel. Never let status reporting
// break a model request or a compaction.
function updateStatus(directory: string, sessionID: string | undefined, patch: Record<string, unknown>): void {
  if (!sessionID) return
  try {
    const dir = join(directory, ".opencode", "prime-directives")
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

// Replace the whole per-session task file. An empty list removes it.
function writeTaskList(directory: string, sessionID: string | undefined, todos: Todo[]): void {
  if (!sessionID) return

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

function summarize(todos: Todo[]): string {
  const count = (status: TodoStatus) => todos.filter((todo) => todo.status === status).length
  return (
    `${todos.length} total: ${count("completed")} completed, ` +
    `${count("in_progress")} in progress, ${count("pending")} pending, ${count("cancelled")} cancelled`
  )
}

// JSON Schema input for the todowrite tool. Every call replaces the whole list.
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
  id: "local.prime-directives",
  async setup(ctx) {
    const directory = ctx.location.directory

    // The tool writes to the per-session task file, which survives compaction.
    // codemode:false keeps the tool in the chat catalog instead of hiding it
    // behind the Code Mode `execute` tool.
    await ctx.tool.transform((editor) => {
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
    // project overlay, prime directives, and task list in front of the model
    // instead of relying on memory that compaction can discard.
    await ctx.session.hook("context", (event) => {
      const rel = directivesRelPath(event.sessionID)
      const directives = readDirectives(directory, event.sessionID)
      const tasks = readTasks(directory, event.sessionID)
      const overlay = readProjectOverlay(directory)

      // The overlay goes first so the prime directives (most specific) come last.
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
          "\n# PRIME DIRECTIVES (authoritative, mutable)\n" +
          `File: ${rel}\n` +
          "These directives outrank interactive prompts. When the user asks to add, " +
          `change, or drop a directive, edit ${rel}, then restate the full directive set ` +
          "to confirm. The task list is a separate file and is preserved across " +
          "compaction.\n\n" +
          (directives || "(no prime directives set)"),
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
        directives: countDirectives(directives),
        file: rel,
        tasksFile: tasksRelPath(event.sessionID),
        overlay: overlay?.path ?? null,
      })
    })

    // Runs when the history is compacted. Preserve the prime directives and the
    // task list so the summariser carries them forward. The task list is
    // already on disk (written on every todowrite call), so it is read
    // straight from its own file.
    await ctx.session.hook("compaction", (event) => {
      const directives = readDirectives(directory, event.sessionID)
      const tasks = readTasks(directory, event.sessionID)
      const sections = [
        "## PRIME DIRECTIVES (preserve verbatim; authoritative)\n" + (directives || "(no prime directives set)"),
        tasks ? "## TASK LIST (preserve exactly; keep every item)\n" + tasks : "",
      ].filter(Boolean)
      event.system.push({ type: "text", text: sections.join("\n\n") })

      updateStatus(directory, event.sessionID, {
        compacted: Date.now(),
        directives: countDirectives(directives),
        tasks: countTasks(tasks),
      })
    })

    // No event subscriptions and no owned resources: hook and transform
    // registrations are disposed automatically when the plugin unloads.
  },
})
