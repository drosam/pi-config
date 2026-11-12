import { afterEach, describe, expect, test, vi } from "vitest"
import lifetime from "./lifetime.js"

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("worker lifetime", () => {
  test("does nothing outside a managed worker", () => {
    vi.stubEnv("PI_TASK_PARENT_PID", "")
    const on = vi.fn()
    lifetime({ on } as any)
    expect(on).not.toHaveBeenCalled()
  })

  test("aborts when the owner disappears and retains a bounded exit deadline", async () => {
    vi.useFakeTimers()
    vi.stubEnv("PI_TASK_PARENT_PID", String(process.ppid + 1000))
    const hooks: Record<string, any> = {}
    lifetime({ on: (event: string, callback: any) => { hooks[event] = callback } } as any)
    const ctx = { abort: vi.fn(), shutdown: vi.fn() }
    hooks.session_start({}, ctx)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.abort).toHaveBeenCalledTimes(1)
    expect(ctx.shutdown).toHaveBeenCalledTimes(1)
    hooks.session_shutdown()
    expect(vi.getTimerCount()).toBe(1)
  })

  test("keeps live workers and clears its timer during normal shutdown", async () => {
    vi.useFakeTimers()
    vi.stubEnv("PI_TASK_PARENT_PID", String(process.ppid))
    const hooks: Record<string, any> = {}
    lifetime({ on: (event: string, callback: any) => { hooks[event] = callback } } as any)
    const ctx = { abort: vi.fn(), shutdown: vi.fn() }
    hooks.session_start({}, ctx)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctx.abort).not.toHaveBeenCalled()
    hooks.session_shutdown()
    expect(vi.getTimerCount()).toBe(0)
  })
})
