/** Local task delegation: subprocess sessions, background work and a compact fleet. */
import { createHash } from "node:crypto"
import * as path from "node:path"
import { getAgentDir, truncateHead, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Text, isKeyRelease, matchesKey, type TUI } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"
import { discoverAgents } from "./agents.js"
import { type CallerDefaults, type RunResult, getDisplayItems } from "./runner.js"
import { renderResult } from "./render.js"
import { TaskManager, taskOutput } from "./manager.js"
import { fleetRows, openTaskPicker, openTaskViewer, renderFleetLines, type FleetActions } from "./fleet.js"
import { inspectTask } from "./transcript.js"
import { createTaskUiBridge, TaskDialogQueue } from "./ui-bridge.js"
import { isActiveTask, type TaskRecord } from "./types.js"

const STATE_TYPE = "local-task-state:v1"
const COMPLETION_TYPE = "local-task-completion:v1"
const FLEET_WIDGET = "local-task-fleet"

const SubagentParams = Type.Object({
  description: Type.String({ description: "A short (3-5 words) description of the task" }),
  prompt: Type.String({ description: "The task or continuation for the agent to perform" }),
  subagent_type: Type.Optional(Type.String({ description: "Agent type; optional when resuming" })),
  command: Type.Optional(Type.String({ description: "The command that triggered this task" })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately and notify on completion. Default false." })),
  resume: Type.Optional(Type.String({ description: "Task ID to continue with its saved conversation" })),
})

export function buildTaskDescription(agents: { name: string; description?: string }[]): string {
  return [
    "Launch a new agent to handle tasks autonomously in an isolated context window.", "",
    "Available agents:",
    ...agents.map((a) => `- ${a.name}: ${a.description ?? "No description."}`), "",
    "When to use the Task tool:",
    "- Complex multi-step tasks that benefit from focused context",
    "- Codebase exploration and research across many files",
    "- Parallel independent work units (launch multiple agents concurrently in a single message)",
    "- Code changes that can be done independently from the main conversation", "",
    "When NOT to use the Task tool:",
    "- Reading a specific file — use Read directly",
    "- Searching for a specific symbol or pattern in 2-3 files — use Grep or Read directly",
    "- Finding files by name — use Glob directly",
    "- Simple single-step tasks you can do faster yourself", "",
    "Usage notes:",
    "1. Launch multiple agents concurrently whenever possible; use a single message with multiple tool calls",
    "2. New tasks start with fresh context. Supply a self-contained task description. Use resume for follow-up work.",
    "3. Clearly tell the agent whether you expect it to write code or just research, and how to verify its work.",
    "4. The agent's result is not visible to the user. Summarize it for them.",
    "5. The agent's outputs should generally be trusted.",
    "6. Foreground is default. Set background=true only when the parent can usefully continue working.",
    "7. Background completion is delivered automatically. Use task_control for status, results, steering, or cancellation.",
    "8. Tasks share the checkout. Do not delegate concurrent edits to the same files.",
  ].join("\n")
}

function configuredModel(model: unknown): string {
  if (typeof model === "string") return model
  if (!model || typeof model !== "object") return ""
  return Object.entries(model).filter(([, value]) => typeof value === "string")
    .map(([provider, value]) => `${provider}/${value}`).join(", ")
}

function boundedOutput(task: TaskRecord, maxBytes = 30_000): string {
  const output = truncateHead(taskOutput(task), { maxBytes, maxLines: 1000 })
  return output.truncated ? `${output.content}\n[Truncated. Full session: ${task.sessionFile}]` : output.content
}

export default function(pi: ExtensionAPI) {
  const parentAgent = process.env.PI_SUBAGENT_NAME
  const agents = (cwd: string) => discoverAgents(cwd).filter((agent) => agent.name !== parentAgent)
  let manager: TaskManager | undefined
  let context: ExtensionContext | undefined
  let ownerId: string | undefined
  let live = false
  let saveEnabled = true
  let fleetVisible = true
  let fleetFocused = false
  let selectedId: string | undefined
  let widgetMounted = false
  let viewerOpen = false
  let promptDepth = 0
  let tuiRef: TUI | undefined
  let unsubscribeInput: (() => void) | undefined
  let dirty = true
  let fleetAbort = new AbortController()
  let tick: ReturnType<typeof setInterval> | undefined
  let delivery: ReturnType<typeof setTimeout> | undefined
  const dialogs = new TaskDialogQueue()
  const inFlight = new Set<string>()
  const rowTimers = new Set<ReturnType<typeof setInterval>>()

  const updateFleet = () => {
    if (!live || !context?.hasUI || !manager) return
    const lines = fleetVisible ? renderFleetLines(manager.list()) : []
    if (!lines.length) {
      fleetFocused = false
      if (widgetMounted || dirty) context.ui.setWidget(FLEET_WIDGET, undefined)
      widgetMounted = false
      dirty = false
      return
    }
    if (context.mode !== "tui") {
      if (dirty) context.ui.setWidget(FLEET_WIDGET, lines)
      dirty = false
      return
    }
    dirty = false
    if (widgetMounted) return
    widgetMounted = true
    // The component reads live task state each frame; mounting once avoids flicker.
    context.ui.setWidget(FLEET_WIDGET, (tui, theme) => {
      tuiRef = tui
      const timer = setInterval(() => tui.requestRender(), 120)
      timer.unref?.()
      return {
        render: (width: number) => manager ? renderFleetLines(manager.list(), { width, theme, focused: fleetFocused, selectedId }) : [],
        invalidate() {},
        dispose() {
          clearInterval(timer)
          if (tuiRef === tui) tuiRef = undefined
        },
      }
    }, { placement: "belowEditor" })
  }

  const fleetActions = (ctx: ExtensionContext, tasks: TaskManager): FleetActions => ({
    inspect: async (task, options) => {
      const text = await inspectTask(tasks.get(task.id), options)
      if (!isActiveTask(tasks.get(task.id))) tasks.consume(task.id)
      return text
    },
    resume: async (task, prompt) => { launch(ctx, { prompt, description: task.description, resume: task.id, background: true }) },
    steer: (task, message) => tasks.steer(task.id, message),
    cancel: (task) => tasks.cancel(task.id),
    toggle: () => { fleetVisible = !fleetVisible; dirty = true; updateFleet() },
  })

  const openFleetTask = async (taskId: string) => {
    const ctx = context
    const tasks = manager
    const task = tasks?.list().find((item) => item.id === taskId)
    if (!ctx || !tasks || !task) return
    viewerOpen = true
    try {
      await openTaskViewer(ctx, task, (id) => tasks.list().find((item) => item.id === id), fleetActions(ctx, tasks), fleetAbort.signal)
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error")
    } finally {
      viewerOpen = false
    }
  }

  /** Arrow-key navigation into the fleet from an empty prompt; never steals keys from dialogs or overlays. */
  const handleFleetKey = (data: string): { consume: true } | undefined => {
    if (!live || !manager || !fleetVisible || viewerOpen || !tuiRef) return undefined
    // Kitty-protocol terminals also report releases; acting on them would move twice per key.
    if (isKeyRelease(data)) return fleetFocused ? { consume: true } : undefined
    const rows = fleetRows(manager.list())
    if (!fleetFocused) {
      if (!matchesKey(data, "down") || !rows.length || promptDepth > 0 || tuiRef.isOverlayFocused()) return undefined
      const editor = tuiRef.getFocusedComponent() as { getText?: () => string } | null
      if (typeof editor?.getText !== "function" || editor.getText() !== "") return undefined
      fleetFocused = true
      selectedId = rows[0]!.id
      tuiRef.requestRender()
      return { consume: true }
    }
    if (!rows.length) { fleetFocused = false; return undefined }
    let index = rows.findIndex((task) => task.id === selectedId)
    if (index < 0) { index = 0; selectedId = rows[0]!.id }
    if (matchesKey(data, "down")) selectedId = rows[Math.min(rows.length - 1, index + 1)]!.id
    else if (matchesKey(data, "up")) { if (index === 0) fleetFocused = false; else selectedId = rows[index - 1]!.id }
    else if (matchesKey(data, "escape")) fleetFocused = false
    else if (matchesKey(data, "enter")) { fleetFocused = false; void openFleetTask(rows[index]!.id) }
    else if (data === "x") {
      const task = rows[index]!
      if (isActiveTask(task)) void context?.ui.confirm("Cancel task?", task.description).then((ok) => ok ? manager?.cancel(task.id) : undefined).catch(() => {})
    } else {
      fleetFocused = false
      tuiRef.requestRender()
      return undefined
    }
    tuiRef.requestRender()
    return { consume: true }
  }

  const deliver = () => {
    delivery = undefined
    if (!live || !manager) return
    const pending = manager.pendingCompletions().filter((task) => !inFlight.has(`${task.id}:${task.run}`)).slice(0, 4)
    if (!pending.length) return
    for (const task of pending) inFlight.add(`${task.id}:${task.run}`)
    try {
      pi.sendMessage({
        customType: COMPLETION_TYPE,
        content: pending.map((task) => `Task ${task.id} (${task.agent}, run ${task.run}) ${task.status}:\n${boundedOutput(task, 8000)}`).join("\n\n"),
        display: true,
        details: { tasks: pending.map(({ id, run }) => ({ id, run })) },
      }, { deliverAs: "followUp", triggerTurn: true })
      if (manager.pendingCompletions().some((task) => !inFlight.has(`${task.id}:${task.run}`))) scheduleDelivery()
    } catch (error) {
      for (const task of pending) inFlight.delete(`${task.id}:${task.run}`)
      context?.ui.notify(`Task results remain available via task_control: ${String(error)}`, "warning")
    }
  }

  const scheduleDelivery = () => {
    if (live && !delivery) delivery = setTimeout(deliver, 150)
  }

  function initialize(ctx: ExtensionContext): TaskManager {
    fleetAbort.abort()
    fleetAbort = new AbortController()
    context = ctx
    widgetMounted = false
    fleetFocused = false
    unsubscribeInput?.()
    unsubscribeInput = ctx.mode === "tui" && ctx.hasUI ? ctx.ui.onTerminalInput(handleFleetKey) : undefined
    ownerId = ctx.sessionManager.getSessionId()
    const hash = createHash("sha256").update(ownerId).digest("hex").slice(0, 24)
    const sessionDir = path.join(getAgentDir(), "task-sessions", hash)
    inFlight.clear()
    manager = new TaskManager({
      ownerId, cwd: ctx.cwd, sessionDir,
      save: (task) => { if (saveEnabled) pi.appendEntry(STATE_TYPE, task) },
      changed: () => {
        dirty = true
        queueMicrotask(updateFleet)
      },
      completed: scheduleDelivery,
    })
    const branch = ctx.sessionManager.getBranch()
    manager.restore(branch.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE)
      .map((entry) => (entry as { data: unknown }).data))
    // Delivery messages survive a crash between sending a result and saving its consumed flag.
    for (const entry of branch) {
      if (entry.type !== "custom_message" || entry.customType !== COMPLETION_TYPE) continue
      const completed = (entry.details as { tasks?: { id: string; run: number }[] } | undefined)?.tasks ?? []
      for (const item of completed) {
        const task = manager.list().find((task) => task.id === item.id && task.run === item.run)
        if (task && task.notifiedRun !== task.run) manager.consume(task.id)
      }
    }
    live = true
    dirty = true
    if (tick) clearInterval(tick)
    tick = setInterval(updateFleet, 1000)
    tick.unref?.()
    updateFleet()
    scheduleDelivery()
    return manager
  }

  const current = (ctx: ExtensionContext) => {
    if (!manager || ownerId !== ctx.sessionManager.getSessionId()) return initialize(ctx)
    context = ctx
    return manager
  }

  const defaults = (ctx: ExtensionContext): CallerDefaults => ({
    provider: ctx.model?.provider,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking: pi.getThinkingLevel(),
  })

  function launch(
    ctx: ExtensionContext,
    params: { prompt: string; description: string; subagent_type?: string; background?: boolean; resume?: string },
    progress?: (result: RunResult) => void,
  ) {
    const tasks = current(ctx)
    const previous = params.resume ? tasks.get(params.resume) : undefined
    const type = params.subagent_type ?? previous?.agent
    const agent = agents(ctx.cwd).find((agent) => agent.name === type)
    if (!agent) throw new Error(`Unknown agent: "${type ?? ""}". Available: ${agents(ctx.cwd).map((a) => a.name).join(", ")}`)
    if (!params.prompt.trim()) throw new Error("Task prompt must not be empty")
    const bridge = createTaskUiBridge(ctx, agent.name)
    return tasks.start(agent, params.prompt, params.description, params.background ?? false, defaults(ctx), {
      projectTrusted: ctx.isProjectTrusted(),
      onUiRequest: (request, signal) => {
        const timeout = request.timeout && request.timeout > 0 ? AbortSignal.timeout(request.timeout) : undefined
        const combined = timeout ? AbortSignal.any([signal, timeout]) : signal
        return dialogs.run(combined, () => bridge({ ...request, timeout: undefined }, combined), { cancelled: true })
      },
    }, progress, params.resume)
  }

  pi.on("session_start", (_event, ctx) => { initialize(ctx) })
  pi.on("ui_prompt_start", () => { promptDepth++ })
  pi.on("ui_prompt_end", () => { promptDepth = Math.max(0, promptDepth - 1) })
  pi.on("message_end", (event) => {
    const msg = event.message as { role: string; customType?: string; details?: { tasks?: { id: string; run: number }[] } }
    if (!live || !manager || msg.role !== "custom" || msg.customType !== COMPLETION_TYPE) return
    for (const item of msg.details?.tasks ?? []) {
      inFlight.delete(`${item.id}:${item.run}`)
      const task = manager.list().find((task) => task.id === item.id && task.run === item.run)
      if (task && task.notifiedRun !== task.run) manager.consume(task.id)
    }
  })
  pi.on("session_shutdown", async () => {
    live = false
    fleetAbort.abort()
    for (const timer of rowTimers) clearInterval(timer)
    rowTimers.clear()
    if (tick) clearInterval(tick)
    if (delivery) clearTimeout(delivery)
    delivery = undefined
    unsubscribeInput?.()
    unsubscribeInput = undefined
    await manager?.shutdown()
    context?.ui.setWidget(FLEET_WIDGET, undefined)
    widgetMounted = false
  })
  pi.on("session_tree", async (_event, ctx) => {
    live = false
    fleetAbort.abort()
    for (const timer of rowTimers) clearInterval(timer)
    rowTimers.clear()
    saveEnabled = false
    if (delivery) clearTimeout(delivery)
    delivery = undefined
    await manager?.shutdown()
    saveEnabled = true
    initialize(ctx)
  })

  pi.registerTool({
    name: "task", label: "Task", description: buildTaskDescription(agents(process.cwd())),
    promptSnippet: "Delegate focused work; optionally background or resume a saved task.",
    promptGuidelines: [
      "Use task for focused exploration, research, code changes, or reviews; give self-contained instructions.",
      "Use task background=true when independent work can continue; completion arrives automatically.",
      "Use task resume=<id> for follow-ups, task_list for agents, and task_control for running tasks.",
      "Parallel task calls share the checkout; avoid overlapping edits.",
    ],
    parameters: SubagentParams,
    style: { paddingX: 1, paddingY: 0, pendingBg: null, successBg: null, errorBg: null },
    async execute(_id, params, signal, onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error("Task call was cancelled before launch")
        const tasks = current(ctx)
        let id: string | undefined
        const started = launch(ctx, params, (result) => onUpdate?.({
          content: [{ type: "text", text: "(running...)" }], details: { result, taskId: id },
        }))
        id = started.task.id
        if (params.background) return {
          content: [{ type: "text", text: `Task ${id} ${started.task.status} in background. Completion will be delivered automatically.` }],
          details: { taskId: id, result: null },
        }
        const cancel = () => { void tasks.cancel(id!).catch(() => {}) }
        if (signal?.aborted) cancel()
        else signal?.addEventListener("abort", cancel, { once: true })
        try {
          const task = await started.done
          return {
            content: [{ type: "text", text: `Task ${task.id} ${task.status}:\n${boundedOutput(task)}` }],
            details: { taskId: task.id, result: task.result ?? null },
            isError: task.status !== "completed",
          }
        } finally { signal?.removeEventListener("abort", cancel) }
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: { result: null }, isError: true }
      }
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("text", theme.bold("Task"))} ${args.description ?? ""}${args.background ? " [background]" : ""}`, 0, 0)
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as { result?: RunResult; taskId?: string } | undefined
      if (!details?.result) return new Text(result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), 0, 0)
      const state = context.state ?? (context.state = {})
      if (isPartial && !state.timer) {
        state.timer = setInterval(() => context.invalidate(), 1000)
        rowTimers.add(state.timer)
      }
      if (!isPartial && state.timer) {
        clearInterval(state.timer)
        rowTimers.delete(state.timer)
        state.timer = undefined
      }
      return renderResult(details.result, getDisplayItems(details.result.messages), { expanded, isPartial }, theme)
    },
  })

  pi.registerTool({
    name: "task_list", label: "List Agents",
    description: "List available agent definitions from ~/.agents/agents/, ~/.pi/agent/agents/ and .pi/agents/. Use task_control to list task runs.",
    promptSnippet: "List available task agent definitions.", parameters: Type.Object({}),
    style: { paddingX: 1, paddingY: 0, pendingBg: null, successBg: null, errorBg: null },
    async execute(_id, _params, _signal, _update, ctx) {
      const discovered = agents(ctx.cwd)
      return {
        content: [{ type: "text", text: discovered.map((a) => `${a.name}${a.source === "project" ? " (project)" : ""}${configuredModel(a.model) ? ` [${configuredModel(a.model)}]` : ""}: ${a.description}${a.tools ? ` tools: ${a.tools.join(", ")}` : ""}`).join("\n") || "No agent definitions found." }],
        details: { agents: discovered },
      }
    },
    renderResult(result, _opts, theme) {
      const listed = (result.details as { agents: ReturnType<typeof discoverAgents> }).agents
      if (!listed.length) return new Text(theme.fg("dim", "No agent definitions found."), 0, 0)
      return new Text(listed.map((agent) => {
        const badge = agent.source === "project" ? theme.fg("accent", " (project)") : ""
        const model = configuredModel(agent.model)
        return `  ${theme.fg("toolTitle", theme.bold(agent.name))}${badge}${model ? theme.fg("dim", ` [${model}]`) : ""}${agent.description ? theme.fg("dim", ` - ${agent.description}`) : ""}`
      }).join("\n"), 0, 0)
    },
  })

  pi.registerTool({
    name: "task_control", label: "Task Control",
    description: "List tasks, retrieve status/results, steer an active worker, or cancel a task. Status consumes a finished background result to avoid duplicate delivery. Task IDs are scoped to this parent session.",
    promptSnippet: "Inspect, steer, or cancel task runs.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("steer"), Type.Literal("cancel")]),
      id: Type.Optional(Type.String({ description: "Full task ID; required except for list" })),
      message: Type.Optional(Type.String({ description: "Steering instruction" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const tasks = current(ctx)
        if (params.action === "list") return {
          content: [{ type: "text", text: tasks.list().map((t) => `${t.id} [${t.status}] ${t.agent}: ${t.description}`).join("\n") || "No tasks." }],
          details: {},
        }
        if (!params.id) throw new Error("Task ID required")
        const task = tasks.get(params.id)
        if (params.action === "steer") {
          if (!params.message?.trim()) throw new Error("Steering message required")
          await tasks.steer(task.id, params.message)
        } else if (params.action === "cancel") await tasks.cancel(task.id)
        if (params.action === "status" && !isActiveTask(task)) tasks.consume(task.id)
        return {
          content: [{ type: "text", text: `Task ${task.id} [${task.status}]${isActiveTask(task) ? ` ${task.lastActivity ?? ""}` : `:\n${boundedOutput(task)}`}` }],
          details: {},
          isError: params.action === "status" && ["failed", "interrupted"].includes(task.status),
        }
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true }
      }
    },
  })

  pi.registerCommand("tasks", {
    description: "Browse tasks, open live transcripts, resume/steer/cancel workers, or toggle the fleet",
    handler: async (args, ctx) => {
      const tasks = current(ctx)
      const actions = fleetActions(ctx, tasks)
      if (args.trim() === "toggle") { actions.toggle(); return }
      await openTaskPicker(ctx, () => tasks.list(), actions, fleetAbort.signal)
    },
  })
}
