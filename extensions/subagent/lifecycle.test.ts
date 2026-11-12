import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const run = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("./agents.js", () => ({
  discoverAgents: () => [{ name: "explore", description: "test", systemPrompt: "", source: "user", filePath: "/tmp/agent.md" }],
}))
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn().mockResolvedValue(undefined), stat: vi.fn(), readFile: vi.fn() }))
vi.mock("./runner.js", async (original) => ({ ...await original(), runAgent: run.execute }))
import extension from "./index.js"

let hooks: Record<string, any>
let tools: Record<string, any>
let ctx: any
let pi: any
let branch: any[]
let completions: any[]
let runs: { finish: (text?: string) => void; options: any }[]

beforeEach(() => {
  hooks = {}; tools = {}; branch = []; completions = []; runs = []
  run.execute.mockReset().mockImplementation(async (_agent, task, _cwd, signal, _progress, _defaults, options) => new Promise((resolve) => {
    const finish = (text = "result") => resolve({
      agent: "explore", task, startedAt: Date.now(), exitCode: signal.aborted ? 1 : 0,
      stopReason: signal.aborted ? "aborted" : "stop", stderr: "",
      messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    })
    options.onReady({ steer: vi.fn(), cancel: vi.fn() })
    signal.addEventListener("abort", () => finish())
    runs.push({ finish, options })
  }))
  ctx = {
    cwd: "/repo", hasUI: false, mode: "json", isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "parent", getBranch: () => branch },
    ui: { setWidget: vi.fn(), notify: vi.fn() },
  }
  pi = {
    on: (name: string, callback: any) => { hooks[name] = callback },
    registerTool: (tool: any) => { tools[tool.name] = tool },
    registerCommand: vi.fn(), getThinkingLevel: () => "off",
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage: vi.fn((message) => {
      completions.push(message)
      branch.push({ type: "custom_message", ...message })
      hooks.message_end?.({ message: { role: "custom", ...message } }, ctx)
    }),
  }
  extension(pi)
  hooks.session_start({}, ctx)
})

afterEach(async () => { await hooks.session_shutdown({}, ctx) })

const call = (name: string, params: any) => tools[name].execute("tool-id", params, new AbortController().signal, undefined, ctx)
const start = () => call("task", { description: "research task", prompt: "work", subagent_type: "explore", background: true })

describe("task extension integration", () => {
  test("background completion is delivered once with identity and resumable history", async () => {
    const result = await start()
    const id = result.details.taskId
    expect(result.content[0].text).toContain("background")
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0].options.projectTrusted).toBe(false)
    expect(runs[0].options.sessionFile).toContain(id)
    runs[0].finish("found code")
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    expect(completions[0].content).toContain("found code")
    expect(pi.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true })
    await call("task", { description: "follow-up", prompt: "why?", resume: id, background: true })
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1].options.resume).toBe(true)
    expect(runs[1].options.sessionFile).toBe(runs[0].options.sessionFile)
    runs[1].finish("because")
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    expect(completions[1].content).toContain("run 2")
  })

  test("retrieving a result suppresses pending duplicate notification", async () => {
    const result = await start()
    const id = result.details.taskId
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].finish("available now")
    await vi.waitFor(async () => {
      const status = await call("task_control", { action: "status", id })
      expect(status.content[0].text).toContain("available now")
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(completions).toHaveLength(0)
  })

  test("reload recovers owned tasks, but does not revive running subprocesses", async () => {
    const result = await start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await hooks.session_shutdown({}, ctx)
    const spawnCount = runs.length
    extension(pi)
    hooks.session_start({}, ctx)
    const status = await call("task_control", { action: "status", id: result.details.taskId })
    expect(status.content[0].text).toContain("interrupted")
    expect(runs).toHaveLength(spawnCount)
  })

  test("an unacknowledged queued completion is retried after reload", async () => {
    pi.sendMessage.mockImplementation((message: any) => { completions.push(message) })
    const result = await start()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    runs[0].finish("not delivered yet")
    await vi.waitFor(() => expect(completions).toHaveLength(1))
    await hooks.session_shutdown({}, ctx)
    extension(pi)
    hooks.session_start({}, ctx)
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    expect(completions[1].content).toContain(result.details.taskId)
  })

  test("TUI fleet uses a width-aware component factory instead of debug text", async () => {
    ctx.hasUI = true
    ctx.mode = "tui"
    const result = await start()
    await vi.waitFor(() => expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => typeof call[1] === "function")).toBe(true))
    const [, widget, options] = ctx.ui.setWidget.mock.calls.findLast((call: any[]) => typeof call[1] === "function")
    expect(options).toEqual({ placement: "belowEditor" })
    const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text }
    const component = widget({ requestRender: vi.fn() }, theme)
    const text = component.render(48).join("\n")
    component.dispose()
    expect(text).toContain("research task")
    expect(text).not.toContain(result.details.taskId)
    const command = pi.registerCommand.mock.calls.find(([name]: [string]) => name === "tasks")[1]
    await command.handler("toggle", ctx)
    expect(ctx.ui.setWidget.mock.calls.at(-1)[1]).toBeUndefined()
  })

  test("fleet navigation moves once per key on terminals that report key releases", async () => {
    await hooks.session_shutdown({}, ctx)
    let input: (data: string) => any = () => undefined
    ctx.hasUI = true
    ctx.mode = "tui"
    ctx.ui.onTerminalInput = (handler: any) => { input = handler; return () => {} }
    extension(pi)
    hooks.session_start({}, ctx)
    await start()
    await start()
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    await vi.waitFor(() => expect(ctx.ui.setWidget.mock.calls.some((call: any[]) => typeof call[1] === "function")).toBe(true))
    const widget = ctx.ui.setWidget.mock.calls.findLast((call: any[]) => typeof call[1] === "function")[1]
    const tui = { requestRender: vi.fn(), isOverlayFocused: () => false, getFocusedComponent: () => ({ getText: () => "" }) }
    const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text }
    const component = widget(tui, theme)
    const selected = () => component.render(100).findIndex((line: string) => line.includes("❯"))
    const press = (key: string) => { input(`\x1b[${key}`); input(`\x1b[1;1:3${key}`) }
    press("B")
    const first = selected()
    expect(first).toBeGreaterThan(0)
    press("B")
    expect(selected()).toBeGreaterThan(first)
    press("A")
    expect(selected()).toBe(first)
    press("A")
    expect(selected()).toBe(-1)
    component.dispose()
  })

  test("foreign parent sessions cannot retrieve task IDs", async () => {
    const result = await start()
    await hooks.session_shutdown({}, ctx)
    ctx.sessionManager.getSessionId = () => "different-parent"
    extension(pi)
    hooks.session_start({}, ctx)
    const status = await call("task_control", { action: "status", id: result.details.taskId })
    expect(status.isError).toBe(true)
    expect(status.content[0].text).toContain("Unknown task")
  })
})
