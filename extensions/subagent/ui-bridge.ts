import type { ExtensionContext } from "@mariozechner/pi-coding-agent"
import type { WorkerUiRequest, WorkerUiResponse } from "./runner.js"

export function createTaskUiBridge(ctx: ExtensionContext, agent: string) {
  return async (request: WorkerUiRequest, signal: AbortSignal): Promise<WorkerUiResponse> => {
    if (!ctx.hasUI || signal.aborted) return { cancelled: true }
    const timeout = request.timeout && request.timeout > 0 ? AbortSignal.timeout(request.timeout) : undefined
    const combined = timeout ? AbortSignal.any([signal, timeout]) : signal
    const opts = { signal: combined }
    const title = `[${agent}] ${request.title ?? "Task input"}`
    if (request.method === "confirm") {
      return { confirmed: await ctx.ui.confirm(title, request.message ?? "", opts) }
    }
    if (request.method === "select") {
      const value = await ctx.ui.select(title, request.options ?? [], opts)
      return value === undefined ? { cancelled: true } : { value }
    }
    if (request.method === "input") {
      const value = await ctx.ui.input(title, request.placeholder, opts)
      return value === undefined ? { cancelled: true } : { value }
    }
    // Pi's editor RPC dialog has no abortable UI API; never leave a stale approval open.
    return { cancelled: true }
  }
}

export class TaskDialogQueue {
  private tail = Promise.resolve()

  run<T>(signal: AbortSignal, action: () => Promise<T>, cancelled: T): Promise<T> {
    const next = this.tail.then(() => signal.aborted ? cancelled : action())
    this.tail = next.then(() => {}, () => {})
    return next
  }
}
