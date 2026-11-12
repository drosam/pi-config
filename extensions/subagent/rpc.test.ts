import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const spawn = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ spawn }))
import { TaskRpc } from "./rpc.js"

function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  })
  return proc
}

beforeEach(() => { spawn.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe("TaskRpc", () => {
  test("correlates out-of-order replies and preserves LF framing and UTF-8", async () => {
    const proc = child()
    spawn.mockReturnValue(proc)
    const event = vi.fn()
    const rpc = new TaskRpc("pi", [], "/tmp", "explore", event, vi.fn())
    const commands: any[] = []
    proc.stdin.on("data", (data) => commands.push(JSON.parse(data.toString())))
    const a = rpc.request("get_state")
    const b = rpc.request("steer", { message: "hello" })
    await vi.waitFor(() => expect(commands).toHaveLength(2))
    proc.stdout.write(`${JSON.stringify({ type: "response", id: commands[1].id, success: true, data: { order: 2 } })}\r\n`)
    proc.stdout.write(`${JSON.stringify({ type: "response", id: commands[0].id, success: true, data: { order: 1 } })}\n`)
    expect(await a).toEqual({ order: 1 })
    expect(await b).toEqual({ order: 2 })
    const bytes = Buffer.from(JSON.stringify({ type: "test", text: "猫\u2028dog" }) + "\n")
    for (const byte of bytes) proc.stdout.write(Buffer.from([byte]))
    expect(event).toHaveBeenCalledWith({ type: "test", text: "猫\u2028dog" })
    proc.emit("close", 0)
    await rpc.exited
  })

  test("rejects failed commands and unexpected process exits", async () => {
    const proc = child()
    spawn.mockReturnValue(proc)
    const exited = vi.fn()
    const rpc = new TaskRpc("pi", [], "/tmp", "explore", vi.fn(), exited)
    proc.stdin.on("data", (data) => {
      const cmd = JSON.parse(data.toString())
      proc.stdout.write(JSON.stringify({ type: "response", id: cmd.id, success: false, error: "denied" }) + "\n")
    })
    await expect(rpc.request("prompt")).rejects.toThrow("denied")
    proc.stdin.removeAllListeners("data")
    const waiting = rpc.request("get_state")
    const rejected = expect(waiting).rejects.toThrow("Pi exited 2")
    proc.stderr.write("startup failed")
    proc.emit("close", 2)
    await rejected
    expect(exited.mock.calls[0][0].message).toContain("startup failed")
  })

  test("keeps kill escalation until close and waits for actual exit", async () => {
    vi.useFakeTimers()
    const proc = child()
    spawn.mockReturnValue(proc)
    const rpc = new TaskRpc("pi", [], "/tmp", "explore", vi.fn(), vi.fn())
    let stopped = false
    const stop = rpc.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(1500)
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM")
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
    expect(stopped).toBe(false)
    proc.emit("close", null, "SIGKILL")
    await stop
    expect(vi.getTimerCount()).toBe(0)
  })

  test("command deadlines do not leave pending requests", async () => {
    vi.useFakeTimers()
    const proc = child()
    spawn.mockReturnValue(proc)
    const rpc = new TaskRpc("pi", [], "/tmp", "explore", vi.fn(), vi.fn())
    const pending = rpc.request("get_state", {}, 100)
    const rejected = expect(pending).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    proc.emit("close", 0)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("rejects a malformed stream and bounds diagnostic output", async () => {
    const proc = child()
    spawn.mockReturnValue(proc)
    const rpc = new TaskRpc("pi", [], "/tmp", "explore", vi.fn(), vi.fn())
    const rejected = expect(rpc.request("get_state")).rejects.toThrow("Invalid Pi RPC event")
    proc.stderr.write("x".repeat(100_000))
    expect(rpc.stderr).toHaveLength(32_768)
    proc.stdout.write("not json\n")
    await rejected
    proc.emit("close", 1)
  })
})
