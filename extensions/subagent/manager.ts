import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { truncateHead } from "@mariozechner/pi-coding-agent"
import type { AgentConfig } from "./agents.js"
import { runAgent, getFinalOutput, type AgentControl, type CallerDefaults, type OnProgress, type RunOptions, type RunResult } from "./runner.js"
import { isActiveTask, type TaskRecord } from "./types.js"

/** Workers running at once per parent session; extra tasks queue. */
export const DEFAULT_MAX_CONCURRENT = 15

export interface TaskManagerOptions {
  ownerId: string
  cwd: string
  sessionDir: string
  save: (task: TaskRecord) => void
  changed: () => void
  completed: () => void
  execute?: typeof runAgent
  maxConcurrent?: number
}

interface Job {
  task: TaskRecord
  agent: AgentConfig
  defaults: CallerDefaults
  options: RunOptions
  controller: AbortController
  resolve: (task: TaskRecord) => void
  done: Promise<TaskRecord>
  control?: AgentControl
  progress?: OnProgress
}

export function taskOutput(task: TaskRecord): string {
  return task.result?.errorMessage || getFinalOutput(task.result?.messages ?? []) || task.result?.stderr || task.lastActivity || "(no output)"
}

/** Keep durable metadata small; the complete child history lives in its Pi session. */
export function savedTask(task: TaskRecord): TaskRecord {
  if (!task.result) return { ...task }
  const result = task.result
  const output = truncateHead(getFinalOutput(result.messages), { maxBytes: 30_000, maxLines: 1000 })
  const text = output.truncated ? `${output.content}\n[Truncated. Full session: ${task.sessionFile}]` : output.content
  return {
    ...task,
    result: {
      ...result,
      stderr: result.stderr.slice(-4096),
      errorMessage: result.errorMessage?.slice(0, 4096),
      messages: [{ role: "assistant", content: [{ type: "text", text }] }] as RunResult["messages"],
    },
  }
}

export class TaskManager {
  private records = new Map<string, TaskRecord>()
  private jobs = new Map<string, Job>()
  private queue: Job[] = []
  private running = new Set<Job>()
  private stopped = false

  constructor(private options: TaskManagerOptions) {}

  list(): TaskRecord[] { return [...this.records.values()] }

  get(id: string): TaskRecord {
    const task = this.records.get(id)
    if (!task) throw new Error(`Unknown task: ${id}`)
    return task
  }

  restore(records: unknown[]): void {
    for (const value of records) {
      if (!value || typeof value !== "object") continue
      const task = value as TaskRecord
      if (task.ownerId !== this.options.ownerId || task.cwd !== this.options.cwd) continue
      if (typeof task.id !== "string" || !/^[a-f0-9-]{36}$/.test(task.id)) continue
      if (task.sessionFile !== path.join(this.options.sessionDir, `${task.id}.jsonl`)) continue
      if (typeof task.agent !== "string" || typeof task.description !== "string" || typeof task.prompt !== "string") continue
      if (!Number.isInteger(task.run) || task.run < 1 || !Number.isFinite(task.createdAt)) continue
      if (!["queued", "running", "waiting", "completed", "failed", "cancelled", "interrupted"].includes(task.status)) continue
      this.records.set(task.id, { ...task })
    }
    for (const task of this.records.values()) {
      if (isActiveTask(task)) {
        task.status = "interrupted"
        task.finishedAt = Date.now()
        task.lastActivity = "Parent session stopped; resume explicitly"
        this.persist(task)
      }
    }
  }

  start(
    agent: AgentConfig,
    prompt: string,
    description: string,
    background: boolean,
    defaults: CallerDefaults,
    options: RunOptions,
    progress?: OnProgress,
    resume?: string,
  ): { task: TaskRecord; done: Promise<TaskRecord> } {
    if (this.stopped) throw new Error("Task manager has stopped")
    const previous = resume ? this.get(resume) : undefined
    if (!previous && this.records.size >= 200) throw new Error("This session already owns 200 tasks; start a new parent session")
    if (previous && isActiveTask(previous)) throw new Error("Task is already active")
    if (previous && previous.agent !== agent.name) throw new Error("Resume must use the original agent type")
    const id = previous?.id ?? randomUUID()
    const task: TaskRecord = {
      id, ownerId: this.options.ownerId, agent: agent.name, agentSource: agent.source,
      description, prompt, cwd: this.options.cwd,
      sessionFile: path.join(this.options.sessionDir, `${id}.jsonl`),
      run: (previous?.run ?? 0) + 1, status: "queued", background,
      createdAt: previous?.createdAt ?? Date.now(),
    }
    let resolve!: Job["resolve"]
    const done = new Promise<TaskRecord>((complete) => { resolve = complete })
    const job: Job = { task, agent, defaults, options: { ...options, resume: !!resume }, controller: new AbortController(), resolve, done, progress }
    this.records.set(id, task)
    this.jobs.set(id, job)
    try { this.persist(task) } catch (error) {
      this.jobs.delete(id)
      if (previous) this.records.set(id, previous)
      else this.records.delete(id)
      throw error
    }
    this.queue.push(job)
    this.pump()
    return { task, done }
  }

