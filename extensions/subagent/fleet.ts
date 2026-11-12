import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui"
import { isActiveTask, type TaskRecord } from "./types.js"
import { alignedLine, cleanTaskText, elapsedTask, taskState, usageLabel } from "./fleet-view.js"
import type { TranscriptOptions } from "./transcript.js"
import { TaskBrowser, type BrowserAction, type BrowserState } from "./task-browser.js"

export { cleanTaskText, fleetRows, renderFleetLines } from "./fleet-view.js"

export interface FleetActions {
  inspect(task: TaskRecord, options?: TranscriptOptions): Promise<string>
  resume(task: TaskRecord, prompt: string): Promise<void>
  steer(task: TaskRecord, message: string): Promise<void>
  cancel(task: TaskRecord): Promise<void>
  toggle(): void
}

type UiContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">
type ViewerAction = "steer" | "cancel" | "resume" | undefined

/** Live, auto-following transcript overlay. Returns the follow-up action the user picked. */
async function viewTask(
  ctx: UiContext, taskId: string, getTask: (id: string) => TaskRecord | undefined,
  inspect: FleetActions["inspect"], signal?: AbortSignal,
): Promise<ViewerAction> {
  let columns = () => 100
  return ctx.ui.custom<ViewerAction>((tui, theme, keys, done) => {
    columns = () => Math.max(1, Math.min(120, Math.floor(tui.terminal.columns * 0.94)))
    const content = new Text("loading...", 0, 0)
    let offset = 0
    let follow = true
    let expanded = false
    let loading = false
    let stale = true
    let closed = false
    const finish = (action: ViewerAction) => { if (!closed) { closed = true; done(action) } }
    const close = () => finish(undefined)
    signal?.addEventListener("abort", close, { once: true })
    const refresh = () => {
      const task = getTask(taskId)
      if (!task || loading) return
      loading = true
      stale = false
      void inspect(task, { theme, expanded }).then((text) => {
        if (closed) return
        content.setText(text)
        tui.requestRender()
      }).catch(() => {}).finally(() => { loading = false })
    }
    refresh()
    const timer = setInterval(() => {
      const task = getTask(taskId)
      if (!task) return
      tui.requestRender()
      const settled = !isActiveTask(task) && task.finishedAt !== undefined && Date.now() - task.finishedAt > 2000
      if (!settled || stale) refresh()
    }, 1000)
    const viewport = () => Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 6)
    return {
      render(width) {
        const task = getTask(taskId)
        const inset = width >= 16 ? 2 : 0
        const inner = Math.max(1, width - inset * 2)
        const height = viewport()
        const lines = content.render(inner)
        const maxOffset = Math.max(0, lines.length - height)
        offset = follow ? maxOffset : Math.min(offset, maxOffset)
        const state = task ? taskState(task) : undefined
        const usage = task ? usageLabel(task) : ""
        const header = task
          ? alignedLine(`${theme.bold(cleanTaskText(task.agent))}  ${cleanTaskText(task.description)}`,
            `${usage ? theme.fg("dim", `${usage} · `) : ""}${theme.fg(state!.tone, `${state!.label} · ${elapsedTask(task)}`)}`, inner)
          : theme.fg("dim", "Task no longer available")
        const active = task && isActiveTask(task)
        const actions = [
          active && task.status !== "queued" ? "s steer" : "", active ? "x cancel" : "", task && !active ? "r resume" : "",
          expanded ? "o collapse" : "o expand", follow ? "following" : "e follow", `${keys.getKeys("tui.select.cancel")[0] ?? "esc"} back`,
        ].filter(Boolean).join(" · ")
        const body = [...lines.slice(offset, offset + height)]
        while (body.length < Math.min(height, lines.length)) body.push("")
        const rule = theme.fg("borderMuted", "─".repeat(inner))
        const out = [header, rule, ...body, rule, theme.fg("dim", actions)]
        return ["", ...out, ""].map((line) => {
          const clipped = truncateToWidth(line, inner, "")
          return theme.bg("customMessageBg", " ".repeat(inset) + clipped + " ".repeat(Math.max(0, width - inset - visibleWidth(clipped))))
        })
      },
      handleInput(data) {
        const task = getTask(taskId)
        if (keys.matches(data, "tui.select.cancel")) { close(); return }
        if (task && isActiveTask(task) && task.status !== "queued" && data === "s") { finish("steer"); return }
        if (task && isActiveTask(task) && data === "x") { finish("cancel"); return }
        if (task && !isActiveTask(task) && data === "r") { finish("resume"); return }
        if (data === "o") {
          expanded = !expanded
          stale = true
          refresh()
          tui.requestRender()
          return
        }
        const page = viewport()
        if (keys.matches(data, "tui.select.up")) { follow = false; offset = Math.max(0, offset - 1) }
        else if (keys.matches(data, "tui.select.down")) offset++
        else if (keys.matches(data, "tui.select.pageUp")) { follow = false; offset = Math.max(0, offset - page) }
        else if (keys.matches(data, "tui.select.pageDown")) offset += page
        else if (data === "e" || data === "G") follow = true
        else return
        const total = content.render(Math.max(1, columns() - 4)).length
        if (offset >= Math.max(0, total - page)) follow = true
        tui.requestRender()
      },
      invalidate() { content.invalidate() },
      dispose() { closed = true; clearInterval(timer); signal?.removeEventListener("abort", close) },
    }
  }, {
    overlay: true, overlayOptions: () => ({ width: columns(), maxHeight: "85%", anchor: "center" }),
  })
}

