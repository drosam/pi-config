import { readFile, stat } from "node:fs/promises"
import * as os from "node:os"
import type { TaskRecord } from "./types.js"
import { taskOutput } from "./manager.js"
import { cleanTaskText, paint, type FleetTheme } from "./fleet-view.js"

export interface TranscriptOptions {
  theme?: FleetTheme
  /** Show full tool output instead of bounded previews. */
  expanded?: boolean
}

const PREVIEW_LINES = 10
const DIFF_LINES = 24

type Part = { type: string; text?: string; id?: string; name?: string; arguments?: unknown }
type ToolResult = { text: string; isError: boolean }

function clean(text: string): string[] {
  return text.replace(/\t/g, "  ").split(/\r?\n/).map(cleanTaskText)
}

function shortPath(value: unknown): string {
  const text = typeof value === "string" ? value : ""
  const home = os.homedir()
  return cleanTaskText(text.startsWith(home) ? `~${text.slice(home.length)}` : text)
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return (content as Part[]).map((part) => part.type === "text" ? part.text ?? "" : part.type === "image" ? "[image]" : "")
    .filter(Boolean).join("\n")
}

function bounded(lines: string[], limit: number, options: TranscriptOptions): string[] {
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  if (options.expanded || lines.length <= limit) return lines
  return [...lines.slice(0, limit), paint(options.theme, "dim", `... ${lines.length - limit} more lines (o expand)`)]
}

function indent(lines: string[], prefix = "    "): string[] {
  return lines.map((line) => prefix + line)
}

function diffLines(oldText: string, newText: string, options: TranscriptOptions): string[] {
  const before = clean(oldText)
  const after = clean(newText)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const removed = before.slice(start, before.length - end).map((line) => paint(options.theme, "error", `- ${line}`))
  const added = after.slice(start, after.length - end).map((line) => paint(options.theme, "success", `+ ${line}`))
  return bounded([...removed, ...added], DIFF_LINES, options)
}

function editDiff(args: Record<string, unknown>, options: TranscriptOptions): string[] {
  const edits = Array.isArray(args.edits) ? args.edits as Record<string, unknown>[]
    : typeof args.oldText === "string" ? [args] : []
  return edits.flatMap((edit, index) => [
    ...(index > 0 ? [paint(options.theme, "borderMuted", "  ...")] : []),
    ...diffLines(String(edit.oldText ?? ""), String(edit.newText ?? ""), options),
  ])
}

function numbered(text: string, first: number, options: TranscriptOptions): string[] {
  const all = bounded(clean(text), Number.MAX_SAFE_INTEGER, options)
  const lines = options.expanded ? all : all.slice(0, PREVIEW_LINES)
  const width = String(first + lines.length).length
  const out = lines.map((line, index) => `${paint(options.theme, "dim", `${String(first + index).padStart(width)} │`)} ${line}`)
  if (lines.length < all.length) out.push(paint(options.theme, "dim", `... ${all.length - lines.length} more lines (o expand)`))
  return out
}

