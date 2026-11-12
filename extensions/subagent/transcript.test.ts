import { describe, expect, test, vi } from "vitest"
const files = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn() }))
vi.mock("node:fs/promises", () => ({ stat: files.stat, readFile: files.read, mkdir: vi.fn() }))
import { inspectTask } from "./transcript.js"
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

  test("bounds transcript loading and reports its path", async () => {
    files.stat.mockResolvedValue({ size: 9 * 1024 * 1024 })
    files.read.mockClear()
    const text = await inspectTask(task)
    expect(text).toContain("exceeds viewer limit")
    expect(text).toContain(task.sessionFile)
    expect(files.read).not.toHaveBeenCalled()
  })
})
