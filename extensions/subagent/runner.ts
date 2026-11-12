/** Subagent subprocess runner, controlled through Pi's documented RPC protocol. */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "@mariozechner/pi-ai"
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent"
import { resolveModel, type AgentConfig } from "./agents.js"
import { TaskRpc, type WorkerUiRequest, type WorkerUiResponse } from "./rpc.js"

export type { WorkerUiRequest, WorkerUiResponse } from "./rpc.js"

interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface RunResult {
  agent: string
  task: string
  startedAt: number
  elapsed?: number
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  thinking?: string
  stopReason?: string
  errorMessage?: string
  sessionFile?: string
}

export interface CallerDefaults {
  provider?: string
  model?: string
  thinking?: string
}

export interface AgentControl {
  steer(message: string): Promise<void>
  cancel(): Promise<void>
}

export interface RunOptions {
  sessionFile?: string
  resume?: boolean
  projectTrusted?: boolean
  onReady?: (control: AgentControl) => void
  onActivity?: (activity: string) => void
  onUiRequest?: (request: WorkerUiRequest, signal: AbortSignal) => Promise<WorkerUiResponse>
}

export type OnProgress = (result: RunResult) => void

/** Short human label for a tool call, e.g. `bash sleep 60` or `read src/a.ts`. */
export function describeToolCall(name: string, args: unknown): string {
  const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>
  const detail = [input.command, input.path, input.pattern, input.query, input.url].find((value) => typeof value === "string" && value.trim())
  return detail ? `${name} ${String(detail).replace(/\s+/g, " ").trim().slice(0, 100)}` : name
}

export function isTerminalAssistantMessage(msg: Message): boolean {
  if (msg.role !== "assistant") return false
  if (msg.stopReason && msg.stopReason !== "toolUse") return true
  return !msg.content.some((part) => typeof part !== "string" && part.type === "toolCall")
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }
  const execName = path.basename(process.execPath).toLowerCase()
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args }
  return { command: "pi", args }
}

async function validateSavedSession(file: string, cwd: string): Promise<void> {
  const handle = await fs.promises.open(file, "r")
  try {
    const buffer = Buffer.alloc(65_536)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0])
    if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || path.resolve(header.cwd) !== path.resolve(cwd)) {
      throw new Error("Saved task session has an invalid header or different working directory")
    }
  } finally { await handle.close() }
}

