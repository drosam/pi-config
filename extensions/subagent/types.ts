import type { RunResult } from "./runner.js"

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export interface TaskRecord {
  id: string
  ownerId: string
  agent: string
  agentSource: "user" | "project"
  description: string
  prompt: string
  cwd: string
  sessionFile: string
  run: number
  status: TaskStatus
  background: boolean
  createdAt: number
  startedAt?: number
  finishedAt?: number
  notifiedRun?: number
  lastActivity?: string
  result?: RunResult
}

export function isActiveTask(task: Pick<TaskRecord, "status">): boolean {
  return task.status === "queued" || task.status === "running" || task.status === "waiting"
}
