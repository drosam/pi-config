import { beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  instances: [] as any[],
  request: vi.fn(),
}))
vi.mock("./rpc.js", () => ({
  TaskRpc: class {
    stderr = ""
    onEvent: (event: any) => void
    onExit: (error?: Error) => void
    write = vi.fn().mockResolvedValue(undefined)
    stop = vi.fn(async () => { this.onExit() })
    request = state.request
    constructor(_command: string, _args: string[], _cwd: string, _agent: string, onEvent: any, onExit: any) {
      this.onEvent = onEvent
      this.onExit = onExit
      state.instances.push(this)
    }
  },
}))
import { runAgent } from "./runner.js"

const agent = { name: "explore", description: "test", systemPrompt: "", source: "user" as const, filePath: "/tmp/explore.md" }
const message = (text: string, stopReason = "stop") => ({
  type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason },
})

beforeEach(() => {
  state.instances.length = 0
  state.request.mockReset().mockResolvedValue({ disposition: "started" })
})

async function started() {
  await vi.waitFor(() => expect(state.request).toHaveBeenCalledWith("prompt", expect.anything()))
  return state.instances[0]
}

describe("RPC agent lifecycle", () => {
  test("waits through agent_end and retry until agent_settled", async () => {
    let finished = false
    const done = runAgent(agent, "research", "/tmp", undefined).then((result) => { finished = true; return result })
    const rpc = await started()
    rpc.onEvent(message("temporary failure", "error"))
    rpc.onEvent({ type: "agent_end", willRetry: true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(rpc.stop).not.toHaveBeenCalled()
    rpc.onEvent(message("recovered"))
    rpc.onEvent({ type: "agent_settled", aborted: false })
    const result = await done
    expect(result.exitCode).toBe(0)
    expect(result.stopReason).toBe("stop")
    expect(result.messages).toHaveLength(2)
    expect(rpc.stop).toHaveBeenCalled()
  })

  test("bridges dialogs with matching IDs and denies when no handler exists", async () => {
    const done = runAgent(agent, "research", "/tmp", undefined)
    const rpc = await started()
    rpc.onEvent({ type: "extension_ui_request", id: "permission-1", method: "confirm" })
    await vi.waitFor(() => expect(rpc.write).toHaveBeenCalledWith({ type: "extension_ui_response", id: "permission-1", cancelled: true }))
    rpc.onEvent({ type: "agent_settled" })
    await done
    state.request.mockClear()
    const handler = vi.fn().mockResolvedValue({ confirmed: true })
    const bridged = runAgent(agent, "research", "/tmp", undefined, undefined, undefined, { onUiRequest: handler })
    await started()
    const second = state.instances[1]
    second.onEvent({ type: "extension_ui_request", id: "permission-2", method: "confirm" })
    await vi.waitFor(() => expect(second.write).toHaveBeenCalledWith({ type: "extension_ui_response", id: "permission-2", confirmed: true }))
    second.onEvent({ type: "agent_settled" })
    await bridged
  })

  test("steers running tasks and clears queue before aborting", async () => {
    let control: any
    const done = runAgent(agent, "research", "/tmp", undefined, undefined, undefined, { onReady: (value) => { control = value } })
    const rpc = await started()
    await control.steer("focus tests")
    expect(state.request).toHaveBeenCalledWith("steer", { message: "focus tests" })
    await control.cancel()
    const result = await done
    expect(state.request.mock.calls.map((args) => args[0])).toEqual(["get_state", "prompt", "steer", "clear_queue", "abort"])
    expect(result.stopReason).toBe("aborted")
    expect(result.exitCode).toBe(1)
    expect(rpc.stop).toHaveBeenCalled()
    await expect(control.steer("too late")).rejects.toThrow("no longer running")
  })

  test("returns startup diagnostics and refuses missing resume sessions", async () => {
    state.request.mockRejectedValueOnce(new Error("startup denied"))
    const result = await runAgent(agent, "research", "/tmp", undefined)
    expect(result.errorMessage).toBe("startup denied")
    expect(result.exitCode).toBe(1)
    expect(state.instances[0].stop).toHaveBeenCalled()
    const resumed = await runAgent(agent, "follow-up", "/tmp", undefined, undefined, undefined, { resume: true, sessionFile: "/path/that/does/not/exist.jsonl" })
    expect(resumed.errorMessage).toContain("refusing to start a fresh conversation")
    expect(state.instances).toHaveLength(1)
  })

  test("handled prompts do not wait for a run which never started", async () => {
    state.request.mockImplementation(async (type) => ({ disposition: type === "prompt" ? "handled" : undefined }))
    const result = await runAgent(agent, "research", "/tmp", undefined)
    expect(result.exitCode).toBe(0)
  })

  test("unexpected clean exit is failure, not success", async () => {
    const done = runAgent(agent, "research", "/tmp", undefined)
    const rpc = await started()
    rpc.onExit()
    const result = await done
    expect(result.exitCode).toBe(1)
    expect(result.errorMessage).toContain("before the task settled")
  })
})
