import * as path from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }))
import { TaskManager, savedTask, taskOutput } from "./manager.js"
import type { TaskRecord } from "./types.js"
import type { RunResult } from "./runner.js"

const agent = { name: "explore", description: "test", systemPrompt: "", source: "user" as const, filePath: "/tmp/agent.md" }
function result(text = "done", exitCode = 0): RunResult {
  return { agent: "explore", task: "test", startedAt: 0, exitCode, stderr: "", messages: [{ role: "assistant", content: [{ type: "text", text }] }] as RunResult["messages"], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 } }
}

function setup(maxConcurrent = 1) {
  const saved: TaskRecord[] = []
  const runs: { resolve: (result: RunResult) => void; options: any; signal: AbortSignal }[] = []
  const completed = vi.fn()
  const execute = vi.fn(async (_agent, _prompt, _cwd, signal, _progress, _defaults, options) => new Promise<RunResult>((resolve) => {
    const control = { steer: vi.fn().mockResolvedValue(undefined), cancel: vi.fn() }
    options.onReady(control)
    signal.addEventListener("abort", () => resolve({ ...result(), stopReason: "aborted", exitCode: 1 }))
    runs.push({ resolve, options, signal })
  }))
  const manager = new TaskManager({ ownerId: "owner", cwd: "/repo", sessionDir: "/sessions/owner", save: (task) => saved.push(structuredClone(task)), changed: vi.fn(), completed, execute, maxConcurrent })
  const start = (background = true, resume?: string) => manager.start(agent, "work", "test task", background, {}, {}, undefined, resume)
  return { manager, start, saved, runs, completed, execute }
}

beforeEach(() => { vi.clearAllMocks() })

describe("TaskManager", () => {
  test("queues excess work, starts next only after exit and supports queued cancellation", async () => {
    const { manager, start, runs } = setup()
    const first = start()
    const second = start()
    const third = start()
    expect(second.task.status).toBe("queued")
    await manager.cancel(third.task.id)
    expect(third.task.status).toBe("cancelled")
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].resolve(result())
    await first.done
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(second.task.status).toBe("running")
    runs[1].resolve(result("second"))
    await second.done
    expect(manager.list().map((t) => t.status)).toEqual(["completed", "completed", "cancelled"])
  })

  test("resumes same saved session exactly once and prevents concurrent continuation", async () => {
    const { manager, start, runs } = setup()
    const first = start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(() => start(true, first.task.id)).toThrow("already active")
    runs[0].resolve(result())
    await first.done
    const second = start(true, first.task.id)
    expect(second.task.run).toBe(2)
    expect(second.task.sessionFile).toBe(first.task.sessionFile)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1].options.resume).toBe(true)
    await manager.cancel(second.task.id)
    expect(second.task.status).toBe("cancelled")
  })

  test("marks recovered running work interrupted without auto-restarting, isolates ownership", async () => {
    const { manager, start, runs, saved, execute } = setup()
    const first = start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const running = saved.at(-1)!
    await manager.shutdown()
    const restored = setup()
    restored.manager.restore([
      running,
      { ...running, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ownerId: "another-parent" },
      { ...running, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", sessionFile: "/other/task.jsonl" },
    ])
    expect(restored.manager.list()).toHaveLength(1)
    expect(restored.manager.get(first.task.id).status).toBe("interrupted")
    expect(restored.execute).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test("completion remains pending until consumed; resume has a separate delivery", async () => {
    const { manager, start, runs, completed } = setup()
    const first = start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].resolve(result())
    await first.done
    expect(completed).toHaveBeenCalledTimes(1)
    expect(manager.pendingCompletions()).toHaveLength(1)
    manager.consume(first.task.id)
    expect(manager.pendingCompletions()).toHaveLength(0)
    const second = start(true, first.task.id)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    runs[1].resolve(result("continued"))
    await second.done
    expect(manager.pendingCompletions()[0].run).toBe(2)
  })

  test("shutdown aborts owned workers and never announces their completion", async () => {
    const { manager, start, runs, completed } = setup()
    const first = start()
    const second = start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await manager.shutdown()
    expect(runs[0].signal.aborted).toBe(true)
    expect((await first.done).status).toBe("interrupted")
    expect((await second.done).status).toBe("interrupted")
    expect(completed).not.toHaveBeenCalled()
    expect(() => start()).toThrow("stopped")
  })

  test("successful answers take precedence over worker stderr, including archived results", async () => {
    const { manager, start, runs } = setup()
    const task = start(false)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].resolve({ ...result("Supported controls: list, status, steer, cancel, resume."), stderr: "[LSP ruby] Server exited with code 10" })
    const completed = await task.done
    expect(taskOutput(completed)).toBe("Supported controls: list, status, steer, cancel, resume.")
    expect(taskOutput(manager.get(completed.id))).toBe("Supported controls: list, status, steer, cancel, resume.")
    expect(manager.get(completed.id).result?.stderr).toContain("[LSP ruby]")
  })

  test("output retains explicit errors, stderr fallback, and startup diagnostics", () => {
    const base = { lastActivity: "startup failed", result: { ...result(""), stderr: "worker diagnostic" } } as TaskRecord
    expect(taskOutput(base)).toBe("worker diagnostic")
    expect(taskOutput({ ...base, result: { ...base.result!, errorMessage: "provider failed" } })).toBe("provider failed")
    expect(taskOutput({ ...base, result: undefined })).toBe("startup failed")
  })

  test("persisted result metadata is bounded but retains transcript location", async () => {
    const { start, runs } = setup()
    const task = start(false)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].resolve(result("x".repeat(100_000)))
    const completed = await task.done
    const saved = savedTask(completed)
    expect(JSON.stringify(saved).length).toBeLessThan(32_000)
    expect(saved.sessionFile).toBe(path.join("/sessions/owner", `${completed.id}.jsonl`))
  })
})
