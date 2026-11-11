import { describe, test, expect } from "vitest"
import { buildTaskDescription } from "./index.js"

describe("buildTaskDescription", () => {
  test("includes agent names and descriptions", () => {
    const desc = buildTaskDescription([
      { name: "explore", description: "Fast read-only codebase search" },
      { name: "general", description: "Full-powered coding agent" },
    ])

    expect(desc).toContain("- explore: Fast read-only codebase search")
    expect(desc).toContain("- general: Full-powered coding agent")
  })

  test("falls back to 'No description.' for agents without one", () => {
    const desc = buildTaskDescription([{ name: "mystery" }])

    expect(desc).toContain("- mystery: No description.")
  })

  test("handles empty agent list", () => {
    const desc = buildTaskDescription([])

    expect(desc).toContain("Available agents:")
    // Should still have all the structural sections
    expect(desc).toContain("When to use the Task tool:")
    expect(desc).toContain("When NOT to use the Task tool:")
    expect(desc).toContain("Usage notes:")
  })

  test("includes 'when to use' guidance", () => {
    const desc = buildTaskDescription([{ name: "a", description: "d" }])

    expect(desc).toContain("Complex multi-step tasks")
    expect(desc).toContain("Codebase exploration and research")
    expect(desc).toContain("Parallel independent work units")
    expect(desc).toContain("Code changes that can be done independently")
  })

  test("includes 'when NOT to use' guidance", () => {
    const desc = buildTaskDescription([{ name: "a", description: "d" }])

    expect(desc).toContain("Reading a specific file — use Read directly")
    expect(desc).toContain("use Grep or Read directly")
    expect(desc).toContain("Finding files by name — use Glob directly")
    expect(desc).toContain("Simple single-step tasks")
  })

  test("includes usage notes about concurrency, context, and communication", () => {
    const desc = buildTaskDescription([{ name: "a", description: "d" }])

    expect(desc).toContain("Launch multiple agents concurrently")
    expect(desc).toContain("fresh context")
    expect(desc).toContain("self-contained task description")
    expect(desc).toContain("write code or just research")
    expect(desc).toContain("not visible to the user")
    expect(desc).toContain("generally be trusted")
  })

  test("lists multiple agents in order", () => {
    const desc = buildTaskDescription([
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
      { name: "gamma", description: "third" },
    ])

    const alphaIdx = desc.indexOf("- alpha:")
    const betaIdx = desc.indexOf("- beta:")
    const gammaIdx = desc.indexOf("- gamma:")

    expect(alphaIdx).toBeLessThan(betaIdx)
    expect(betaIdx).toBeLessThan(gammaIdx)
  })
})
