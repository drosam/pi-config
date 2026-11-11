/**
 * Subagent process runner.
 * Spawns a pi subprocess in JSON mode, streams messages back.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Message } from "@mariozechner/pi-ai"
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent"
import { resolveModel, type AgentConfig } from "./agents.js"

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
}

export type OnProgress = (result: RunResult) => void

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }
}

const TERMINAL_MESSAGE_GRACE_MS = 1500
const FORCE_KILL_AFTER_GRACE_MS = 5000

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
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args }
  }
  return { command: "pi", args }
}

async function writePromptFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; path: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"))
  const safe = agentName.replace(/[^\w.-]+/g, "_")
  const filePath = path.join(dir, `prompt-${safe}.md`)
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 })
  })
  return { dir, path: filePath }
}

export interface CallerDefaults {
  provider?: string
  model?: string
  thinking?: string
}

/** Build CLI args for spawning a subagent (without the task message or prompt file). */
export function buildArgs(agent: AgentConfig, callerDefaults?: CallerDefaults): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"]
  if (agent.extensions === true) {
    // load all discovered extensions
  } else if (Array.isArray(agent.extensions)) {
    // sandbox + only the listed extensions
    args.push("--no-extensions")
    for (const ext of agent.extensions) args.push("-e", ext)
  } else {
    // default: clean sandbox, no extensions
    args.push("--no-extensions")
  }
  const model = resolveModel(agent.model, callerDefaults?.provider) ?? callerDefaults?.model
  const thinking = agent.thinking ?? callerDefaults?.thinking
  if (model) args.push("--model", model)
  if (thinking) args.push("--thinking", thinking)
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","))
  return args
}

export async function runAgent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined,
  onProgress?: OnProgress,
  callerDefaults?: CallerDefaults,
): Promise<RunResult> {
  const args = buildArgs(agent, callerDefaults)

  let tmpDir: string | null = null
  let tmpPath: string | null = null

  const effectiveModel = resolveModel(agent.model, callerDefaults?.provider) ?? callerDefaults?.model
  const effectiveThinking = agent.thinking ?? callerDefaults?.thinking

  const result: RunResult = {
    agent: agent.name,
    task,
    startedAt: Date.now(),
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: effectiveModel,
    thinking: effectiveThinking,
  }

  const emitProgress = () => onProgress?.(result)

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptFile(agent.name, agent.systemPrompt)
      tmpDir = tmp.dir
      tmpPath = tmp.path
      args.push("--append-system-prompt", tmpPath)
    }

    args.push(`Task: ${task}`)
    let wasAborted = false

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args)
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_SUBAGENT_NAME: agent.name },
      })
      let buffer = ""
      let resolved = false
      let sawTerminalAssistantMessage = false
      let terminalDrainTimer: ReturnType<typeof setTimeout> | null = null
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null
      let abortListener: (() => void) | null = null

      const clearTimers = () => {
        if (terminalDrainTimer) {
          clearTimeout(terminalDrainTimer)
          terminalDrainTimer = null
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer)
          forceKillTimer = null
        }
      }

      const safeResolve = (code: number) => {
        if (resolved) return
        resolved = true
        clearTimers()
        if (abortListener) signal?.removeEventListener("abort", abortListener)
        if (buffer.trim()) processLine(buffer)
        proc.stdout?.removeAllListeners("data")
        proc.stderr?.removeAllListeners("data")
        proc.stdout?.destroy()
        proc.stderr?.destroy()
        resolve(code)
      }

      const scheduleTerminalResolve = () => {
        if (!sawTerminalAssistantMessage || resolved) return
        if (terminalDrainTimer) clearTimeout(terminalDrainTimer)
        terminalDrainTimer = setTimeout(() => {
          if (resolved) return
          if (proc.exitCode === null) {
            proc.kill("SIGTERM")
            forceKillTimer = setTimeout(() => {
              if (proc.exitCode === null) proc.kill("SIGKILL")
            }, FORCE_KILL_AFTER_GRACE_MS)
          }
          safeResolve(proc.exitCode ?? 0)
        }, TERMINAL_MESSAGE_GRACE_MS)
      }

      const processLine = (line: string) => {
        if (!line.trim()) return
        let event: any
        try {
          event = JSON.parse(line)
        } catch {
          return
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message
          result.messages.push(msg)

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
            if (!result.model && msg.model) result.model = msg.model
            if (msg.stopReason) result.stopReason = msg.stopReason
            if (msg.errorMessage) result.errorMessage = msg.errorMessage
            if (isTerminalAssistantMessage(msg)) {
              sawTerminalAssistantMessage = true
              scheduleTerminalResolve()
            }
          }
          emitProgress()
        }

        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message as Message)
          emitProgress()
        }
      }

      proc.stdout.on("data", (data) => {
        buffer += data.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) processLine(line)
        scheduleTerminalResolve()
      })

      proc.stderr.on("data", (data) => {
        result.stderr += data.toString()
        scheduleTerminalResolve()
      })

      // Prefer process exit, but do not wait indefinitely once a terminal
      // assistant message has already been emitted. Some extension stacks
      // keep the child event loop alive after the final JSON event.
      proc.on("exit", (code) => {
        setTimeout(() => safeResolve(code ?? 0), 200)
      })

      proc.on("error", () => safeResolve(1))

      if (signal) {
        abortListener = () => {
          wasAborted = true
          proc.kill("SIGTERM")
          setTimeout(() => {
            if (proc.exitCode === null) proc.kill("SIGKILL")
          }, FORCE_KILL_AFTER_GRACE_MS)
        }
        if (signal.aborted) abortListener()
        else signal.addEventListener("abort", abortListener, { once: true })
      }
    })

    result.exitCode = exitCode
    result.elapsed = (Date.now() - result.startedAt) / 1000
    if (wasAborted) throw new Error("Subagent was aborted")
    return result
  } finally {
    if (tmpPath)
      try {
        fs.unlinkSync(tmpPath)
      } catch { }
    if (tmpDir)
      try {
        fs.rmdirSync(tmpDir)
      } catch { }
  }
}

/** Extract the final assistant text from messages. */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === "assistant") {
      for (const part of msg.content) {
        if (typeof part !== "string" && part.type === "text") return part.text
      }
    }
  }
  return ""
}

/** Extract display items (text + tool calls) from messages. */
export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> }

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (typeof part === "string") continue
        if (part.type === "text") items.push({ type: "text", text: part.text })
        else if (part.type === "toolCall")
          items.push({ type: "toolCall", name: part.name, args: part.arguments })
      }
    }
  }
  return items
}
