import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"

/** Abort delegated work if its owning process disappears without a shutdown hook. */
export default function(pi: ExtensionAPI) {
  const parent = Number(process.env.PI_TASK_PARENT_PID)
  if (!Number.isSafeInteger(parent) || parent <= 0) return
  let timer: ReturnType<typeof setInterval> | undefined
  let lost = false
  const checkOwner = (ctx: ExtensionContext) => {
    if (process.ppid === parent || lost) return
    lost = true
    clearInterval(timer)
    const deadline = setTimeout(() => process.exit(1), 8000)
    deadline.unref()
    ctx.abort()
    ctx.shutdown()
  }
  pi.on("session_start", (_event, ctx) => {
    timer = setInterval(() => checkOwner(ctx), 1000)
    timer.unref()
  })
  pi.on("session_shutdown", (_event, ctx) => {
    checkOwner(ctx)
    clearInterval(timer)
  })
}