/** Open a task's live transcript and run any steer/cancel/resume chosen from it. */
export async function openTaskViewer(
  ctx: UiContext, task: TaskRecord, getTask: (id: string) => TaskRecord | undefined,
  actions: FleetActions, signal?: AbortSignal,
): Promise<void> {
  if (!ctx.hasUI || signal?.aborted) return
  while (!signal?.aborted) {
    const current = getTask(task.id) ?? task
    if (ctx.mode !== "tui") {
      await actions.inspect(current)
      if (!signal?.aborted) ctx.ui.notify(`Transcript: ${current.sessionFile}`, "info")
      return
    }
    const action = await viewTask(ctx, task.id, getTask, actions.inspect, signal)
    const latest = getTask(task.id) ?? current
    if (!action || signal?.aborted) return
    try {
      if (action === "cancel") {
        if (await ctx.ui.confirm("Cancel task?", cleanTaskText(latest.description), { signal }) && !signal?.aborted) await actions.cancel(latest)
      } else {
        const prompt = await ctx.ui.editor(`${action === "resume" ? "Resume" : "Steer"}: ${cleanTaskText(latest.description)}`)
        if (prompt?.trim() && !signal?.aborted) {
          if (action === "resume") await actions.resume(latest, prompt)
          else await actions.steer(latest, prompt)
        }
      }
    } catch (error) {
      if (!signal?.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
    }
  }
}

async function browse(
  ctx: UiContext, tasks: () => readonly TaskRecord[], state: BrowserState, signal?: AbortSignal,
): Promise<BrowserAction | undefined> {
  let columns = () => 90
  return ctx.ui.custom<BrowserAction | undefined>((tui, theme, keys, done) => {
    columns = () => Math.max(1, Math.min(112, Math.floor(tui.terminal.columns * 0.94)))
    const close = () => done(undefined)
    signal?.addEventListener("abort", close, { once: true })
    const browser = new TaskBrowser(tasks, theme, keys, done, () => tui.requestRender(), state)
    const timer = setInterval(() => tui.requestRender(), 1000)
    return {
      get focused() { return browser.focused },
      set focused(value: boolean) { browser.focused = value },
      render(width) {
        const inset = width >= 16 ? 2 : 0
        const inner = Math.max(1, width - inset * 2)
        const rows = Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 2)
        return ["", ...browser.render(inner, rows), ""].map((line) => {
          const clipped = truncateToWidth(line, inner, "")
          const padded = " ".repeat(inset) + clipped + " ".repeat(Math.max(0, width - inset - visibleWidth(clipped)))
          return theme.bg("customMessageBg", padded)
        })
      },
      handleInput: (data) => browser.handleInput(data),
      handleMouse: (event) => browser.handleMouse({ ...event, x: event.x - (columns() >= 16 ? 2 : 0), y: event.y - 1 }),
      invalidate: () => browser.invalidate(),
      dispose() { clearInterval(timer); signal?.removeEventListener("abort", close) },
    }
  }, {
    overlay: true, overlayOptions: () => ({ width: columns(), maxHeight: "85%", anchor: "center" }),
    blocked: { kind: "question", message: "Choose an agent task" },
  })
}

async function rpcChoice(ctx: UiContext, tasks: readonly TaskRecord[]): Promise<BrowserAction | undefined> {
  const records = [...tasks].reverse()
  const choices = records.map((task, index) => `${index + 1}. ${cleanTaskText(task.description)} (${task.agent}, ${taskState(task).label}, ${elapsedTask(task)})`)
  const selected = await ctx.ui.select("Agents", ["Toggle fleet panel", ...choices])
  if (!selected) return undefined
  if (selected === "Toggle fleet panel") return { action: "toggle" }
  const task = records[choices.indexOf(selected)]
  if (!task) return undefined
  const options = ["Inspect transcript", ...(isActiveTask(task) ? ["Steer", "Cancel task"] : ["Resume"])]
  const action = await ctx.ui.select(cleanTaskText(task.description), options)
  const names = { "Inspect transcript": "inspect", "Steer": "steer", "Cancel task": "cancel", "Resume": "resume" } as const
  return action && action in names ? { action: names[action as keyof typeof names], taskId: task.id } : undefined
}

export async function openTaskPicker(
  ctx: UiContext,
  tasks: () => readonly TaskRecord[],
  actions: FleetActions,
  signal?: AbortSignal,
): Promise<void> {
  if (!ctx.hasUI || signal?.aborted) return
  const state: BrowserState = { query: "", filter: "all" }
  const find = (id: string) => tasks().find((task) => task.id === id)
  while (!signal?.aborted) {
    const choice = ctx.mode === "tui" ? await browse(ctx, tasks, state, signal) : await rpcChoice(ctx, tasks())
    if (!choice || signal?.aborted) return
    if (choice.action === "toggle") { actions.toggle(); return }
    const task = choice.taskId ? find(choice.taskId) : undefined
    if (!task) continue
    try {
      if (choice.action === "inspect") await openTaskViewer(ctx, task, find, actions, signal)
      if (choice.action === "resume" || choice.action === "steer") {
        const label = choice.action === "resume" ? "Resume" : "Steer"
        const prompt = await ctx.ui.editor(`${label}: ${cleanTaskText(task.description)}`)
        if (prompt?.trim() && !signal?.aborted) {
          if (choice.action === "resume") await actions.resume(task, prompt)
          else await actions.steer(task, prompt)
        }
      }
      if (choice.action === "cancel" && await ctx.ui.confirm("Cancel task?", task.description, { signal }) && !signal?.aborted) await actions.cancel(task)
    } catch (error) {
      if (!signal?.aborted) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
    }
  }
}