  async steer(id: string, message: string): Promise<void> {
    const job = this.jobs.get(this.get(id).id)
    if (!job?.control || !isActiveTask(job.task) || job.task.status === "queued") {
      throw new Error("Task is not ready for steering; wait until it is running")
    }
    await job.control.steer(message)
  }

  async cancel(id: string): Promise<void> {
    const task = this.get(id)
    if (!isActiveTask(task)) throw new Error("Task is not active")
    const job = this.jobs.get(id)!
    job.controller.abort()
    if (task.status === "queued") {
      this.queue = this.queue.filter((queued) => queued !== job)
      this.finish(job, "cancelled")
    }
    await job.done
  }

  consume(id: string): void {
    const task = this.get(id)
    if (isActiveTask(task)) return
    task.notifiedRun = task.run
    this.persist(task)
  }

  pendingCompletions(): TaskRecord[] {
    return this.list().filter((task) => task.background && !isActiveTask(task) && task.notifiedRun !== task.run)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const jobs = [...this.jobs.values()]
    this.queue = []
    for (const job of jobs) {
      job.controller.abort()
      if (job.task.status === "queued") this.finish(job, "interrupted")
    }
    await Promise.all(jobs.map((job) => job.done))
  }

  private persist(task: TaskRecord): void {
    this.options.save(savedTask(task))
    this.options.changed()
  }

  private pump(): void {
    while (!this.stopped && this.running.size < (this.options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) && this.queue.length) {
      const job = this.queue.shift()!
      this.running.add(job)
      void this.execute(job)
    }
  }

  private async execute(job: Job): Promise<void> {
    const task = job.task
    try {
      task.status = "running"
      task.startedAt = Date.now()
      this.persist(task)
      await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 })
      if (job.controller.signal.aborted) {
        this.finish(job, this.stopped ? "interrupted" : "cancelled")
        return
      }
      const result = await (this.options.execute ?? runAgent)(job.agent, task.prompt, task.cwd, job.controller.signal, (result) => {
        task.result = result
        job.progress?.(result)
        this.options.changed()
      }, job.defaults, {
        ...job.options,
        sessionFile: task.sessionFile,
        onReady: (control) => { job.control = control },
        onActivity: (activity) => {
          task.lastActivity = activity
          this.options.changed()
        },
        onUiRequest: async (request, signal) => {
          task.status = "waiting"
          task.lastActivity = request.title ?? "Waiting for input"
          this.options.changed()
          try {
            return await job.options.onUiRequest?.(request, signal) ?? { cancelled: true }
          } finally {
            if (isActiveTask(task)) {
              task.status = "running"
              task.lastActivity = "thinking..."
            }
            this.options.changed()
          }
        },
      })
      task.result = result
      const status = this.stopped ? "interrupted"
        : job.controller.signal.aborted || result.stopReason === "aborted" ? "cancelled"
        : result.exitCode !== 0 || result.stopReason === "error" ? "failed" : "completed"
      this.finish(job, status)
    } catch (error) {
      task.lastActivity = error instanceof Error ? error.message : String(error)
      this.finish(job, this.stopped ? "interrupted" : "failed")
    }
  }

  private finish(job: Job, status: TaskRecord["status"]): void {
    if (this.jobs.get(job.task.id) !== job) return
    job.task.status = status
    job.task.finishedAt = Date.now()
    this.running.delete(job)
    this.jobs.delete(job.task.id)
    const archived = savedTask(job.task)
    this.records.set(archived.id, archived)
    try {
      this.persist(archived)
    } catch (error) {
      archived.lastActivity = `Task metadata could not be saved: ${String(error)}`
      this.options.changed()
    }
    job.resolve(job.task)
    this.pump()
    if (!this.stopped && job.task.background) this.options.completed()
  }
}
