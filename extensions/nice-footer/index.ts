import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui"

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

export default function minimalFooter(pi: ExtensionAPI) {
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined)
  })

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender())
      const paddingX = 1

      return {
        dispose: unsub,
        invalidate() { },
        render(width: number): string[] {
          const home = process.env.HOME || ""
          const cwd = ctx.sessionManager.getCwd().replace(home, "~")
          const branch = footerData.getGitBranch() || ""

          let totalInput = 0
          let totalOutput = 0
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              totalInput += entry.message.usage.input
              totalOutput += entry.message.usage.output
            }
          }

          let contextPercent = "?"
          let contextWindow = ctx.model?.contextWindow ?? 0
          try {
            const contextUsage = ctx.getContextUsage()
            contextWindow = contextUsage?.contextWindow ?? contextWindow
            contextPercent = contextUsage?.percent != null ? contextUsage.percent.toFixed(1) : "?"
          } catch { }

          const modelInfo = ctx.model
          const provider = modelInfo?.provider ?? "unknown"
          const model = modelInfo?.name ?? modelInfo?.id ?? "unknown"
          const hasThinking = modelInfo?.reasoning
          const level = pi.getThinkingLevel?.() ?? "off"
          const dot = theme.fg("dim", " · ")

          let modelLine = theme.fg("text", model) + dot + theme.fg("dim", provider)
          if (hasThinking && level !== "off") {
            modelLine += dot + theme.fg("accent", level)
          }

          const usageParts = []
          if (totalInput) usageParts.push(`↑${formatTokens(totalInput)}`)
          if (totalOutput) usageParts.push(`↓${formatTokens(totalOutput)}`)
          usageParts.push(`${contextPercent}%/${formatTokens(contextWindow)}`)
          const usage = theme.fg("dim", usageParts.join(" "))
          const pathText = branch ? `${cwd} (${branch})` : cwd
          const path = theme.fg("dim", pathText)
          const sessionName = ctx.sessionManager.getSessionName() ??
            (() => {
              const first = ctx.sessionManager.getEntries().find(
                (e) => e.type === "message" && (e as any).message?.role === "user"
              ) as any
              const text: string = first?.message?.content?.[0]?.text ?? first?.message?.content ?? ""
              return text.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 40) || undefined
            })()
          const sessionLine = theme.fg("dim", sessionName || "")

          const side = " ".repeat(paddingX)
          const inner = Math.max(0, width - paddingX * 2)
          const topPad = " ".repeat(Math.max(1, inner - visibleWidth(path) - visibleWidth(modelLine)))
          const bottomPad = " ".repeat(Math.max(1, inner - visibleWidth(sessionLine) - visibleWidth(usage)))

          return [
            truncateToWidth(side + path + topPad + modelLine + side, width),
            truncateToWidth(side + sessionLine + bottomPad + usage + side, width),
          ]
        },
      }
    })
  })
}
