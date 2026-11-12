import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeybindingsManager } from "@mariozechner/pi-tui"
import { taskOutput } from "./manager.js"
import { isActiveTask, type TaskRecord } from "./types.js"
import { alignedLine, cleanTaskText, elapsedTask, orderedTasks, paint, taskState, usageLabel, type FleetTheme } from "./fleet-view.js"

export interface BrowserState {
  query: string
  filter: "all" | "active" | "history"
  selectedId?: string
}

export interface BrowserAction {
  action: "inspect" | "resume" | "steer" | "cancel" | "toggle"
  taskId?: string
}

export class TaskBrowser {
  private input: Input
  private list?: SelectList
  private records: TaskRecord[] = []
  private listTop = 0
  private searchRow = 0
  private visibleRows = 6
  private listWidth = 0

  constructor(
    private tasks: () => readonly TaskRecord[],
    private theme: FleetTheme,
    private keys: Pick<KeybindingsManager, "matches" | "getKeys">,
    private done: (action: BrowserAction | undefined) => void,
    private refresh: () => void,
    readonly state: BrowserState,
  ) {
    this.input = new Input({
      prompt: paint(theme, "dim", "/ "), placeholder: "Search tasks...",
      placeholderStyle: (text) => paint(theme, "dim", text),
    })
    if (state.query) this.input.handleInput(`\x1b[200~${state.query}\x1b[201~`)
    this.input.onSubmit = () => this.choose("inspect")
  }

  get focused() { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }

