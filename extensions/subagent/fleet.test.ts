import { afterEach, describe, expect, test, vi } from "vitest"
import { getKeybindings, visibleWidth } from "@mariozechner/pi-tui"
import { cleanTaskText, framed, openTaskPicker, renderFleetLines } from "./fleet.js"
import type { TaskRecord } from "./types.js"
import { usageLabel } from "./fleet-view.js"

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ownerId: "parent", agent: "explore", agentSource: "user", description: "Find code", prompt: "work", cwd: "/repo", sessionFile: "/tmp/task.jsonl", run: 1, status: "running", background: true, createdAt: 0, startedAt: 0, ...overrides }
}

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text }
const actions = () => ({ inspect: vi.fn().mockResolvedValue("transcript"), resume: vi.fn(), steer: vi.fn(), cancel: vi.fn(), toggle: vi.fn() })

afterEach(() => { vi.useRealTimers() })

describe("fleet widget", () => {
  test("hides an idle fleet and renders a tree without IDs", () => {
    expect(renderFleetLines([])).toEqual([])
    expect(renderFleetLines([task({ status: "completed", finishedAt: 0, notifiedRun: 1 })], { now: 60_000 })).toEqual([])
    const lines = renderFleetLines([task({ lastActivity: "bash sleep 60" })], { now: 12_000, width: 72 })
    expect(lines[0]).toBe("● Agents  1 running")
    expect(lines[1]).toMatch(/^└─ \S explore  Find code · 12s$/)
    expect(lines[2]).toBe("     └ bash sleep 60")
    expect(lines.join("\n")).not.toContain("aaaaaaaa")
  })

  test("collapses queued work, lingers finished rows, and colors states", () => {
    const tones: string[] = []
    const colored = { ...theme, fg: (tone: string, text: string) => { tones.push(tone); return text } }
    const tasks = [
      task({ id: "q1", status: "queued" }), task({ id: "q2", status: "queued" }),
      task({ id: "w", status: "waiting", lastActivity: "permission" }),
      task({ id: "f", status: "failed", finishedAt: 60_000 }),
    ]
    const lines = renderFleetLines(tasks, { now: 65_000, width: 80, theme: colored }).join("\n")
    expect(lines).toContain("1 running · 2 queued · 1 new")
    expect(lines).toContain("needs input: permission")
    expect(lines).toContain("✗ explore")
    expect(lines).toContain("└─ ◦ 2 queued")
    expect(tones).toContain("warning")
    expect(tones).toContain("error")
    expect(renderFleetLines(tasks, { now: 70_000, width: 80 }).join("\n")).not.toContain("✗")
  })

  test("shows worker context size once a turn has finished", () => {
    const usage = { input: 900, output: 300, cacheRead: 11_000, cacheWrite: 0, cost: 0.0123, contextTokens: 12_345, turns: 2 }
    const lines = renderFleetLines([task({ result: { usage } as any })], { now: 5000, width: 80 })
    expect(lines[1]).toContain("Find code · 12k tok · 5s")
    expect(usageLabel(task({ result: { usage } as any }))).toBe("12k ctx · ↑12k ↓300 · $0.012")
    expect(renderFleetLines([task()], { now: 5000, width: 80 })[1]).not.toContain("tok")
  })

  test("keeps the selected row visible when more rows exist than fit", () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task({ id: `t${i}`, description: `worker ${i}`, startedAt: i }))
    const lines = renderFleetLines(tasks, { now: 1000, width: 100, focused: true, selectedId: "t8" }).join("\n")
    expect(lines).toContain("❯")
    expect(lines).toMatch(/❯.*worker 8/)
    expect(lines).not.toContain("worker 0")
    expect(lines).toContain("+3 more")
  })

  test("focused fleet marks the selected row and shows navigation hints", () => {
    const tasks = [task({ id: "a", description: "first" }), task({ id: "b", description: "second", startedAt: 1 })]
    const lines = renderFleetLines(tasks, { now: 1000, width: 100, focused: true, selectedId: "b" })
    expect(lines[0]).toContain("enter open")
    expect(lines.find((line) => line.includes("second"))).toContain("❯")
    expect(lines.find((line) => line.includes("first"))).not.toContain("❯")
  })

  test("sanitizes terminal controls and bounds fleet height and width", () => {
    expect(cleanTaskText("\x1b[31mcat\x1b[0m\n猫\t\x00")).toBe("cat 猫 ")
    const tasks = Array.from({ length: 20 }, (_, i) => task({ description: `worker ${i} ${"猫".repeat(50)}` }))
    for (const width of [1, 12, 24, 48, 80, 120]) {
      const lines = renderFleetLines(tasks, { now: 1000, width })
      expect(lines.length).toBeLessThanOrEqual(14)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(renderFleetLines(tasks, { now: 1000, width: 80 }).join("\n")).toContain("+14 more")
  })

  test("ANSI styling preserves terminal width and follows the supplied theme", () => {
    const colored = { fg: (_tone: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` }
    const tasks = [task({ description: "Inspect 猫" })]
    for (const width of [1, 24, 48, 80]) {
      const lines = renderFleetLines(tasks, { now: 1000, width, theme: colored })
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
    expect(renderFleetLines(tasks, { now: 1000, width: 80, theme: colored }).join("\n")).toContain("\x1b[")
    expect(renderFleetLines(tasks, { now: 1000, width: 80, theme }).join("\n")).not.toContain("\x1b[")
  })

  test("renders a stable compact preview", () => {
    const lines = renderFleetLines([
      task({ description: "Audit payment flow", lastActivity: "read src/pay.ts" }),
      task({ id: "other", agent: "general", description: "Check retry policy", status: "waiting", startedAt: 1 }),
    ], { now: 18_000, width: 64 })
    expect(lines).toEqual([
      "● Agents  2 running",
      "├─ ⠋ explore  Audit payment flow · 18s",
      "│    └ read src/pay.ts",
      "└─ ◆ general  Check retry policy · 17s",
      "     └ needs input",
    ])
  })
})

describe("overlay frame", () => {
  test("draws a titled rounded border with theme text color on the terminal background", () => {
    const themed = { fg: (_tone: string, text: string) => text, getFgAnsi: () => "\x1b[38;5;7m" }
    const lines = framed(themed, 20, "tasks", ["hello \x1b[0mworld"])
    expect(lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual([
      "╭─ tasks ──────────╮",
      "│ hello world      │",
      "╰──────────────────╯",
    ])
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(20)
      expect(line.startsWith("\x1b[38;5;7m\x1b[49m")).toBe(true)
      expect(line).not.toContain("\x1b[4" + "0m")
    }
    expect(lines[1]).toContain("\x1b[0m\x1b[38;5;7m\x1b[49mworld")
    expect(framed(themed, 10, "tasks", ["narrow text"]).map(visibleWidth)).toEqual([10])
  })
})

describe("task browser integration", () => {
  test("RPC fallback retains resume actions without exposing task IDs", async () => {
    const record = task({ status: "completed", finishedAt: 0 })
    const label = "1. Find code (explore, Done, 0s)"
    const select = vi.fn().mockResolvedValueOnce(label).mockResolvedValueOnce("Resume").mockResolvedValueOnce(undefined)
    const ctx = { hasUI: true, mode: "rpc", ui: { select, editor: vi.fn().mockResolvedValue("follow up"), notify: vi.fn() } } as any
    const controls = actions()
    await openTaskPicker(ctx, () => [record], controls)
    expect(controls.resume).toHaveBeenCalledWith(record, "follow up")
    expect(select.mock.calls[1][1]).toEqual(["Inspect transcript", "Resume"])
  })

  test("TUI browser resumes with one shortcut and keeps search state across reopen", async () => {
    const controls = actions()
    const record = task({ status: "completed", finishedAt: 0 })
    const frames: string[] = []
    let opened = 0
    const ctx = {
      hasUI: true, mode: "tui", ui: {
        editor: vi.fn().mockResolvedValue("follow up"), notify: vi.fn(),
        custom: vi.fn(async (factory: any) => {
          let component: any
          const result = new Promise((resolve) => {
            component = factory({ terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() }, theme, getKeybindings(), resolve)
            component.focused = true
            if (opened++ === 0) {
              component.handleInput("F")
              frames.push(component.render(94).join("\n"))
              component.handleInput("\x1br")
            } else {
              frames.push(component.render(94).join("\n"))
              component.handleInput("\x1b")
            }
          })
          try { return await result } finally { component.dispose() }
        }),
      },
    } as any
    await openTaskPicker(ctx, () => [record], controls)
    expect(controls.resume).toHaveBeenCalledWith(record, "follow up")
    expect(ctx.ui.custom).toHaveBeenCalledTimes(2)
    expect(frames.every((frame) => frame.includes("Find code"))).toBe(true)
    expect(frames[1]).not.toContain(record.id)
  })

  test("inspection wraps transcript lines and returns to the same task", async () => {
    const controls = actions()
    controls.inspect.mockResolvedValue("first line\n" + "abcdefghijklmnopqrst".repeat(4))
    const record = task({ status: "completed", finishedAt: 0 })
    const frames: string[][] = []
    let opened = 0
    const ctx = {
      hasUI: true, mode: "tui", ui: {
        custom: async (factory: any) => {
          let component: any
          const result = new Promise((resolve) => {
            component = factory({ terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() }, theme, getKeybindings(), resolve)
            if (opened++ === 0) { component.render(94); component.handleInput("\r") }
            else if (opened === 2) {
              setTimeout(() => {
                frames.push(component.render(20))
                component.handleInput("\x1b[6~")
                component.handleInput("\x1b")
              }, 0)
            } else { component.render(94); component.handleInput("\x1b") }
          })
          try { return await result } finally { component.dispose?.() }
        },
      },
    } as any
    await openTaskPicker(ctx, () => [record], controls)
    expect(controls.inspect).toHaveBeenCalledWith(record, expect.objectContaining({ expanded: false }))
    expect(opened).toBe(3)
    expect(frames[0].filter((line) => /^│ [a-t]{16} │$/.test(line.replace(/\x1b\[[0-9;]*m/g, "")))).toHaveLength(5)
    for (const line of frames[0]) expect(visibleWidth(line)).toBeLessThanOrEqual(20)
  })

  test("aborting the browser closes its modal and releases refresh timers", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const controls = actions()
    const ctx = {
      hasUI: true, mode: "tui", ui: {
        custom: async (factory: any) => {
          let component: any
          const result = new Promise((resolve) => {
            component = factory({ terminal: { columns: 100, rows: 30 }, requestRender: vi.fn() }, theme, getKeybindings(), resolve)
          })
          expect(vi.getTimerCount()).toBe(1)
          controller.abort()
          try { return await result } finally { component.dispose() }
        },
      },
    } as any
    await openTaskPicker(ctx, () => [task()], controls, controller.signal)
    expect(vi.getTimerCount()).toBe(0)
    expect(controls.resume).not.toHaveBeenCalled()
  })
})
