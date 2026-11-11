/**
 * Agent discovery and configuration.
 * Loads agent definitions from ~/.pi/agent/agents/ and .pi/agents/
 */

import * as fs from "node:fs"
import * as path from "node:path"
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  parseFrontmatter,
} from "@mariozechner/pi-coding-agent"

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

export type ModelConfig = string | Record<string, string>

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  model?: ModelConfig
  thinking?: ThinkingLevel
  /** undefined/false = --no-extensions (default), true = all, string[] = specific extensions */
  extensions?: boolean | string[]
  systemPrompt: string
  source: "user" | "project"
  filePath: string
}

export function resolveModel(config: ModelConfig | undefined, callerProvider?: string): string | undefined {
  if (!config) return undefined
  if (typeof config === "string") return config
  if (!callerProvider) return undefined

  const model = config[callerProvider]
  if (!model) return undefined

  return `${callerProvider}/${model}`
}

// ── Extension resolution ────────────────────────────────────────────

/** Cached package manager, keyed by cwd. */
let _packageManager: { cwd: string; instance: InstanceType<typeof DefaultPackageManager> } | null =
  null

function getPackageManager(cwd: string): InstanceType<typeof DefaultPackageManager> {
  if (!_packageManager || _packageManager.cwd !== cwd) {
    _packageManager = {
      cwd,
      instance: new DefaultPackageManager({
        cwd,
        agentDir: getAgentDir(),
        settingsManager: SettingsManager.create(cwd, getAgentDir()),
      }),
    }
  }
  return _packageManager.instance
}

/**
 * Resolve a local extension entry to an absolute path.
 * Bare names search extension directories (global, then project-local).
 * Relative paths resolve from the agent file's directory.
 */
function resolveLocalExtensionPath(entry: string, agentDir: string, cwd: string): string | null {
  if (path.isAbsolute(entry)) {
    return fs.existsSync(entry) ? entry : null
  }

  if (entry.startsWith("./") || entry.startsWith("../")) {
    const resolved = path.resolve(agentDir, entry)
    return fs.existsSync(resolved) ? resolved : null
  }

  // Bare name — search extension directories (global, then project-local)
  const extensionDirs = [
    path.join(getAgentDir(), "extensions"),
    path.join(cwd, ".pi", "extensions"),
  ]

  for (const dir of extensionDirs) {
    for (const candidate of [
      path.join(dir, entry, "index.ts"),
      path.join(dir, entry, "index.js"),
      path.join(dir, `${entry}.ts`),
      path.join(dir, `${entry}.js`),
    ]) {
      if (fs.existsSync(candidate)) return candidate
    }
  }

  return null
}

function isPackageSource(entry: string): boolean {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/)/.test(entry)
}

/**
 * Resolve a package source (npm:, git:, URL) to extension entry points.
 * Uses DefaultPackageManager to find the installed path and read the pi manifest.
 */
function resolvePackageExtensions(source: string, cwd: string): string[] {
  const pm = getPackageManager(cwd)
  const installedPath =
    pm.getInstalledPath(source, "project") ?? pm.getInstalledPath(source, "user")
  if (!installedPath) return []

  // These methods exist at runtime but are typed as private
  const pmAny = pm as any
  const accumulator = pmAny.createAccumulator()
  const metadata = { source, scope: "user" as const, origin: "package" as const }
  pmAny.collectPackageResources(installedPath, accumulator, undefined, metadata)

  return Array.from((accumulator.extensions as Map<string, unknown>).keys())
}

function resolveExtensions(entries: string[], agentDir: string, cwd: string): string[] {
  const resolved: string[] = []
  for (const entry of entries) {
    if (isPackageSource(entry)) {
      resolved.push(...resolvePackageExtensions(entry, cwd))
    } else {
      const p = resolveLocalExtensionPath(entry, agentDir, cwd)
      if (p) resolved.push(p)
    }
  }
  return resolved
}

// ── Frontmatter parsing ─────────────────────────────────────────────

function parseThinking(value: unknown): ThinkingLevel | undefined {
  if (!value) return undefined
  const str = String(value).trim().toLowerCase()
  return THINKING_LEVELS.has(str) ? (str as ThinkingLevel) : undefined
}

function parseExtensions(value: unknown): AgentConfig["extensions"] {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseModel(value: unknown): ModelConfig | undefined {
  if (!value) return undefined

  if (typeof value === "string") {
    const model = value.trim()
    return model ? model : undefined
  }

  if (typeof value !== "object") return undefined

  const parsed: Record<string, string> = {}
  for (const [provider, model] of Object.entries(value as Record<string, unknown>)) {
    if (!provider || typeof model !== "string") continue
    const providerId = provider.trim()
    const modelId = model.trim()
    if (!providerId || !modelId) continue
    parsed[providerId] = modelId
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined
}

// ── Agent loading ───────────────────────────────────────────────────

export function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
  cwd?: string,
): AgentConfig[] {
  if (!fs.existsSync(dir)) return []

  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const effectiveCwd = cwd ?? process.cwd()
  const agents: AgentConfig[] = []

  for (const entry of dirEntries) {
    if (!entry.name.endsWith(".md")) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const filePath = path.join(dir, entry.name)
    let content: string
    try {
      content = fs.readFileSync(filePath, "utf-8")
    } catch {
      continue
    }

    const { frontmatter, body } = parseFrontmatter<{
      name?: string
      description?: string
      tools?: string
      extensions?: unknown
      thinking?: unknown
      model?: unknown
    }>(content)
    if (!frontmatter.name || !frontmatter.description) continue

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean)

    const extensions = parseExtensions(frontmatter.extensions)
    const resolvedExtensions = Array.isArray(extensions)
      ? resolveExtensions(extensions, dir, effectiveCwd)
      : extensions

    const thinking = parseThinking(frontmatter.thinking)

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: parseModel(frontmatter.model),
      thinking,
      extensions: resolvedExtensions,
      systemPrompt: body,
      source,
      filePath,
    })
  }

  return agents
}

function findProjectAgentsDir(cwd: string): string | null {
  let dir = cwd
  while (true) {
    const candidate = path.join(dir, ".pi", "agents")
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {}
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function discoverAgents(cwd: string): AgentConfig[] {
  const userDir = path.join(getAgentDir(), "agents")
  const projectDir = findProjectAgentsDir(cwd)

  const map = new Map<string, AgentConfig>()
  for (const a of loadAgentsFromDir(userDir, "user", cwd)) map.set(a.name, a)
  if (projectDir) {
    for (const a of loadAgentsFromDir(projectDir, "project", cwd)) map.set(a.name, a)
  }
  return Array.from(map.values())
}

export function findAgent(cwd: string, name: string): AgentConfig | undefined {
  return discoverAgents(cwd).find((a) => a.name === name)
}