  private sync(): void {
    const query = this.state.query.trim().toLowerCase()
    this.records = orderedTasks(this.tasks()).filter((task) => {
      if (this.state.filter === "active" && !isActiveTask(task)) return false
      if (this.state.filter === "history" && isActiveTask(task)) return false
      return `${cleanTaskText(task.description)} ${cleanTaskText(task.agent)} ${task.status} ${taskState(task).label}`.toLowerCase().includes(query)
    })
    const items = this.records.map((task) => ({
      value: task.id, label: cleanTaskText(task.description) || cleanTaskText(task.agent),
      description: `${taskState(task).label}  ${elapsedTask(task)}`,
    }))
    this.list = new SelectList(items, this.visibleRows, {
      selectedPrefix: (text) => paint(this.theme, "accent", text),
      selectedText: (text) => paint(this.theme, "accent", this.theme.bold(text)),
      description: (text) => paint(this.theme, "dim", text),
      scrollInfo: (text) => paint(this.theme, "dim", text),
      noMatch: () => paint(this.theme, "dim", this.tasks().length ? "  No matching tasks" : "  No tasks yet. Start an agent to see it here."),
    }, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 46 })
    const index = this.records.findIndex((task) => task.id === this.state.selectedId)
    this.list.setSelectedIndex(Math.max(0, index))
    this.state.selectedId = this.list.getSelectedItem()?.value
    this.list.onSelect = () => this.choose("inspect")
    this.list.onSelectionChange = (item) => { this.state.selectedId = item.value }
  }

  private selected(): TaskRecord | undefined {
    return this.tasks().find((task) => task.id === this.state.selectedId)
  }

  private choose(action: BrowserAction["action"]): void {
    const task = this.selected()
    if (action === "toggle") { this.done({ action }); return }
    if (!task) return
    if (action === "resume" && isActiveTask(task)) return
    if ((action === "steer" || action === "cancel") && !isActiveTask(task)) return
    if (action === "steer" && task.status === "queued") return
    this.done({ action, taskId: task.id })
  }

  private details(width: number, height: number): string[] {
    const task = this.selected()
    if (!task) return []
    const state = taskState(task)
    const title = wrapTextWithAnsi(this.theme.bold(cleanTaskText(task.description)), width).slice(0, height >= 6 ? 2 : 1)
    const usage = usageLabel(task)
    const metadata = `${cleanTaskText(task.agent)}  /  ${state.label}  /  ${elapsedTask(task)}  /  run ${task.run}${usage ? `  /  ${usage}` : ""}`
    const preview = isActiveTask(task) ? task.lastActivity || "Worker is starting..." : taskOutput(task)
    const body = wrapTextWithAnsi(cleanTaskText(preview).slice(0, 600), width)
    return [
      ...title,
      paint(this.theme, state.tone, metadata), ...(height >= 5 ? [""] : []),
      ...body.map((line) => paint(this.theme, "muted", line)),
    ].slice(0, height).map((line) => truncateToWidth(line, width, ""))
  }

  render(width: number, rows = 24): string[] {
    width = Math.max(1, width)
    rows = Math.max(1, Math.min(24, rows))
    const compact = rows < 10
    const split = width >= 100 && !compact
    this.visibleRows = Math.max(1, Math.min(8, rows - (compact ? 3 : split ? 8 : 12)))
    this.sync()
    const all = this.tasks()
    const activeCount = all.filter(isActiveTask).length
    const counts = `${activeCount} active  ${all.length - activeCount} in history`
    const title = alignedLine(paint(this.theme, "accent", this.theme.bold("Agents")), paint(this.theme, "dim", counts), width)
    const tabs = (["all", "active", "history"] as const).map((tab) => {
      const count = tab === "all" ? all.length : tab === "active" ? activeCount : all.length - activeCount
      const label = `${tab[0].toUpperCase()}${tab.slice(1)} ${count}`
      return tab === this.state.filter ? paint(this.theme, "accent", this.theme.bold(label)) : paint(this.theme, "dim", label)
    }).join("   ")
    const head = compact ? [] : [title, tabs, ""]
    this.searchRow = head.length
    head.push(...this.input.render(width), ...(compact ? [] : [""]))
    this.listTop = head.length
    const listWidth = split ? Math.floor(width * 0.57) : width
    this.listWidth = listWidth
    const list = this.list!.render(Math.max(1, listWidth)).slice(0, this.visibleRows + 1)
    let body: string[]
    if (split) {
      const sideWidth = width - listWidth - 3
      const detail = this.details(sideWidth, this.visibleRows + 1)
      body = Array.from({ length: Math.max(list.length, detail.length) }, (_, index) => {
        const left = list[index] ?? ""
        return left + " ".repeat(Math.max(0, listWidth - visibleWidth(left))) + paint(this.theme, "borderMuted", " | ") + (detail[index] ?? "")
      })
    } else {
      const remaining = rows - head.length - list.length - 3
      body = [...list, ...(!compact && remaining >= 2 ? ["", ...this.details(width, Math.min(5, remaining))] : [])]
    }
    const selected = this.selected()
    const key = (name: "tui.select.confirm" | "tui.select.cancel") => this.keys.getKeys(name)[0] ?? ""
    const actions = selected && isActiveTask(selected)
      ? ["alt+x cancel", ...(selected.status === "queued" ? [] : ["alt+s steer"])]
      : selected ? ["alt+r resume"] : []
    const close = `${key("tui.select.cancel")} close`.trim()
    const hints: string[] = []
    for (const hint of [selected ? `${key("tui.select.confirm")} inspect`.trim() : "", ...actions, "tab filter", "alt+f fleet"]) {
      if (hint && visibleWidth([...hints, hint].join("  ")) + visibleWidth(close) + 2 <= width) hints.push(hint)
    }
    const footer = paint(this.theme, "dim", hints.length ? alignedLine(hints.join("  "), close, width) : truncateToWidth(close, width, ""))
    return [...head, ...body, ...(compact ? [] : [""]), footer].slice(0, rows).map((line) => truncateToWidth(line, width, ""))
  }

  handleInput(data: string): void {
    this.sync()
    if (this.keys.matches(data, "tui.select.cancel")) { this.done(undefined); return }
    if (matchesKey(data, "alt+r")) { this.choose("resume"); return }
    if (matchesKey(data, "alt+s")) { this.choose("steer"); return }
    if (matchesKey(data, "alt+x")) { this.choose("cancel"); return }
    if (matchesKey(data, "alt+f")) { this.choose("toggle"); return }
    if (matchesKey(data, "tab")) {
      const filters = ["all", "active", "history"] as const
      this.state.filter = filters[(filters.indexOf(this.state.filter) + 1) % filters.length]
    } else if (this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.down")
      || this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.select.pageDown")) {
      const index = this.records.findIndex((task) => task.id === this.state.selectedId)
      const direction = this.keys.matches(data, "tui.select.up") || this.keys.matches(data, "tui.select.pageUp") ? -1 : 1
      const step = this.keys.matches(data, "tui.select.pageUp") || this.keys.matches(data, "tui.select.pageDown") ? this.visibleRows : 1
      this.state.selectedId = this.records[Math.max(0, Math.min(this.records.length - 1, index + direction * step))]?.id
    } else {
      this.input.handleInput(data)
      this.state.query = this.input.getValue()
    }
    this.refresh()
  }

  handleMouse(event: Parameters<SelectList["handleMouse"]>[0]) {
    if (event.y === this.searchRow) return this.input.handleMouse({ ...event, y: 0 })
    if (event.x < 0 || event.x >= this.listWidth || event.y < this.listTop || event.y >= this.listTop + this.visibleRows) return undefined
    return this.list?.handleMouse({ ...event, y: event.y - this.listTop })
  }

  invalidate(): void { this.input.invalidate(); this.list?.invalidate() }
}
