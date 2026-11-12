import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

export interface WorkerUiRequest {
  type: "extension_ui_request"
  id: string
  method: string
  title?: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
  notifyType?: "info" | "warning" | "error"
}

export interface WorkerUiResponse {
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

interface PendingCommand {
  resolve: (data: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Task-specific JSONL transport. Owns the child until its process has exited. */
export class TaskRpc {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  stderr = ""
  private pending = new Map<string, PendingCommand>()
  private sequence = 0
  private buffer = ""
  private closed = false
  private stopping?: Promise<void>
  private protocolError?: Error
  private writeQueue = Promise.resolve()
  private killTimers: ReturnType<typeof setTimeout>[] = []

  constructor(
    command: string,
    args: string[],
    cwd: string,
    agent: string,
    private onEvent: (event: Record<string, any>) => void,
    private onExit: (error?: Error) => void,
  ) {
    this.child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: "pipe",
      env: { ...process.env, PI_SUBAGENT_NAME: agent, PI_TASK_PARENT_PID: String(process.pid) },
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stderr.setEncoding("utf8")
    this.child.stdout.on("data", (data: string) => this.receive(data))
    this.child.stderr.on("data", (data: string) => {
      this.stderr = (this.stderr + data).slice(-32_768)
    })
    this.child.stdin.on("error", (error) => this.fail(error))
    this.exited = new Promise((resolve) => {
      let exitError: Error | undefined
      this.child.on("error", (error) => {
        exitError = error
        this.fail(error)
      })
      this.child.on("close", (code, signal) => {
        this.closed = true
        for (const timer of this.killTimers) clearTimeout(timer)
        const error = this.protocolError ?? exitError ?? (code === 0 ? undefined : new Error(`Pi exited ${code ?? signal}: ${this.stderr}`))
        this.fail(error ?? new Error("Pi subprocess closed"))
        this.onExit(error)
        resolve()
      })
    })
  }

  request(type: string, fields: Record<string, unknown> = {}, timeout = 30_000): Promise<Record<string, any>> {
    if (this.closed) return Promise.reject(new Error("Pi subprocess is closed"))
    const id = `task-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi ${type} timed out`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      void this.write({ ...fields, type, id }).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  write(record: Record<string, unknown>): Promise<void> {
    const next = this.writeQueue.then(() => new Promise<void>((resolve, reject) => {
      if (this.closed || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
        reject(new Error("Pi subprocess is closed"))
        return
      }
      this.child.stdin.write(`${JSON.stringify(record)}\n`, "utf8", (error) => error ? reject(error) : resolve())
    }))
    this.writeQueue = next.catch(() => {})
    return next
  }

  async stop(): Promise<void> {
    if (this.closed) return
    if (this.stopping) return this.stopping
    this.stopping = this.exited
    this.child.stdin.end()
    // Keep escalation alive until close, including when Pi's extension cleanup hangs.
    this.killTimers.push(setTimeout(() => {
      if (!this.closed) this.child.kill("SIGTERM")
    }, 1500))
    this.killTimers.push(setTimeout(() => {
      if (!this.closed) this.child.kill("SIGKILL")
    }, 6500))
    await this.exited
  }

  private receive(data: string): void {
    this.buffer += data
    let end: number
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "")
      this.buffer = this.buffer.slice(end + 1)
      if (!line.trim()) continue
      try {
        if (line.length > 8 * 1024 * 1024) throw new Error("Pi RPC record exceeds 8 MiB")
        const event = JSON.parse(line)
        if (!event || typeof event !== "object") throw new Error("Expected RPC object")
        if (event.type === "response") {
          const pending = this.pending.get(event.id)
          if (!pending) continue
          this.pending.delete(event.id)
          clearTimeout(pending.timer)
          if (event.success) pending.resolve(event.data ?? {})
          else pending.reject(new Error(event.error || `Pi ${event.command} failed`))
        } else {
          this.onEvent(event)
        }
      } catch (error) {
        this.protocolError = new Error(`Invalid Pi RPC event: ${String(error)}`)
        this.fail(this.protocolError)
        void this.stop()
        return
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.protocolError = new Error("Pi RPC record exceeds 8 MiB")
      this.fail(this.protocolError)
      void this.stop()
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
