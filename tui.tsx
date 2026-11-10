/** @jsxImportSource @opentui/solid */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createMemo, createSignal, onCleanup } from "solid-js"

// TUI status panel for the prime-directives plugin — OpenCode V2 CLI port.
//
// Shows the rule cascade:
//
//   SYSTEM   the global SYSTEM.md (referenced by config "instructions")
//   PROJECT  the developer's AGENTS.md AND the PROJECT.md overlay, side by side
//   SESSION  prime-directives file (.opencode/prime-directives/<sessionID>.md)
//
// The server plugin's sidecar (.opencode/prime-directives/<sessionID>.status.json)
// drives the "injected" / "compacted" readout.
//
// APIs verified against @opencode/plugin@2.0.30:
//   Plugin.define({ id, setup })
//   context.ui.slot({ append: "sidebar.content", render })
//   context.ui.toast.show({ ... })
//   context.theme.text.{base,muted}.feedback.success.base
//   usePlugin()

const RULE = /^\s*[-*]\s+\S/

type LayerKey = "SYSTEM" | "PROJECT" | "SESSION"

type Layer = {
  key: LayerKey
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

// PROJECT is two layers in one: the developer's AGENTS.md and the PROJECT.md
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

// SYSTEM is the single global SYSTEM.md referenced by config "instructions".
// V2's CLI plugin context no longer exposes the config path, so only the
// well-known locations are probed.
function systemRule(): string | null {
  const dirs = [join(homedir(), ".config", "opencode"), process.env.OPENCODE_CONFIG_DIR, "/etc/opencode"].filter(
    (dir): dir is string => Boolean(dir),
  )
  return firstExisting(dirs.map((dir) => join(dir, "SYSTEM.md")))
}

function display(path: string, base: string): string {
  if (path === base) return "."
  if (path.startsWith(base + "/")) return path.slice(base.length + 1)
  const home = homedir()
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length)
  return path
}

function layers(directory: string, sessionID: string): Layer[] {
  const system = systemRule()
  const projects = projectFiles(directory)
  const session = join(directory, ".opencode", "prime-directives", `${sessionID}.md`)

  const layer = (key: LayerKey, path: string | null, label: string): Layer => {
    const state = path ? inspect(path) : { exists: false, rules: 0 }
    return { key, path: path ?? "", label, exists: state.exists, rules: state.rules }
  }

  const out: Layer[] = [layer("SYSTEM", system, system ? display(system, directory) : "not set")]
  if (projects.length === 0) {
    out.push(layer("PROJECT", null, "not set"))
  } else {
    for (const path of projects) out.push(layer("PROJECT", path, display(path, directory)))
  }
  out.push(layer("SESSION", session, `.opencode/prime-directives/${sessionID.slice(0, 8)}.md`))
  return out
}

function status(directory: string, sessionID: string): { injected: number | null; compacted: number | null } {
  let injected: number | null = null
  let compacted: number | null = null
  try {
    const path = join(directory, ".opencode", "prime-directives", `${sessionID}.status.json`)
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

function View(props: { sessionID: string }) {
  const context = usePlugin()
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  onCleanup(() => clearInterval(timer))

  const directory = () => context.location?.directory ?? process.cwd()

  const info = createMemo<Info>(() => {
    tick()
    return {
      layers: layers(directory(), props.sessionID),
      ...status(directory(), props.sessionID),
    }
  })

  return (
    <box>
      <text fg={context.theme.text.base}>
        <b>Rules</b>
      </text>
      <For each={info().layers}>
        {(layer) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} fg={layer.exists ? context.theme.text.feedback.success.base : context.theme.text.muted}>
              •
            </text>
            <text fg={context.theme.text.base} wrapMode="word">
              <b>{layer.key}</b>{" "}
              <span style={{ fg: context.theme.text.muted }}>
                {layer.label}
                {layer.exists ? `  ${layer.rules}` : ""}
              </span>
            </text>
          </box>
        )}
      </For>
      <text fg={context.theme.text.muted}>
        injected {ago(info().injected)}
        {info().compacted ? ` · compacted ${ago(info().compacted)}` : ""}
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "local.prime-directives.tui",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <View sessionID={props.sessionID} />,
    })

    context.ui.toast.show({
      variant: "info",
      title: "prime-directives",
      message: "Rule cascade panel active",
      duration: 3000,
    })
  },
})