/** Render one tool call and its result with a tool-specific layout. */
export function formatToolCall(name: string, rawArgs: unknown, result: ToolResult | undefined, options: TranscriptOptions = {}): string[] {
  const { theme } = options
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>
  const tool = cleanTaskText(name)
  const title = (label: string, detail = "") => `${paint(theme, "accent", label)}${detail ? ` ${detail}` : ""}`
  const output = result ? clean(result.text) : []
  const failed = result?.isError
  const tone = failed ? "error" : "dim"
  const preview = () => indent(bounded(output, PREVIEW_LINES, options).map((line) => paint(theme, tone, line)))
  const lines: string[] = []
  if (tool === "bash") {
    lines.push(title("$", clean(String(args.command ?? "")).join(" ")))
    lines.push(...preview())
  } else if (tool === "read") {
    const range = typeof args.offset === "number" ? `:${args.offset}${typeof args.limit === "number" ? `-${args.offset + args.limit - 1}` : ""}` : ""
    lines.push(title("read", `${shortPath(args.path)}${range}`))
    if (failed) lines.push(...preview())
    else if (result) lines.push(...indent(numbered(result.text, typeof args.offset === "number" ? args.offset : 1, options)))
  } else if (tool === "edit") {
    lines.push(title("edit", shortPath(args.path)))
    lines.push(...indent(editDiff(args, options)))
    if (failed) lines.push(...preview())
  } else if (tool === "write") {
    const content = typeof args.content === "string" ? args.content : ""
    lines.push(title("write", `${shortPath(args.path)} ${paint(theme, "dim", `(${clean(content).length} lines)`)}`))
    lines.push(...indent(bounded(clean(content), PREVIEW_LINES, options).map((line) => paint(theme, "success", line))))
    if (failed) lines.push(...preview())
  } else if (["grep", "find", "ls"].includes(tool)) {
    const target = [args.pattern, args.path].filter((value) => typeof value === "string").map(shortPath).join(" in ")
    lines.push(title(tool, target))
    lines.push(...preview())
  } else {
    let summary = ""
    try { summary = JSON.stringify(args) } catch { summary = "" }
    if (summary === "{}") summary = ""
    lines.push(title(tool, paint(theme, "dim", cleanTaskText(summary.length > 160 ? `${summary.slice(0, 157)}...` : summary))))
    lines.push(...preview())
  }
  if (!result) lines.push(paint(theme, "dim", "    running..."))
  return lines
}

function activeBranch(text: string): any[] {
  const entries = new Map<string, any>()
  let leaf: string | undefined
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    if (typeof entry.id === "string" && entry.type !== "session") {
      entries.set(entry.id, entry)
      leaf = entry.id
    }
  }
  const branch: any[] = []
  const seen = new Set<string>()
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf)
    const entry = entries.get(leaf)
    if (!entry) break
    branch.push(entry)
    leaf = entry.parentId
  }
  return branch.reverse()
}

export function formatTranscript(entries: readonly any[], options: TranscriptOptions = {}): string[] {
  const { theme } = options
  const messages = entries.map((entry) => entry.type === "message" ? entry.message : undefined).filter(Boolean)
  const results = new Map<string, ToolResult>()
  for (const msg of messages) {
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") results.set(msg.toolCallId, { text: partsText(msg.content), isError: !!msg.isError })
  }
  const shown = new Set<string>()
  const blocks: string[][] = []
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = partsText(msg.content)
      if (text.trim()) blocks.push([paint(theme, "warning", theme ? theme.bold("Prompt") : "Prompt"), ...clean(text)])
    } else if (msg.role === "assistant") {
      const parts: Part[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? []
      for (const part of parts) {
        if (part.type === "text" && part.text?.trim()) blocks.push(clean(part.text))
        else if (part.type === "toolCall" && part.name) {
          if (part.id) shown.add(part.id)
          blocks.push(formatToolCall(part.name, part.arguments, part.id ? results.get(part.id) : undefined, options))
        }
      }
    } else if (msg.role === "toolResult" && !shown.has(msg.toolCallId)) {
      blocks.push(formatToolCall(String(msg.toolName ?? "tool"), {}, { text: partsText(msg.content), isError: !!msg.isError }, options))
    }
  }
  return blocks.flatMap((block, index) => index ? ["", ...block] : block)
}

export async function inspectTask(task: TaskRecord, options: TranscriptOptions = {}): Promise<string> {
  const header = `${task.id}\n${task.agent}: ${task.description}\n${task.status}\nSession: ${task.sessionFile}\n`
  const meta = options.theme ? paint(options.theme, "dim", header) : header
  try {
    const info = await stat(task.sessionFile)
    if (info.size > 8 * 1024 * 1024) return `${meta}\nTranscript exceeds viewer limit (8 MiB). Open session file directly.\n\n${taskOutput(task)}`
    const lines = formatTranscript(activeBranch(await readFile(task.sessionFile, "utf8")), options)
    return `${meta}\n${lines.length ? lines.join("\n") : taskOutput(task)}`
  } catch {
    return `${meta}\n${cleanTaskText(task.lastActivity ?? "")}\n\n${taskOutput(task)}`
  }
}
