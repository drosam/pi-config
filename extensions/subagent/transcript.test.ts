import { describe, expect, test, vi } from "vitest"
const files = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn() }))
vi.mock("node:fs/promises", () => ({ stat: files.stat, readFile: files.read, mkdir: vi.fn() }))
import { formatToolCall, formatTranscript, inspectTask } from "./transcript.js"
import type { TaskRecord } from "./types.js"

const task: TaskRecord = {
  id: "task", ownerId: "owner", agent: "explore", agentSource: "user", description: "Inspect", prompt: "work", cwd: "/repo", sessionFile: "/session.jsonl", run: 1, status: "completed", background: true, createdAt: 0,
}

describe("task transcript", () => {
  test("shows only active branch messages, excluding system prompts and abandoned history", async () => {
    files.stat.mockResolvedValue({ size: 1000 })
    files.read.mockResolvedValue([
      { type: "session", id: "session", cwd: "/repo" },
      { type: "message", id: "system", parentId: null, message: { role: "system", content: "private system" } },
      { type: "message", id: "user", parentId: "system", message: { role: "user", content: "question" } },
      { type: "message", id: "old", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] } },
      { type: "message", id: "answer", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "current answer" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n"))
    const text = await inspectTask(task)
    expect(text).toContain("question")
    expect(text).toContain("current answer")
    expect(text).not.toContain("abandoned answer")
    expect(text).not.toContain("private system")
  })

  test("renders tool calls with their results using tool-specific layouts", () => {
    const message = (role: string, content: unknown, extra = {}) => ({ type: "message", message: { role, content, ...extra } })
    const lines = formatTranscript([
      message("user", "look around"),
      message("assistant", [
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "2", name: "read", arguments: { path: "a.ts", offset: 9 } },
        { type: "toolCall", id: "3", name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "same\nold", newText: "same\nnew" }] } },
        { type: "toolCall", id: "4", name: "custom", arguments: { x: 1 } },
      ]),
      message("toolResult", [{ type: "text", text: "one\ntwo" }], { toolCallId: "1", toolName: "bash" }),
      message("toolResult", [{ type: "text", text: "alpha\nbeta" }], { toolCallId: "2", toolName: "read" }),
      message("toolResult", [{ type: "text", text: "ok" }], { toolCallId: "3", toolName: "edit" }),
      message("assistant", [{ type: "text", text: "done" }]),
    ])
    const text = lines.join("\n")
    expect(text).toContain("Prompt\nlook around")
    expect(text).toContain("$ ls\n    one\n    two")
    expect(text).toContain("read a.ts:9\n     9 │ alpha\n    10 │ beta")
    expect(text).toContain("edit a.ts\n    - old\n    + new")
    expect(text).not.toContain("- same")
    expect(text).toContain('custom {"x":1}\n    running...')
    expect(text.endsWith("done")).toBe(true)
  })

  test("bounds tool output until expanded and strips terminal controls", () => {
    const output = { text: Array.from({ length: 30 }, (_, i) => `line ${i}\x1b[31m`).join("\n"), isError: false }
    const collapsed = formatToolCall("bash", { command: "seq" }, output)
    expect(collapsed).toHaveLength(12)
    expect(collapsed.at(-1)).toContain("20 more lines (o expand)")
    expect(collapsed.join("\n")).not.toContain("\x1b")
    expect(formatToolCall("bash", { command: "seq" }, output, { expanded: true })).toHaveLength(31)
  })

  test("bounds transcript loading and reports its path", async () => {
    files.stat.mockResolvedValue({ size: 9 * 1024 * 1024 })
    files.read.mockClear()
    const text = await inspectTask(task)
    expect(text).toContain("exceeds viewer limit")
    expect(text).toContain(task.sessionFile)
    expect(files.read).not.toHaveBeenCalled()
  })
})
