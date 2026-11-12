import { afterEach, describe, expect, test, vi } from "vitest"
import { getKeybindings, visibleWidth } from "@mariozechner/pi-tui"
import { TaskBrowser, type BrowserState } from "./task-browser.js"
import type { TaskRecord } from "./types.js"

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id, ownerId: "parent", agent: "explore", agentSource: "user", description: `Task ${id}`, prompt: "work", cwd: "/repo", sessionFile: `/tmp/${id}.jsonl`, run: 1, status: "running", background: true, createdAt: 0, startedAt: 0, ...overrides }
}

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text }
function setup(initial = [task("one"), task("two", { status: "completed", finishedAt: 0 })]) {
  let records = initial
  const done = vi.fn()
  const state: BrowserState = { query: "", filter: "all" }
  const refresh = vi.fn()
  const browser = new TaskBrowser(() => records, theme, getKeybindings(), done, refresh, state)
  return { browser, done, state, refresh, change: (next: TaskRecord[]) => { records = next } }
}

afterEach(() => { vi.useRealTimers() })

describe("TaskBrowser", () => {
  test("fits narrow, wide, resized, and short terminals without exposing IDs", () => {
    const records = Array.from({ length: 20 }, (_, i) => task(`private-id-${i}`, { description: `Investigate ${"猫".repeat(40)} ${i}` }))
    const { browser } = setup(records)
    browser.focused = true
    for (const width of [1, 12, 28, 48, 80, 100, 112]) {
      for (const height of [1, 6, 12, 24]) {
        const lines = browser.render(width, height)
        expect(lines.length).toBeLessThanOrEqual(height)
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        expect(lines.join("\n")).not.toContain("private-id-")
      }
    }
    browser.invalidate()
    expect(browser.focused).toBe(true)
  })

  test("keeps preview and action hints visible in ordinary and short terminals", () => {
    const { browser } = setup([task("one", { lastActivity: "Scanning files" })])
    expect(browser.render(80, 16).join("\n")).toContain("Scanning files")
    expect(browser.render(80, 6).at(-1)).toContain("close")
  })

  test("detail-pane clicks do not select hidden rows underneath it", () => {
    const { browser, state, done } = setup()
    browser.render(110, 24)
    expect(browser.handleMouse({ type: "click", button: "left", x: 100, y: 5 } as any)).toBeUndefined()
    expect(state.selectedId).toBe("one")
    expect(done).not.toHaveBeenCalled()
  })

  test("uses native text input for search, including bracketed paste and Unicode", () => {
    const { browser, state, done } = setup([
      task("uuid-one", { description: "Find authentication" }),
      task("uuid-two", { description: "Audit payment flow" }),
    ])
    browser.handleInput("\x1b[200~payment\x1b[201~")
    const lines = browser.render(80).join("\n")
    expect(state.query).toBe("payment")
    expect(lines).toContain("Audit payment flow")
    expect(lines).not.toContain("Find authentication")
    browser.handleInput("\r")
    expect(done).toHaveBeenCalledWith({ action: "inspect", taskId: "uuid-two" })
  })

  test("refresh preserves selected task and handles its completion or disappearance", () => {
    const { browser, state, change } = setup()
    browser.render(80)
    browser.handleInput("\x1b[B")
    expect(state.selectedId).toBe("two")
    change([task("one"), task("two", { status: "failed", finishedAt: 10 })])
    expect(browser.render(80).join("\n")).toContain("Failed")
    expect(state.selectedId).toBe("two")
    change([task("one")])
    browser.render(80)
    expect(state.selectedId).toBe("one")
  })

  test("tab separates active tasks from history and empty search remains safe", () => {
    const { browser, state, done } = setup()
    browser.handleInput("\t")
    expect(state.filter).toBe("active")
    expect(browser.render(80).join("\n")).not.toContain("Task two")
    browser.handleInput("\t")
    expect(state.filter).toBe("history")
    expect(browser.render(80).join("\n")).not.toContain("Task one")
    browser.handleInput("z")
    expect(browser.render(80).join("\n")).toContain("No matching tasks")
    browser.handleInput("\r")
    expect(done).not.toHaveBeenCalled()
  })

  test("plain letters search; shortcuts expose only valid actions", () => {
    const active = setup([task("one")])
    active.browser.render(80)
    active.browser.handleInput("\x1br")
    expect(active.done).not.toHaveBeenCalled()
    active.browser.handleInput("\x1bs")
    expect(active.done).toHaveBeenCalledWith({ action: "steer", taskId: "one" })
    const finished = setup([task("two", { status: "completed", finishedAt: 0 })])
    finished.browser.render(80)
    finished.browser.handleInput("\x1bx")
    expect(finished.done).not.toHaveBeenCalled()
    finished.browser.handleInput("r")
    expect(finished.state.query).toBe("r")
    expect(finished.done).not.toHaveBeenCalled()
  })

  test("queued tasks can cancel but cannot steer", () => {
    const { browser, done } = setup([task("one", { status: "queued" })])
    browser.render(80)
    browser.handleInput("\x1bs")
    expect(done).not.toHaveBeenCalled()
    browser.handleInput("\x1bx")
    expect(done).toHaveBeenCalledWith({ action: "cancel", taskId: "one" })
  })

  test("uses injected navigation bindings and updates semantic theme on invalidation", () => {
    const keys = {
      matches: (data: string, name: string) => data === `custom:${name}`,
      getKeys: (_name: string) => ["custom" as const],
    }
    const color = vi.fn((_tone: string, text: string) => text)
    const state: BrowserState = { query: "", filter: "all" }
    const browser = new TaskBrowser(() => [task("one"), task("two")], { ...theme, fg: color }, keys as any, vi.fn(), vi.fn(), state)
    browser.render(110)
    browser.handleInput("custom:tui.select.down")
    browser.invalidate()
    browser.render(110)
    expect(state.selectedId).toBe("two")
    expect(color.mock.calls.some(([tone]) => tone === "accent")).toBe(true)
  })
})
