/** @jsxImportSource @opentui/solid */
// opencode-tui-statusbar-plugin v0.1.0
// Installed by install.sh — re-run the installer to update, install.sh --remove to uninstall.
// agtop-style status for the opencode TUI.
// Compact line next to the prompt + `/top` (or palette) modal with per-agent detail.
// Data sources: api.state (messages/tokens/cost/status/vcs/providers) and session events.
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

const id = "agtop.status"

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

function bar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, pct))
  const filled = Math.round(clamped * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
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

  // ---- status bar on its own line, below the native prompt info line ----
  // The host renders `session_prompt` in replace mode: we re-render the original
  // Prompt (forwarding ref/on_submit so focus and scroll keep working) and put
  // our bar in a separate line underneath it.
  const StatusBar = (sid: string) => {
    const theme = () => api.theme.current
    const { tot, cost, ctx, modelID } = totals(sid)
    const limit = modelLimit(modelID)
    const pct = limit?.context ? ctx / limit.context : 0
    const ctxFg = () => (pct > 0.8 ? theme().error : pct > 0.6 ? theme().warning : theme().success)
    const kids = childrenOf(sid)
    const busy = kids.some((k) => statusOf(k.id) !== "idle")
    const branch = api.state.vcs?.branch
    return (
      <box flexDirection="row" gap={1} paddingLeft={1}>
        {branch ? <text fg={theme().textMuted}>⎇ {branch}</text> : null}
        {modelID ? <text fg={theme().text}>{modelID}</text> : null}
        {limit?.context ? (
          <text fg={ctxFg()}>
            ctx {bar(pct)} {Math.round(pct * 100)}% {fmtTok(ctx)}/{fmtTok(limit.context)}
          </text>
        ) : null}
        <text fg={theme().textMuted}>
          ↓{fmtTok(tot.input + tot.cache.read + tot.cache.write)} ↑{fmtTok(tot.output + tot.reasoning)}
        </text>
        <text fg={theme().textMuted}>{fmtCost(cost)}</text>
        <text fg={busy ? theme().warning : theme().textMuted}>{kids.length} ag</text>
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
          <text fg={theme().textMuted}>Abra uma sessão para ver os agentes.</text>
        </box>
      )
    }
    const root = totals(sid)
    const kids = childrenOf(sid)
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
          <text fg={theme().textMuted}>
            ↓{fmtTok(t.tot.input + t.tot.cache.read + t.tot.cache.write)} ↑
            {fmtTok(t.tot.output + t.tot.reasoning)}
          </text>
          <text fg={theme().textMuted}>{fmtCost(t.cost).padEnd(8)}</text>
          <text fg={theme().textMuted}>{tool ?? ""}</text>
        </box>
      )
    }
    return (
      <box flexDirection="column" gap={1} padding={1}>
        <text fg={theme().text}>
          sessão: {known.get(sid)?.title ?? sid} · ctx {fmtTok(root.ctx)}
          {modelLimit(root.modelID) ? "/" + fmtTok(modelLimit(root.modelID)!.context) : ""} ·{" "}
          {fmtCost(root.cost)}
        </text>
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
