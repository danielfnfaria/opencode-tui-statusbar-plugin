/** @jsxImportSource @opentui/solid */
// opencode-tui-statusbar-plugin v0.3.0
// Installed by install.sh — re-run the installer to update, install.sh --remove to uninstall.
// agtop-style status for the opencode TUI.
// Compact line next to the prompt + `/top` (or palette) modal with per-agent detail.
// Data sources: api.state (messages/tokens/cost/status/vcs/providers), session events, and the
// plan usage file written by `agtop setup` (<config dir>/agtop/usage.json: 5h/7d windows).
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"

const id = "agtop.status"

// ---- palette (truecolor; fg accepts #RRGGBB) ----------------------------------------------
// Catppuccin Mocha-flavored accents, matching the Claude status line.
const C = {
  pink: "#f5c2e7", // branch
  mauve: "#cba6f7", // 7d label
  blue: "#89b4fa", // model
  lav: "#b4befe", // 5h label
  teal: "#94e2d5", // tokens in
  peach: "#fab387", // tokens out
  green: "#a6e3a1", // low usage
  yellow: "#f9e2af", // mid usage
  red: "#f38ba8", // high usage
  dim: "#6c7086", // muted
  overlay: "#45475a", // empty bars
} as const

type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
type AnySession = {
  id: string
  title?: string
  parentID?: string
  time?: { created?: number; updated?: number }
}
type UsageWindow = { percent: number; resetsAt: number }
type Usage = { updatedAt: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }

const USAGE_STALE_MS = 10 * 60_000 // matches agtop: older than this is stale
const USAGE_BAR_WIDTH = 8
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function fmtTok(n: number): string {
  if (!Number.isFinite(n)) return "-"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(Math.round(n))
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return "-"
  if (n >= 1) return "$" + n.toFixed(2)
  if (n >= 0.01) return "$" + n.toFixed(3)
  return "$" + n.toFixed(4)
}

// Gradient bar: filled cells run green → yellow → red across the width, empty cells in overlay
// grey. Mirrors bar() in ~/.claude/statusline.sh so both bars read identically.
const BAR_GREEN: number[] = [166, 227, 161]
const BAR_YELLOW: number[] = [249, 226, 175]
const BAR_RED: number[] = [243, 139, 168]

function barCellColor(index: number, width: number): string {
  const t = width === 1 ? 0 : (index * 100) / (width - 1)
  const [from, to] = t < 50 ? [BAR_GREEN, BAR_YELLOW] : [BAR_YELLOW, BAR_RED]
  const k = t < 50 ? t / 50 : (t - 50) / 50
  const rgb = from.map((v, i) => Math.round(v + (to[i] - v) * k).toString(16).padStart(2, "0"))
  return "#" + rgb.join("")
}

function barCells(pct: number, width = USAGE_BAR_WIDTH): Array<{ char: string; color: string }> {
  const p = Math.max(0, Math.min(100, pct))
  let filled = Math.round((p * width) / 100)
  if (p > 0 && filled === 0) filled = 1
  return Array.from({ length: width }, (_, i) =>
    i < filled ? { char: "▰", color: barCellColor(i, width) } : { char: "▱", color: C.overlay },
  )
}

// `▰▱` bar, one cell per <text> so each can carry its own gradient color.
const Bar = (props: { pct: number; width?: number }) => (
  <box flexDirection="row" gap={0}>
    {barCells(props.pct, props.width).map((cell) => (
      <text fg={cell.color}>{cell.char}</text>
    ))}
  </box>
)

// Group separator; the row's gap={1} makes it read as `a │ b`.
const Sep = () => <text fg={C.overlay}>│</text>

// Compact model label: last `-` segment of the id (`deepseek-v4.1-flash` → `flash`).
const shortModel = (modelID: string): string => modelID.split("-").pop() || modelID

const usageColor = (p: number): string => (p >= 80 ? C.red : p >= 50 ? C.yellow : C.green)

function resetHHMM(ms: number): string {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
}

function resetDay(ms: number, now: number): string {
  return ms - now < 86_400_000 ? resetHHMM(ms) : WEEKDAYS[new Date(ms).getDay()]
}

