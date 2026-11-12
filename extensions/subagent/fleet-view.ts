import { stripVTControlCharacters } from "node:util"
import type { Theme } from "@mariozechner/pi-coding-agent"
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui"
import { isActiveTask, type TaskRecord, type TaskStatus } from "./types.js"

export type FleetTheme = Pick<Theme, "fg" | "bold">
type Tone = "accent" | "success" | "warning" | "error" | "dim" | "muted" | "text" | "borderMuted"

const STATES: Record<TaskStatus, { label: string; tone: Tone; icon: string }> = {
  running: { label: "Working", tone: "accent", icon: "" },
  waiting: { label: "Needs input", tone: "warning", icon: "◆" },
  queued: { label: "Queued", tone: "muted", icon: "◦" },
  completed: { label: "Done", tone: "success", icon: "✓" },
  failed: { label: "Failed", tone: "error", icon: "✗" },
  interrupted: { label: "Interrupted", tone: "warning", icon: "!" },
  cancelled: { label: "Cancelled", tone: "dim", icon: "■" },
}
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
export const FLEET_LINGER_MS = 8000
const MAX_ROWS = 6

export interface FleetRenderOptions {
  now?: number
  width?: number
  theme?: FleetTheme
  focused?: boolean
  selectedId?: string
}

export function cleanTaskText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/[\r\n\t]/g, " ")
}

export function paint(theme: FleetTheme | undefined, tone: Tone, text: string): string {
  return theme ? theme.fg(tone, text) : text
}

export function taskState(task: TaskRecord) { return STATES[task.status] }

export function unreadTask(task: TaskRecord): boolean {
  return task.background && !isActiveTask(task) && task.notifiedRun !== task.run
}

export function elapsedTask(task: TaskRecord, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((task.finishedAt ?? now) - (task.startedAt ?? task.createdAt)) / 1000))
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}

export function alignedLine(left: string, right: string, width: number): string {
  width = Math.max(0, Math.floor(width))
  if (width < 24 || visibleWidth(right) + 8 >= width) return truncateToWidth(left, width, "")
  const leading = truncateToWidth(left, width - visibleWidth(right) - 2, "...")
  return leading + " ".repeat(Math.max(2, width - visibleWidth(leading) - visibleWidth(right))) + right
}

export function orderedTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return [...tasks].sort((a, b) => Number(isActiveTask(b)) - Number(isActiveTask(a))
    || Number(unreadTask(b)) - Number(unreadTask(a))
    || (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
}

/** Navigable fleet rows: started work plus recently finished work, in launch order so rows never jump. */
export function fleetRows(tasks: readonly TaskRecord[], now = Date.now()): TaskRecord[] {
  return tasks.filter((task) => task.status === "running" || task.status === "waiting"
    || (!isActiveTask(task) && task.finishedAt !== undefined && now - task.finishedAt < FLEET_LINGER_MS))
    .sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))
}

function activityText(task: TaskRecord): string | undefined {
  if (task.status === "waiting") return `needs input${task.lastActivity ? `: ${cleanTaskText(task.lastActivity)}` : ""}`
  if (task.status === "running") return cleanTaskText(task.lastActivity || "thinking...")
  return undefined
}

export function renderFleetLines(tasks: readonly TaskRecord[], options: FleetRenderOptions = {}): string[] {
  const { now = Date.now(), theme, focused = false, selectedId } = options
  const width = Math.max(0, Math.floor(options.width ?? 80))
  const rows = fleetRows(tasks, now)
  const queued = tasks.filter((task) => task.status === "queued").length
  if (width < 1 || (!rows.length && !queued)) return []
  const running = tasks.filter((task) => task.status === "running" || task.status === "waiting").length
  const unread = tasks.filter(unreadTask).length
  const stats = [running ? `${running} running` : "", queued ? `${queued} queued` : "", unread ? `${unread} new` : ""]
    .filter(Boolean).join(" · ")
  const title = `${paint(theme, running ? "accent" : "muted", "●")} ${paint(theme, "text", theme ? theme.bold("Agents") : "Agents")}`
  const left = stats ? `${title}  ${paint(theme, "dim", stats)}` : title
  const hint = focused ? paint(theme, "dim", "↑↓ select · enter open · x cancel · esc back") : ""
  const lines = [hint ? alignedLine(left, hint, width) : truncateToWidth(left, width, "")]

  const shown = rows.slice(0, MAX_ROWS)
  const extra = rows.length - shown.length
  const tail = [extra > 0 ? `+${extra} more` : "", queued ? `${queued} queued` : ""].filter(Boolean)
  const spin = SPINNER[Math.floor(now / 100) % SPINNER.length]
  shown.forEach((task, index) => {
    const last = index === shown.length - 1 && !tail.length
    const state = taskState(task)
    const selected = focused && task.id === selectedId
    const icon = paint(theme, state.tone, task.status === "running" ? spin : state.icon)
    const marker = focused ? (selected ? paint(theme, "accent", "❯") : " ") : ""
    const prefix = `${paint(theme, "borderMuted", last ? "└─" : "├─")}${marker} ${icon} `
    const agent = cleanTaskText(task.agent)
    const agentText = theme ? theme.bold(agent) : agent
    const suffix = ` · ${elapsedTask(task, now)}`
    const room = width - visibleWidth(prefix) - visibleWidth(agent) - 2 - visibleWidth(suffix)
    const description = room > 3 ? truncateToWidth(cleanTaskText(task.description), room, "...") : ""
    const tone: Tone = selected || !focused ? "text" : "muted"
    const row = `${prefix}${paint(theme, tone, agentText)}${description ? `  ${paint(theme, selected ? "text" : "muted", description)}` : ""}${paint(theme, "dim", suffix)}`
    lines.push(truncateToWidth(row, width, ""))
    const activity = activityText(task)
    if (activity) {
      const indent = `${paint(theme, "borderMuted", last ? "  " : "│ ")}${focused ? " " : ""}   `
      lines.push(truncateToWidth(`${indent}${paint(theme, "dim", `└ ${activity}`)}`, width, "..."))
    }
  })
  tail.forEach((text, index) => {
    const connector = paint(theme, "borderMuted", index === tail.length - 1 ? "└─" : "├─")
    lines.push(truncateToWidth(`${connector}${focused ? " " : ""} ${paint(theme, "muted", "◦")} ${paint(theme, "dim", text)}`, width, ""))
  })
  return lines
}