export function buildArgs(agent: AgentConfig, callerDefaults?: CallerDefaults, options: RunOptions = {}): string[] {
  const args = ["--mode", "rpc"]
  if (options.sessionFile) args.push("--session", options.sessionFile)
  else args.push("--no-session")
  if (options.projectTrusted !== undefined) args.push(options.projectTrusted ? "--approve" : "--no-approve")
  if (agent.extensions !== true) {
    args.push("--no-extensions")
    if (Array.isArray(agent.extensions)) for (const ext of agent.extensions) args.push("-e", ext)
  }
  const model = resolveModel(agent.model, callerDefaults?.provider) ?? callerDefaults?.model
  const thinking = agent.thinking ?? callerDefaults?.thinking
  if (model) args.push("--model", model)
  if (thinking) args.push("--thinking", thinking)
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","))
  return args
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress?: OnProgress,
  callerDefaults?: CallerDefaults,
  options: RunOptions = {},
): Promise<RunResult> {
  const result: RunResult = {
    agent: agent.name, task, startedAt: Date.now(), exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: resolveModel(agent.model, callerDefaults?.provider) ?? callerDefaults?.model,
    thinking: agent.thinking ?? callerDefaults?.thinking,
    sessionFile: options.sessionFile,
  }
  let tmpDir: string | undefined
  let rpc: TaskRpc | undefined
  let settled = false
  let cancelled = false
  let cancelling: Promise<void> | undefined
  const uiAbort = new AbortController()
  let finish!: () => void
  const completed = new Promise<void>((resolve) => { finish = resolve })
  const abort = () => { void cancel() }

  async function cancel(): Promise<void> {
    if (settled) return
    if (cancelling) return cancelling
    cancelled = true
    uiAbort.abort()
    cancelling = (async () => {
      if (rpc) {
        try {
          await rpc.request("clear_queue", {}, 1000)
          await rpc.request("abort", {}, 2000)
        } catch { /* A dead or unresponsive child still needs to be reaped. */ }
        await rpc.stop()
      }
      finish()
    })()
    return cancelling
  }

  try {
    if (signal?.aborted) {
      cancelled = true
      return result
    }
    if (options.resume && (!options.sessionFile || !fs.existsSync(options.sessionFile))) {
      throw new Error("Saved task session is missing; refusing to start a fresh conversation")
    }
    if (options.resume) await validateSavedSession(options.sessionFile!, cwd)
    const args = buildArgs(agent, callerDefaults, options)
    args.push("-e", fileURLToPath(new URL("./lifetime.ts", import.meta.url)))
    if (agent.systemPrompt.trim()) {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"))
      const promptPath = path.join(tmpDir, "prompt.md")
      await withFileMutationQueue(promptPath, () => fs.promises.writeFile(promptPath, agent.systemPrompt, { mode: 0o600 }))
      args.push("--append-system-prompt", promptPath)
    }
    if (signal?.aborted) {
      cancelled = true
      return result
    }
    const invocation = getPiInvocation(args)
    rpc = new TaskRpc(invocation.command, invocation.args, cwd, agent.name, (event) => {
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message
        result.messages.push(msg)
        while (result.messages.length > 1 && (result.messages.length > 200 || JSON.stringify(result.messages).length > 2 * 1024 * 1024)) result.messages.shift()
        if (msg.role === "assistant") {
          result.usage.turns++
          const usage = msg.usage
          if (usage) {
            result.usage.input += usage.input || 0
            result.usage.output += usage.output || 0
            result.usage.cacheRead += usage.cacheRead || 0
            result.usage.cacheWrite += usage.cacheWrite || 0
            result.usage.cost += usage.cost?.total || 0
            result.usage.contextTokens = usage.totalTokens || 0
          }
          result.stopReason = msg.stopReason
          result.errorMessage = msg.errorMessage
        }
        onProgress?.({ ...result, messages: [...result.messages], usage: { ...result.usage } })
      } else if (event.type === "tool_execution_start") {
        options.onActivity?.(describeToolCall(event.toolName, event.args))
      } else if (event.type === "turn_start" || event.type === "tool_execution_end") {
        options.onActivity?.("thinking...")
      } else if (event.type === "auto_retry_start") {
        options.onActivity?.("retrying")
      } else if (event.type === "compaction_start") {
        options.onActivity?.("compacting")
      } else if (event.type === "agent_settled") {
        settled = true
        if (event.aborted) cancelled = true
        finish()
      } else if (event.type === "extension_ui_request") {
        const request = event as WorkerUiRequest
        if (!["select", "confirm", "input", "editor"].includes(request.method)) return
        const reply = options.onUiRequest
          ? options.onUiRequest(request, uiAbort.signal).catch(() => ({ cancelled: true }))
          : Promise.resolve({ cancelled: true })
        void reply.then((response) => rpc?.write({ ...response, type: "extension_ui_response", id: request.id }))
          .catch(() => {})
      }
    }, (error) => {
      if (!settled && !cancelled) {
        result.errorMessage ??= error?.message ?? "Pi exited before the task settled"
        result.exitCode = 1
      }
      finish()
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    await rpc.request("get_state")
    if (!cancelled) {
      options.onReady?.({
        async steer(message) {
          if (settled || cancelled) throw new Error("Task is no longer running")
          await rpc!.request("steer", { message })
        },
        cancel,
      })
      const response = await rpc.request("prompt", { message: `Task: ${task}` })
      if (response.disposition === "handled") {
        settled = true
        finish()
      }
      await completed
    }
  } catch (error) {
    result.errorMessage = error instanceof Error ? error.message : String(error)
    result.exitCode = 1
  } finally {
    signal?.removeEventListener("abort", abort)
    uiAbort.abort()
    await rpc?.stop()
    result.stderr = rpc?.stderr ?? ""
    if (cancelled) {
      result.stopReason = "aborted"
      result.exitCode = 1
    } else if (result.stopReason === "error" || result.stopReason === "aborted") {
      result.exitCode = 1
    }
    result.elapsed = (Date.now() - result.startedAt) / 1000
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
  return result
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role === "assistant") {
      return msg.content.filter((part) => typeof part !== "string" && part.type === "text")
        .map((part) => (part as { text: string }).text).join("\n")
    }
  }
  return ""
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> }

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const part of msg.content) {
      if (typeof part === "string") continue
      if (part.type === "text") items.push({ type: "text", text: part.text })
      else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments })
    }
  }
  return items
}
