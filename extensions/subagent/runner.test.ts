import { describe, test, expect } from "vitest"
import { buildArgs, getFinalOutput, getDisplayItems, isTerminalAssistantMessage } from "./runner.js"
import type { AgentConfig } from "./agents.js"
import type { Message } from "@mariozechner/pi-ai"

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test",
    description: "test agent",
    systemPrompt: "You are a test agent.",
    source: "user",
    filePath: "/tmp/test.md",
    ...overrides,
  }
}

describe("buildArgs", () => {
  test("default: sandboxed with --no-extensions", () => {
    const args = buildArgs(agent())
    expect(args).toContain("--no-extensions")
    expect(args).toContain("--mode")
    expect(args).toContain("json")
    expect(args).toContain("-p")
    expect(args).toContain("--no-session")
  })

  test("extensions: true omits --no-extensions", () => {
    const args = buildArgs(agent({ extensions: true }))
    expect(args).not.toContain("--no-extensions")
  })

  test("extensions: false adds --no-extensions", () => {
    const args = buildArgs(agent({ extensions: false }))
    expect(args).toContain("--no-extensions")
  })

  test("extensions as resolved paths adds --no-extensions and -e for each", () => {
    const args = buildArgs(
      agent({ extensions: ["/abs/path/glob/index.ts", "/abs/path/grep/index.ts"] }),
    )
    expect(args).toContain("--no-extensions")
    const eFlags = args.reduce(
      (acc, v, i) => (v === "-e" ? [...acc, args[i + 1]] : acc),
      [] as (string | undefined)[],
    )
    expect(eFlags).toEqual(["/abs/path/glob/index.ts", "/abs/path/grep/index.ts"])
  })

  test("includes --model when specified", () => {
    const args = buildArgs(agent({ model: "claude-haiku-4-5" }))
    const idx = args.indexOf("--model")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("claude-haiku-4-5")
  })

  test("resolves provider-specific model map", () => {
    const args = buildArgs(agent({ model: { anthropic: "claude-haiku-4-5" } }), {
      provider: "anthropic",
      model: "anthropic/claude-sonnet-5",
    })
    const idx = args.indexOf("--model")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("anthropic/claude-haiku-4-5")
  })

  test("falls back to caller model when provider map has no match", () => {
    const args = buildArgs(agent({ model: { anthropic: "claude-haiku-4-5" } }), {
      provider: "openai-codex",
      model: "openai-codex/gpt-5.5",
    })
    const idx = args.indexOf("--model")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("openai-codex/gpt-5.5")
  })

  test("omits --model when not specified", () => {
    const args = buildArgs(agent())
    expect(args).not.toContain("--model")
  })

  test("includes --tools as comma-joined list", () => {
    const args = buildArgs(agent({ tools: ["read", "bash", "grep"] }))
    const idx = args.indexOf("--tools")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("read,bash,grep")
  })

  test("omits --tools when not specified", () => {
    const args = buildArgs(agent())
    expect(args).not.toContain("--tools")
  })

  test("includes --thinking when specified", () => {
    const args = buildArgs(agent({ thinking: "high" }))
    const idx = args.indexOf("--thinking")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("high")
  })

  test("includes --thinking off", () => {
    const args = buildArgs(agent({ thinking: "off" }))
    const idx = args.indexOf("--thinking")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("off")
  })

  test("omits --thinking when not specified", () => {
    const args = buildArgs(agent())
    expect(args).not.toContain("--thinking")
  })

  test("inherits model from caller defaults when agent has none", () => {
    const args = buildArgs(agent({ model: undefined }), { model: "claude-sonnet-4-20250514" })
    const idx = args.indexOf("--model")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("claude-sonnet-4-20250514")
  })

  test("inherits thinking from caller defaults when agent has none", () => {
    const args = buildArgs(agent({ thinking: undefined }), { thinking: "high" })
    const idx = args.indexOf("--thinking")
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe("high")
  })

  test("agent model overrides caller default", () => {
    const args = buildArgs(agent({ model: "claude-haiku-4-5" }), {
      model: "claude-sonnet-4-20250514",
    })
    const idx = args.indexOf("--model")
    expect(args[idx + 1]).toBe("claude-haiku-4-5")
  })

  test("agent thinking overrides caller default", () => {
    const args = buildArgs(agent({ thinking: "off" }), { thinking: "high" })
    const idx = args.indexOf("--thinking")
    expect(args[idx + 1]).toBe("off")
  })
})

describe("isTerminalAssistantMessage", () => {
  test("returns false for assistant tool-use turns", () => {
    const message = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "1", name: "grep", arguments: { pattern: "foo" } }],
    } as unknown as Message

    expect(isTerminalAssistantMessage(message)).toBe(false)
  })

  test("returns true for assistant stop turns", () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    } as unknown as Message

    expect(isTerminalAssistantMessage(message)).toBe(true)
  })

  test("treats assistant messages without tool calls as terminal fallback", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    } as unknown as Message

    expect(isTerminalAssistantMessage(message)).toBe(true)
  })

  test("returns false for non-assistant messages", () => {
    const message = { role: "user", content: "hello" } as Message
    expect(isTerminalAssistantMessage(message)).toBe(false)
  })
})

describe("getFinalOutput", () => {
  test("extracts text from last assistant message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first" }] } as Message,
      { role: "assistant", content: [{ type: "text", text: "final answer" }] } as Message,
    ]
    expect(getFinalOutput(messages)).toBe("final answer")
  })

  test("returns empty string when no assistant messages", () => {
    const messages: Message[] = [{ role: "user", content: "hello" } as Message]
    expect(getFinalOutput(messages)).toBe("")
  })

  test("returns empty string for empty array", () => {
    expect(getFinalOutput([])).toBe("")
  })

  test("skips non-text content in assistant message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "the answer" },
        ],
      } as Message,
    ]
    expect(getFinalOutput(messages)).toBe("the answer")
  })
})

describe("getDisplayItems", () => {
  test("extracts text and tool calls from assistant messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look" },
          { type: "toolCall", id: "1", name: "grep", arguments: { pattern: "foo" } },
        ],
      } as Message,
      { role: "user", content: "tool result" } as Message,
      {
        role: "assistant",
        content: [{ type: "text", text: "Found it" }],
      } as Message,
    ]

    const items = getDisplayItems(messages)
    expect(items).toEqual([
      { type: "text", text: "Let me look" },
      { type: "toolCall", name: "grep", args: { pattern: "foo" } },
      { type: "text", text: "Found it" },
    ])
  })

  test("returns empty array for no messages", () => {
    expect(getDisplayItems([])).toEqual([])
  })

  test("ignores user and tool_result messages", () => {
    const messages: Message[] = [
      { role: "user", content: "hello" } as Message,
      { role: "tool_result", content: [{ type: "text", text: "result" }] } as unknown as Message,
    ]
    expect(getDisplayItems(messages)).toEqual([])
  })
})
