import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { describe, expect, test, vi } from "vitest"
import questionExtension from "./index.ts"
import { createQuestionTool } from "./question-tool.ts"

const params = {
  questions: [{ question: "Which option?", header: "Option", options: [{ label: "Yes" }] }],
}

function setup(custom: ReturnType<typeof vi.fn>, hasUI = true) {
  const emit = vi.fn()
  const registerTool = vi.fn()
  questionExtension({ events: { emit }, registerTool } as unknown as ExtensionAPI)
  const tool = registerTool.mock.calls[0]![0] as ReturnType<typeof createQuestionTool>
  const ctx = { hasUI, ui: { custom } } as unknown as Parameters<typeof tool.execute>[4]
  return { emit, execute: () => tool.execute("question-1", params, undefined, undefined, ctx) }
}

describe("question Herdr state", () => {
  test.each([false, true])("reports blocked until prompt resolves (cancelled=%s)", async (cancelled) => {
    const result = { cancelled, answers: cancelled ? [] : [["Yes"]] }
    let resolve!: (value: typeof result) => void
    const prompt = new Promise<typeof result>((done) => { resolve = done })
    const custom = vi.fn(() => prompt)
    const { emit, execute } = setup(custom)

    const pending = execute()
    expect(custom).toHaveBeenCalledOnce()
    expect(emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting for answer" }],
    ])

    resolve(result)
    const output = await pending
    expect(output.details?.cancelled).toBe(cancelled)
    expect(output.details?.answers).toEqual(result.answers)
    expect(emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting for answer" }],
      ["herdr:blocked", { active: false }],
    ])
  })

  test.each([false, true])("clears blocked when UI fails (synchronous=%s)", async (synchronous) => {
    const error = new Error("Prompt failed")
    const custom = vi.fn(() => {
      if (synchronous) throw error
      return Promise.reject(error)
    })
    const { emit, execute } = setup(custom)

    await expect(execute()).rejects.toThrow(error)
    expect(emit.mock.calls).toEqual([
      ["herdr:blocked", { active: true, label: "Waiting for answer" }],
      ["herdr:blocked", { active: false }],
    ])
  })

  test("does not report blocked without interactive UI", async () => {
    const custom = vi.fn()
    const { emit, execute } = setup(custom, false)

    const output = await execute()
    expect(output.details?.cancelled).toBe(true)
    expect(custom).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})