// ---- plan usage (5h / 7d), read from agtop's usage.json -----------------------------------
function usageFilePath(): string {
  if (process.env.AGTOP_USAGE_FILE) return process.env.AGTOP_USAGE_FILE
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
  return join(dir, "agtop", "usage.json")
}

function normWindow(v: any): UsageWindow | undefined {
  if (!v || typeof v !== "object") return undefined
  if (typeof v.percent !== "number" || !Number.isFinite(v.percent)) return undefined
  const w: UsageWindow = { percent: Math.min(100, Math.max(0, v.percent)), resetsAt: 0 }
  if (typeof v.resetsAt === "number" && Number.isFinite(v.resetsAt)) w.resetsAt = v.resetsAt
  return w
}

function readUsage(): Usage | null {
  try {
    const v = JSON.parse(readFileSync(usageFilePath(), "utf8"))
    if (!v || typeof v !== "object" || typeof v.updatedAt !== "number") return null
    const fiveHour = normWindow(v.fiveHour)
    const sevenDay = normWindow(v.sevenDay)
    if (!fiveHour && !sevenDay) return null
    return { updatedAt: v.updatedAt, fiveHour, sevenDay }
  } catch {
    return null // missing/invalid: the bar falls back to `5h —  7d —`
  }
}

const tui: TuiPlugin = async (api) => {
  // Known sessions (root + sub-agents). Seeded once, kept fresh by events.
  const known = new Map<string, AnySession>()
  try {
    const res: any = await api.client.session.list()
    const list: AnySession[] = Array.isArray(res) ? res : (res?.data ?? res?.sessions ?? [])
    for (const s of list) if (s?.id) known.set(s.id, s)
  } catch {
    // best effort; events below still populate the map
  }

  const unsubs: Array<() => void> = [
    api.event.on("session.created", (e: any) => {
      const info = e?.properties?.info
      if (info?.id) known.set(info.id, info)
    }),
    api.event.on("session.updated", (e: any) => {
      const info = e?.properties?.info
      if (info?.id) known.set(info.id, { ...known.get(info.id), ...info })
    }),
    api.event.on("session.deleted", (e: any) => {
      const sid = e?.properties?.sessionID ?? e?.properties?.info?.id
      if (sid) known.delete(sid)
    }),
  ]
  api.lifecycle.onDispose(() => {
    for (const u of unsubs) u()
  })

  // Plan usage: a low-frequency poll; the file is tiny and only changes with Claude activity.
  const [usage, setUsage] = createSignal<Usage | null>(readUsage())
  const usageTimer = setInterval(() => setUsage(readUsage()), 5_000)
  api.lifecycle.onDispose(() => clearInterval(usageTimer))

  const currentSessionID = (): string | undefined => {
    const route = api.route.current
    return route.name === "session" ? (route.params?.sessionID as string | undefined) : undefined
  }

  const assistantMessages = (sid: string) =>
    api.state.session.messages(sid).filter((m: any) => m?.role === "assistant") as any[]

  // Totals for one session: cumulative tokens/cost and current context size
  // (prompt of the last assistant step: input + cache + reasoning + output).
  const totals = (sid: string) => {
    const tot: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    let cost = 0
    let ctx = 0
    let modelID: string | undefined
    let providerID: string | undefined
    for (const m of assistantMessages(sid)) {
      const t = m?.tokens as Tokens | undefined
      if (t) {
        tot.input += t.input ?? 0
        tot.output += t.output ?? 0
        tot.reasoning += t.reasoning ?? 0
        tot.cache.read += t?.cache?.read ?? 0
        tot.cache.write += t?.cache?.write ?? 0
      }
      if (typeof m?.cost === "number") cost += m.cost
      if (t) {
        ctx =
          (t.input ?? 0) +
          (t.cache?.read ?? 0) +
          (t.cache?.write ?? 0) +
          (t.reasoning ?? 0) +
          (t.output ?? 0)
      }
      modelID = m?.modelID ?? modelID
      providerID = m?.providerID ?? providerID
    }
    return { tot, cost, ctx, modelID, providerID }
  }

  const modelLimit = (modelID?: string): { context: number; output: number } | undefined => {
    if (!modelID) return undefined
    for (const p of api.state.provider as any[]) {
      const models = p?.models
      if (!models) continue
      const list: any[] = Array.isArray(models) ? models : Object.values(models)
      const m = list.find((x: any) => x?.id === modelID)
      if (m?.limit?.context) return m.limit
    }
    return undefined
  }

  const childrenOf = (sid: string) =>
    [...known.values()].filter((s) => s.parentID === sid)

  const statusOf = (sid: string) => api.state.session.status(sid)?.type ?? "idle"

  const lastTool = (sid: string): string | undefined => {
    const msgs = api.state.session.messages(sid)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const parts = api.state.part(msgs[i].id) as any[]
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (part?.type !== "tool") continue
        const st = part.state?.status
        if (st === "running" || st === "pending") {
          const title = part.state?.title
          return `${part.tool}${title ? ": " + title : ""} (${st})`
        }
        return part.tool
      }
    }
    return undefined
  }

  const statusColor = (theme: any, status: string) =>
    status === "busy" ? theme.warning : status === "retry" ? theme.error : theme.success

  // One usage window (`5h ██░░░░░░  11% ↻14:00`), glued in a gap-0 row so cells stay tight.
  const UsageWindowView = (props: {
    label: string
    labelColor: string
    w?: UsageWindow
    resetText: (ms: number) => string
    dim: boolean
  }) => {
    const w = props.w
    // A window whose reset already passed (since the last write) has an unknown percent.
    if (!w || (w.resetsAt !== 0 && w.resetsAt <= Date.now())) {
      return <text fg={C.dim}>{props.label} —</text>
    }
    const reset = w.resetsAt ? " ↻" + props.resetText(w.resetsAt) : ""
    return (
      <box flexDirection="row" gap={1}>
        <text fg={props.dim ? C.dim : props.labelColor}>{props.label}</text>
        <Bar pct={w.percent} />
        <text fg={props.dim ? C.dim : usageColor(w.percent)}>{Math.round(w.percent) + "%"}</text>
        {reset ? <text fg={C.dim}>{reset}</text> : null}
      </box>
    )
  }

  // ---- status bar on its own line, below the native prompt info line ----
  // The host renders `session_prompt` in replace mode: we re-render the original
  // Prompt (forwarding ref/on_submit so focus and scroll keep working) and put
  // our bar in a separate line underneath it.
  const StatusBar = (sid: string) => {
    const theme = () => api.theme.current
    const { tot, cost, ctx, modelID } = totals(sid)
    const limit = modelLimit(modelID)
    const pct = limit?.context ? ctx / limit.context : 0
    const ctxColor = pct > 0.8 ? C.red : pct > 0.6 ? C.yellow : C.green
    const kids = childrenOf(sid)
    const busy = kids.some((k) => statusOf(k.id) !== "idle")
    const branch = api.state.vcs?.branch
    const u = usage()
    const now = Date.now()
    const stale = !!u && now - u.updatedAt > USAGE_STALE_MS
    // Groups joined by a `│` separator — compact, no `·`, no `ctx` label (proposta B).
    const groups: unknown[] = []
    if (branch) groups.push(<text fg={C.pink}>⎇ {branch}</text>)
    if (modelID) groups.push(<text fg={C.blue}>{shortModel(modelID)}</text>)
    if (limit?.context)
      groups.push(
        <box flexDirection="row" gap={1}>
          <Bar pct={pct * 100} />
          <text fg={ctxColor}>{Math.round(pct * 100) + "%"}</text>
        </box>,
      )
    groups.push(
      u ? (
        <UsageWindowView label="5h" labelColor={C.lav} w={u.fiveHour} resetText={resetHHMM} dim={stale} />
      ) : (
        <text fg={C.dim}>5h —</text>
      ),
    )
    groups.push(
      u ? (
        <UsageWindowView
          label="7d"
          labelColor={C.mauve}
          w={u.sevenDay}
          resetText={(ms) => resetDay(ms, now)}
          dim={stale}
        />
      ) : (
        <text fg={C.dim}>7d —</text>
      ),
    )
    groups.push(
      <box flexDirection="row" gap={1}>
        <text fg={C.teal}>↓{fmtTok(tot.input + tot.cache.read + tot.cache.write)}</text>
        <text fg={C.peach}>↑{fmtTok(tot.output + tot.reasoning)}</text>
        <text fg={C.yellow}>{fmtCost(cost)}</text>
      </box>,
    )
    groups.push(<text fg={busy ? theme().warning : C.dim}>{kids.length} ag</text>)
    const line: unknown[] = []
    groups.forEach((g, i) => {
      if (i > 0) line.push(<Sep />)
      line.push(g)
    })
    return (
      <box flexDirection="row" gap={1} paddingLeft={1}>
        {line}
      </box>
    )
  }

  api.slots.register({
    order: 60,
    slots: {
      session_prompt(_ctx: any, props: any) {
        const Prompt = api.ui.Prompt
        return (
          <box flexDirection="column">
            <Prompt
              sessionID={props.session_id}
              visible={props.visible}
              disabled={props.disabled}
              onSubmit={props.on_submit}
              ref={props.ref}
            />
            {StatusBar(props.session_id)}
          </box>
        )
      },
    },
  })

  // ---- /top modal: per-agent table ----
  const TopView = () => {
    const theme = () => api.theme.current
    const sid = currentSessionID()
    if (!sid) {
      return (
        <box flexDirection="column" gap={1} padding={1}>
          <text fg={C.dim}>Abra uma sessão para ver os agentes.</text>
        </box>
      )
    }
    const root = totals(sid)
    const kids = childrenOf(sid)
    const u = usage()
    const now = Date.now()
    const stale = !!u && now - u.updatedAt > USAGE_STALE_MS
    const line = (s: AnySession) => {
      const st = statusOf(s.id)
      const t = totals(s.id)
      const tool = lastTool(s.id)
      return (
        <box flexDirection="row" gap={1}>
          <text fg={statusColor(theme(), st)}>{st === "idle" ? "○" : "●"}</text>
          <text fg={statusColor(theme(), st)}>{st.padEnd(5)}</text>
          <text fg={theme().text}>{(s.title ?? s.id).slice(0, 40).padEnd(40)}</text>
          <text fg={theme().textMuted}>{(t.modelID ?? "-").padEnd(24)}</text>
          <text fg={C.teal}>
            ↓{fmtTok(t.tot.input + t.tot.cache.read + t.tot.cache.write)}
          </text>
          <text fg={C.peach}>↑{fmtTok(t.tot.output + t.tot.reasoning)}</text>
          <text fg={C.yellow}>{fmtCost(t.cost).padEnd(8)}</text>
          <text fg={theme().textMuted}>{tool ?? ""}</text>
        </box>
      )
    }
    return (
      <box flexDirection="column" gap={1} padding={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            sessão: {known.get(sid)?.title ?? sid} · ctx {fmtTok(root.ctx)}
            {modelLimit(root.modelID) ? "/" + fmtTok(modelLimit(root.modelID)!.context) : ""} ·{" "}
            {fmtCost(root.cost)}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={C.dim}>
            plano {stale ? "(stale) " : ""}·{" "}
          </text>
          <UsageWindowView
            label="5h"
            labelColor={C.lav}
            w={u?.fiveHour}
            resetText={resetHHMM}
            dim={stale}
          />
          <UsageWindowView
            label="7d"
            labelColor={C.mauve}
            w={u?.sevenDay}
            resetText={(ms) => resetDay(ms, now)}
            dim={stale}
          />
        </box>
        <text fg={theme().textMuted}>
          {"● status  agente/sub-agente                          modelo                    tokens      custo    última tool"}
        </text>
        {line({ id: sid, title: "(raiz)" })}
        {kids.map((k) => line(k))}
        {kids.length === 0 ? <text fg={theme().textMuted}>nenhum sub-agente nesta sessão</text> : null}
      </box>
    )
  }

  api.command.register(() => [
    {
      title: "Top de agentes e tokens (agtop)",
      value: "agtop.top",
      slash: { name: "top" },
      onSelect: () => {
        api.ui.dialog.setSize("large")
        api.ui.dialog.replace(() => <TopView />)
      },
    },
  ])
}

export default { id, tui } satisfies { id: string; tui: TuiPlugin }
