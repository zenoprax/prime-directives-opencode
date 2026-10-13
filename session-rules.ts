// Session-rules plugin.
//
// Injects two non-standard rule layers on every request, so they survive
// context compaction:
//
//   PROJECT.md  per-project overlay (overrides AGENTS.md/SYSTEM.md on conflict)
//   .opencode/sessions/<sessionID>.md  per-session rules
//
// The developer's AGENTS.md and your global SYSTEM.md are handled by opencode
// itself (via project discovery and the config "instructions" field), so they
// are not injected here.
//
// It also mirrors the session todo list into the rules file under a
// "## Task list" heading. Because the rules file is re-read from disk on every
// request, the task list outlives compaction (PROJECT-level directive). The
// list is refreshed on each `todo.updated` event and again at compaction time
// as a safety net.
//
// Hook signatures verified against @opencode-ai/plugin (installed) index.d.ts:
//   event:                              input { event }
//   experimental.chat.system.transform: input { sessionID?, model }, output { system: string[] }
//   experimental.session.compacting:    input { sessionID },        output { context: string[], prompt? }

import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const FALLBACK = ".opencode/SESSION.md"
const TASK_HEADING = "## Task list (auto-synced)"

type Todo = { content: string; status: string; priority?: string }
type Client = PluginInput["client"]

function rulesRelPath(sessionID?: string): string {
  return sessionID ? `.opencode/sessions/${sessionID}.md` : FALLBACK
}

function rulesFile(directory: string, sessionID?: string): string {
  return join(directory, rulesRelPath(sessionID))
}

function readRules(directory: string, sessionID?: string): string {
  const path = rulesFile(directory, sessionID)
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
  } catch {
    return ""
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
  return rules.split("\n").filter((line) => RULE.test(line)).length
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

function readTaskSection(rules: string): string {
  const index = rules.indexOf(TASK_HEADING)
  return index >= 0 ? rules.slice(index).trim() : ""
}

// Replace (or append) the auto-managed task-list section in the rules file,
// leaving every other line — the user's directives — untouched.
function writeTaskList(directory: string, sessionID: string | undefined, todos: Todo[]): void {
  if (!sessionID) return
  const path = rulesFile(directory, sessionID)
  let text = ""
  try {
    text = existsSync(path) ? readFileSync(path, "utf8") : ""
  } catch {
    text = ""
  }
  if (!text.trim()) {
    text = `# Session rules\n\nSession: ${sessionID}\nAuthoritative for this session; subordinate to the SYSTEM and PROJECT layers.\n`
  }
  const cut = text.indexOf(TASK_HEADING)
  if (cut >= 0) text = text.slice(0, cut)
  const body = text.replace(/\s+$/, "")
  const section = todos.length ? `\n\n${TASK_HEADING}\n\n${renderTasks(todos)}\n` : "\n"
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body + section)
  } catch {
    // ignore
  }
}

async function fetchTodos(client: Client, sessionID?: string): Promise<Todo[]> {
  if (!sessionID) return []
  try {
    const result = (await client.session.todo({ path: { id: sessionID } })) as { data?: unknown }
    return Array.isArray(result.data) ? (result.data as Todo[]) : []
  } catch {
    return []
  }
}

export default (async ({ directory, client }) => {
  return {
    // Keep the on-disk task list current as the agent works, so compaction
    // always has a fresh copy to carry forward.
    event: async ({ event }) => {
      if (event.type !== "todo.updated") return
      const { sessionID, todos } = event.properties as { sessionID: string; todos: Todo[] }
      writeTaskList(directory, sessionID, todos)
      updateStatus(directory, sessionID, { tasks: todos.length })
    },

    // Runs on every model request. Keeps the project overlay and session rules
    // in front of the model instead of relying on memory that compaction can discard.
    "experimental.chat.system.transform": async (input, output) => {
      const rel = rulesRelPath(input.sessionID)
      const rules = readRules(directory, input.sessionID)
      const overlay = readProjectOverlay(directory)

      // The overlay goes first so the session rules (most specific) come last.
      if (overlay) {
        output.system.push(
          "\n# PROJECT OVERLAY (project-specific; overrides SYSTEM/AGENTS.md on conflict)\n" +
            `File: ${overlay.path}\n\n` +
            overlay.content,
        )
      }

      output.system.push(
        "\n# SESSION RULES (authoritative, mutable)\n" +
          `File: ${rel}\n` +
          "These rules outrank interactive prompts. When the user asks to add, " +
          `change, or drop a rule, edit ${rel}, then restate the full rule set ` +
          "to confirm. Preserve the task list below across compaction.\n\n" +
          (rules || "(no session rules set)"),
      )

      updateStatus(directory, input.sessionID, {
        at: Date.now(),
        rules: countRules(rules),
        file: rel,
        overlay: overlay?.path ?? null,
      })
    },

    // Runs when the history is compacted. Preserve the session rules and the
    // task list (the overlay is re-read from disk each turn, so it needs no
    // preservation). Refresh the on-disk task list first so the summariser sees
    // the current one even if no todo.updated event was observed.
    "experimental.session.compacting": async (input, output) => {
      const rules = readRules(directory, input.sessionID)
      const todos = await fetchTodos(client, input.sessionID)
      if (todos.length) writeTaskList(directory, input.sessionID, todos)

      const tasks = todos.length ? renderTasks(todos) : readTaskSection(rules)
      const sections = [
        "## SESSION RULES (preserve verbatim; authoritative)\n" + (rules || "(no session rules set)"),
        tasks ? "## TASK LIST (preserve exactly; keep every item)\n" + tasks : "",
      ].filter(Boolean)
      output.context.push(sections.join("\n\n"))

      updateStatus(directory, input.sessionID, {
        compacted: Date.now(),
        rules: countRules(rules),
        tasks: todos.length,
      })
    },
  }
}) satisfies Plugin
