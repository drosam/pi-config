import { readFile, stat } from "node:fs/promises"
import type { TaskRecord } from "./types.js"
import { taskOutput } from "./manager.js"
import { cleanTaskText } from "./fleet.js"

export async function inspectTask(task: TaskRecord): Promise<string> {
  const header = `${task.id}\n${task.agent}: ${task.description}\n${task.status}\nSession: ${task.sessionFile}\n`
  try {
    const info = await stat(task.sessionFile)
    if (info.size > 8 * 1024 * 1024) return `${header}\nTranscript exceeds viewer limit (8 MiB). Open session file directly.\n\n${taskOutput(task)}`
    const text = await readFile(task.sessionFile, "utf8")
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
    const lines: string[] = []
    for (const entry of branch.reverse()) {
      const msg = entry.type === "message" ? entry.message : undefined
      if (!msg || msg.role === "system") continue
      const content = typeof msg.content === "string" ? msg.content : (msg.content ?? []).map((part: any) => {
        if (part.type === "text") return part.text
        if (part.type === "toolCall") return `${part.name} ${JSON.stringify(part.arguments)}`
        return ""
      }).filter(Boolean).join("\n")
      if (content) lines.push(`${msg.role}${msg.toolName ? ` (${msg.toolName})` : ""}:\n${content}`)
    }
    return `${header}\n${lines.join("\n\n") || taskOutput(task)}`
  } catch {
    return `${header}\n${cleanTaskText(task.lastActivity ?? "")}\n\n${taskOutput(task)}`
  }
}
