/** @jsxImportSource @opentui/solid */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, createMemo, createSignal, onCleanup } from "solid-js"

// TUI status panel for the session-rules plugin.
//
// Shows the rule cascade:
//
//   SYSTEM   your global SYSTEM.md (hard-coded via config "instructions")
//   PROJECT  the developer's AGENTS.md AND your PROJECT.md overlay, side by side
//   SESSION  session-rules file (.opencode/sessions/<sessionID>.md)
//
// The server plugin sidecar (.opencode/sessions/<sessionID>.status.json) drives
// the "injected" / "compacted" readout.

const id = "local.session-rules"
const RULE = /^\s*[-*]\s+\S/

type Layer = {
  key: "SYSTEM" | "PROJECT" | "SESSION"
  path: string
  label: string
  exists: boolean
  rules: number
}

type Info = {
  layers: Layer[]
  injected: number | null
  compacted: number | null
}

function countRules(text: string): number {
  return text.split("\n").filter((line) => RULE.test(line)).length
}

function inspect(path: string): { exists: boolean; rules: number } {
  try {
    if (!existsSync(path)) return { exists: false, rules: 0 }
    const raw = readFileSync(path, "utf8")
    return { exists: raw.trim().length > 0, rules: countRules(raw) }
  } catch {
    return { exists: false, rules: 0 }
  }
}

function ancestors(from: string): string[] {
  const out: string[] = []
  let dir = from
  for (let i = 0; i < 32; i++) {
    out.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

function firstExisting(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path
  }
  return null
}

function nearest(directory: string, name: string): string | null {
  for (const dir of ancestors(directory)) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return null
}

// PROJECT is two layers in one: the developer's AGENTS.md and your PROJECT.md
// overlay. Show both; the overlay is injected by the server plugin so it wins
// on conflicts.
function projectFiles(directory: string): string[] {
  const agents = nearest(directory, "AGENTS.md")
  const overlay = nearest(directory, "PROJECT.md")
  const out: string[] = []
  if (agents) out.push(agents)
  if (overlay) out.push(overlay)
  return out
}

// SYSTEM is the single global SYSTEM.md referenced by config "instructions",
// so there is no second filename to guess.
function systemRule(config: string): string | null {
  const dirs = [
    join(homedir(), ".config", "opencode"),
    process.env.OPENCODE_CONFIG_DIR,
    config,
    "/etc/opencode",
  ].filter((dir): dir is string => Boolean(dir))
  return firstExisting(dirs.map((dir) => join(dir, "SYSTEM.md")))
}

function display(path: string, base: string): string {
  if (path === base) return "."
  if (path.startsWith(base + "/")) return path.slice(base.length + 1)
  const home = homedir()
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length)
  return path
}

function layers(api: TuiPluginApi, sessionID: string): Layer[] {
  const directory = api.state.path.directory
  const system = systemRule(api.state.path.config)
  const projects = projectFiles(directory)
  const session = join(directory, ".opencode", "sessions", `${sessionID}.md`)

  const layer = (key: Layer["key"], path: string | null, label: string): Layer => {
    const state = path ? inspect(path) : { exists: false, rules: 0 }
    return { key, path: path ?? "", label, exists: state.exists, rules: state.rules }
  }

  const out: Layer[] = [layer("SYSTEM", system, system ? display(system, directory) : "not set")]
  if (projects.length === 0) {
    out.push(layer("PROJECT", null, "not set"))
  } else {
    for (const path of projects) out.push(layer("PROJECT", path, display(path, directory)))
  }
  out.push(layer("SESSION", session, `.opencode/sessions/${sessionID.slice(0, 8)}.md`))
  return out
}

function status(directory: string, sessionID: string): { injected: number | null; compacted: number | null } {
  let injected: number | null = null
  let compacted: number | null = null
  try {
    const path = join(directory, ".opencode", "sessions", `${sessionID}.status.json`)
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown; compacted?: unknown }
      if (typeof data.at === "number") injected = data.at
      if (typeof data.compacted === "number") compacted = data.compacted
    }
  } catch {
    // ignore unreadable status files
  }
  return { injected, compacted }
}

function ago(at: number | null): string {
  if (!at) return "never"
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  onCleanup(() => clearInterval(timer))

  const info = createMemo<Info>(() => {
    tick()
    const directory = props.api.state.path.directory
    return {
      layers: layers(props.api, props.session_id),
      ...status(directory, props.session_id),
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Rules</b>
      </text>
      <For each={info().layers}>
        {(layer) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} style={{ fg: layer.exists ? theme().success : theme().textMuted }}>
              •
            </text>
            <text fg={theme().text} wrapMode="word">
              <b>{layer.key}</b>{" "}
              <span style={{ fg: theme().textMuted }}>
                {layer.label}
                {layer.exists ? `  ${layer.rules}` : ""}
              </span>
            </text>
          </box>
        )}
      </For>
      <text fg={theme().textMuted}>
        injected {ago(info().injected)}
        {info().compacted ? ` · compacted ${ago(info().compacted)}` : ""}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })

  api.ui.toast({
    variant: "info",
    title: "session-rules",
    message: "Rule cascade panel active",
    duration: 3000,
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }

export default plugin
