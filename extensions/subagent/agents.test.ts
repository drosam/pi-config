import { describe, test, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadAgentsFromDir, resolveModel } from "./agents.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subagent-test-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("loadAgentsFromDir", () => {
  test("loads a valid agent from markdown with frontmatter", () => {
    writeFileSync(
      join(tmpDir, "scout.md"),
      `---
name: scout
description: Fast recon agent
tools: read, bash, grep
model: claude-haiku-4-5
---

You are a scout agent.
`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: "scout",
      description: "Fast recon agent",
      tools: ["read", "bash", "grep"],
      model: "claude-haiku-4-5",
      source: "user",
      systemPrompt: expect.stringContaining("You are a scout agent"),
    })
  })

  test("loads provider-specific model map", () => {
    writeFileSync(
      join(tmpDir, "scout.md"),
      `---
name: scout
description: Fast recon agent
model:
  anthropic: claude-haiku-4-5
  openai-codex: gpt-5.6-luna
---
Body
`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")

    expect(agents[0]!.model).toEqual({
      anthropic: "claude-haiku-4-5",
      "openai-codex": "gpt-5.6-luna",
    })
  })

  test("resolves provider-specific model for caller provider", () => {
    expect(resolveModel({ anthropic: "claude-haiku-4-5" }, "anthropic")).toBe(
      "anthropic/claude-haiku-4-5",
    )
    expect(resolveModel({ anthropic: "claude-haiku-4-5" }, "openai-codex")).toBeUndefined()
    expect(resolveModel("claude-haiku-4-5", "anthropic")).toBe("claude-haiku-4-5")
  })

  test("skips files missing required frontmatter fields", () => {
    writeFileSync(join(tmpDir, "no-name.md"), `---\ndescription: has desc but no name\n---\nBody`)
    writeFileSync(join(tmpDir, "no-desc.md"), `---\nname: agent\n---\nBody`)
    writeFileSync(join(tmpDir, "empty.md"), `No frontmatter at all`)

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents).toHaveLength(0)
  })

  test("skips non-markdown files", () => {
    writeFileSync(join(tmpDir, "agent.txt"), `---\nname: a\ndescription: b\n---\nBody`)
    writeFileSync(join(tmpDir, "agent.json"), `{"name":"a"}`)

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents).toHaveLength(0)
  })

  test("returns empty array for nonexistent directory", () => {
    const agents = loadAgentsFromDir(join(tmpDir, "nope"), "user")
    expect(agents).toEqual([])
  })

  test("parses tools as comma-separated trimmed list", () => {
    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\ntools: " read , bash , grep "\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.tools).toEqual(["read", "bash", "grep"])
  })

  test("omits tools when not specified", () => {
    writeFileSync(join(tmpDir, "a.md"), `---\nname: a\ndescription: d\n---\nBody`)

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.tools).toBeUndefined()
  })

  test("parses thinking level from frontmatter", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      writeFileSync(
        join(tmpDir, "a.md"),
        `---\nname: a\ndescription: d\nthinking: ${level}\n---\nBody`,
      )
      const agents = loadAgentsFromDir(tmpDir, "user")
      expect(agents[0]!.thinking).toBe(level)
    }
  })

  test("thinking defaults to undefined when not specified", () => {
    writeFileSync(join(tmpDir, "a.md"), `---\nname: a\ndescription: d\n---\nBody`)
    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.thinking).toBeUndefined()
  })

  test("ignores invalid thinking level", () => {
    writeFileSync(join(tmpDir, "a.md"), `---\nname: a\ndescription: d\nthinking: turbo\n---\nBody`)
    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.thinking).toBeUndefined()
  })

  test("parses extensions: true (YAML boolean)", () => {
    writeFileSync(join(tmpDir, "a.md"), `---\nname: a\ndescription: d\nextensions: true\n---\nBody`)

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.extensions).toBe(true)
  })

  test("parses extensions: false (YAML boolean)", () => {
    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: false\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.extensions).toBe(false)
  })

  test("resolves relative extension paths from agent directory", () => {
    const extDir = join(tmpDir, "ext")
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, "web.ts"), "export default () => {}")
    writeFileSync(join(extDir, "mcp.ts"), "export default () => {}")

    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: ./ext/web.ts, ./ext/mcp.ts\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.extensions).toEqual([join(extDir, "web.ts"), join(extDir, "mcp.ts")])
  })

  test("drops unresolvable extension entries", () => {
    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: ./nope.ts\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.extensions).toEqual([])
  })

  test("extensions undefined when not specified", () => {
    writeFileSync(join(tmpDir, "a.md"), `---\nname: a\ndescription: d\n---\nBody`)

    const agents = loadAgentsFromDir(tmpDir, "user")
    expect(agents[0]!.extensions).toBeUndefined()
  })

  test("resolves npm: extension via project-local package with pi.extensions manifest", () => {
    // Create a fake npm package at <cwd>/.pi/npm/node_modules/my-ext/
    const pkgDir = join(tmpDir, ".pi", "npm", "node_modules", "my-ext")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "ext.ts"), "export default () => {}")
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "my-ext", pi: { extensions: ["./ext.ts"] } }),
    )

    const agentsDir = join(tmpDir, "agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "npm:my-ext"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(agentsDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([join(pkgDir, "ext.ts")])
  })

  test("resolves npm: extension with single entry point", () => {
    const pkgDir = join(tmpDir, ".pi", "npm", "node_modules", "simple-ext")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "index.ts"), "export default () => {}")
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "simple-ext", pi: { extensions: ["./index.ts"] } }),
    )

    const agentsDir = join(tmpDir, "agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "npm:simple-ext"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(agentsDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([join(pkgDir, "index.ts")])
  })

  test("resolves npm: package with multiple extension entry points", () => {
    const pkgDir = join(tmpDir, ".pi", "npm", "node_modules", "multi-ext")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "a.ts"), "export default () => {}")
    writeFileSync(join(pkgDir, "b.ts"), "export default () => {}")
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "multi-ext", pi: { extensions: ["./a.ts", "./b.ts"] } }),
    )

    const agentsDir = join(tmpDir, "agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      join(agentsDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "npm:multi-ext"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(agentsDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([join(pkgDir, "a.ts"), join(pkgDir, "b.ts")])
  })

  test("drops npm: extension when package is not installed", () => {
    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "npm:nonexistent-package"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([])
  })

  test("drops https:// extension when git package is not installed", () => {
    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "https://github.com/user/nonexistent-repo"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([])
  })

  test("mixes local and npm: extensions, resolving each independently", () => {
    // Local extension
    const extDir = join(tmpDir, "ext")
    mkdirSync(extDir, { recursive: true })
    writeFileSync(join(extDir, "local.ts"), "export default () => {}")

    // npm package
    const pkgDir = join(tmpDir, ".pi", "npm", "node_modules", "pkg-ext")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "index.ts"), "export default () => {}")
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "pkg-ext", pi: { extensions: ["./index.ts"] } }),
    )

    writeFileSync(
      join(tmpDir, "a.md"),
      `---\nname: a\ndescription: d\nextensions: "./ext/local.ts, npm:pkg-ext"\n---\nBody`,
    )

    const agents = loadAgentsFromDir(tmpDir, "user", tmpDir)
    expect(agents[0]!.extensions).toEqual([join(extDir, "local.ts"), join(pkgDir, "index.ts")])
  })
})

describe("discoverAgents", () => {
  test("project agents override user agents with same name", () => {
    const userDir = join(tmpDir, "user-agents")
    const projectRoot = join(tmpDir, "project")
    const projectDir = join(projectRoot, ".pi", "agents")
    mkdirSync(userDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    writeFileSync(
      join(userDir, "scout.md"),
      `---\nname: scout\ndescription: user scout\n---\nUser version`,
    )
    writeFileSync(
      join(projectDir, "scout.md"),
      `---\nname: scout\ndescription: project scout\n---\nProject version`,
    )

    // Load separately and merge like discoverAgents does
    const userAgents = loadAgentsFromDir(userDir, "user")
    const projectAgents = loadAgentsFromDir(projectDir, "project")

    const map = new Map<string, (typeof userAgents)[number]>()
    for (const a of userAgents) map.set(a.name, a)
    for (const a of projectAgents) map.set(a.name, a)
    const result = Array.from(map.values())

    expect(result).toHaveLength(1)
    expect(result[0]!.source).toBe("project")
    expect(result[0]!.description).toBe("project scout")
  })
})
