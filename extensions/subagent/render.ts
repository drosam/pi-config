/**
 * Custom TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os"
import { Text, Container, Markdown, Spacer } from "@mariozechner/pi-tui"
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent"
import type { RunResult, DisplayItem } from "./runner.js"

function formatElapsedSeconds(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  fg: (color: any, text: string) => string,
): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return fg("muted", toolName)

  const parts = entries.map(([k, v]) => {
    let val = typeof v === "string" ? shortenPath(v) : JSON.stringify(v)
    if (val.length > 80) val = val.slice(0, 77) + "..."
    return entries.length === 1 ? val : `${k}=${val}`
  })
  return fg("muted", `${toolName} ${parts.join(" ")}`)
}

function getElapsed(result: RunResult): string {
  const secs = result.elapsed ?? (Date.now() - result.startedAt) / 1000
  return formatElapsedSeconds(secs)
}

export interface RenderResultOptions {
  expanded: boolean
  isPartial: boolean
}

/**
 * Render collapsed view (both in-progress and completed).
 * Returns a single Text component.
 */
function renderCollapsed(
  result: RunResult,
  displayItems: DisplayItem[],
  isPartial: boolean,
  theme: any,
): Text {
  const fg = theme.fg.bind(theme)
  const isError =
    result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
  const elapsed = getElapsed(result)
  const toolCallCount = displayItems.filter((i) => i.type === "toolCall").length

  const lines: string[] = []

  if (isPartial) {
    // In progress:
    // ↳ Read extensions/question/question-tool.ts · 23.4s
    const lastToolCall = displayItems.toReversed().find((i) => i.type === "toolCall")
    if (lastToolCall && lastToolCall.type === "toolCall") {
      const call = formatToolCall(lastToolCall.name, lastToolCall.args, fg)
      lines.push(`${fg("muted", "↳ ")}${call}`)
    } else {
      lines.push(fg("muted", `↳ (running...)`))
    }
  } else if (isError && result.errorMessage) {
    // Error:
    // └ Error: something went wrong
    lines.push(`${fg("muted", "└ ")}${fg("error", `Error: ${result.errorMessage}`)}`)
  } else {
    // Completed:
    // └ 47 tool calls · 1m 54s
    const summary = toolCallCount > 0 ? `${toolCallCount} tool calls · ${elapsed}` : elapsed
    lines.push(`${fg("muted", "└ ")}${fg("muted", summary)}`)
  }

  lines.push("")
  lines.push(fg("muted", "ctrl+o view subagents"))

  return new Text(lines.join("\n"), 0, 0)
}

/**
 * Render expanded view — full subagent session.
 * Returns a Container with Markdown for text and Text for tool calls.
 */
function renderExpanded(result: RunResult, displayItems: DisplayItem[], theme: any): Container {
  const fg = theme.fg.bind(theme)
  const container = new Container()
  const mdTheme = getMarkdownTheme()

  container.addChild(new Spacer())
  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i]!
    if (item.type === "text") {
      container.addChild(new Markdown(`${item.text}`, 0, 0, mdTheme))
    } else {
      const call = `${fg("toolOutput", "→ ")}${formatToolCall(item.name, item.args, fg)}`
      container.addChild(new Text(`${call}`, 0, 0))
    }
  }

  // Footer: Explore · Claude Haiku 4.5 · 1m 54s
  const agentLabel = result.agent.charAt(0).toUpperCase() + result.agent.slice(1)
  const footerParts: string[] = [fg("text", agentLabel)]
  if (result.model) {
    footerParts.push(fg("muted", result.model))
  }
  footerParts.push(fg("muted", getElapsed(result)))

  container.addChild(new Text(`\n${footerParts.join(fg("muted", " · "))}`, 0, 0))

  return container
}

export function renderResult(
  result: RunResult | undefined,
  displayItems: DisplayItem[],
  options: RenderResultOptions,
  theme: any,
): Text | Container {
  if (!result) {
    return new Text(theme.fg("muted", "(no output)"), 0, 0)
  }

  if (options.expanded) {
    return renderExpanded(result, displayItems, theme)
  }

  return renderCollapsed(result, displayItems, options.isPartial, theme)
}
