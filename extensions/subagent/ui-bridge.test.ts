import { describe, expect, test, vi } from "vitest"
import { createTaskUiBridge, TaskDialogQueue } from "./ui-bridge.js"

const request = { type: "extension_ui_request" as const, id: "approval", method: "confirm", title: "Allow?", message: "command" }

describe("task permission UI", () => {
  test("headless or aborted prompts fail closed", async () => {
    const confirm = vi.fn()
    const ctx = { hasUI: false, ui: { confirm } } as any
    expect(await createTaskUiBridge(ctx, "explore")(request, new AbortController().signal)).toEqual({ cancelled: true })
    ctx.hasUI = true
    expect(await createTaskUiBridge(ctx, "explore")(request, AbortSignal.abort())).toEqual({ cancelled: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  test("identifies worker in approval prompt and never invents approval", async () => {
    const confirm = vi.fn().mockResolvedValue(false)
    const ctx = { hasUI: true, ui: { confirm } } as any
    expect(await createTaskUiBridge(ctx, "explore")(request, new AbortController().signal)).toEqual({ confirmed: false })
    expect(confirm).toHaveBeenCalledWith("[explore] Allow?", "command", expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  test("serializes worker dialogs and skips cancelled queued prompts", async () => {
    const queue = new TaskDialogQueue()
    let finish!: (value: boolean) => void
    const first = queue.run(new AbortController().signal, () => new Promise<boolean>((resolve) => { finish = resolve }), false)
    const controller = new AbortController()
    const action = vi.fn().mockResolvedValue(true)
    const second = queue.run(controller.signal, action, false)
    await Promise.resolve()
    controller.abort()
    finish(true)
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })
})
