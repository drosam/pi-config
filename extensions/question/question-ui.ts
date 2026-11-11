import type { Theme } from "@mariozechner/pi-coding-agent"
import {
  Editor,
  Markdown,
  type EditorTheme,
  type MarkdownTheme,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui"
import {
  normalizeAnswerSelection,
  replaceAnswerSelection,
  sanitizeQuestionText,
} from "./helpers.ts"
import { OTHER_OPTION_DISPLAY_LABEL, OTHER_OPTION_LABEL, type NormalizedQuestion } from "./types.ts"

export function createMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  }
}

interface QuestionPromptComponentInput {
  tui: TUI
  theme: Theme
  questions: NormalizedQuestion[]
  onDone(result: { cancelled: boolean; answers: string[][] }): void
}

export function createQuestionPromptComponent(input: QuestionPromptComponentInput) {
  return new QuestionPromptComponent(input)
}

class QuestionPromptComponent {
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly questions: NormalizedQuestion[]
  private readonly onDone: QuestionPromptComponentInput["onDone"]
  private readonly editor: Editor
  private suppressEditorChange = false
  private currentQuestionIndex = 0
  private currentOptionIndex = 0
  private editingOther = false
  private readonly selected = new Map<number, Set<string>>()
  private readonly customValues = new Map<number, string>()
  private readonly questionMarkdown = new Map<number, Markdown>()
  private cachedWidth?: number
  private cachedLines?: string[]
  private dirty = true

  constructor({ tui, theme, questions, onDone }: QuestionPromptComponentInput) {
    this.tui = tui
    this.theme = theme
    this.questions = questions
    this.onDone = onDone
    this.editor = new Editor(tui, this.getEditorTheme())
    this.editor.disableSubmit = true
    questions.forEach((question, index) => {
      this.questionMarkdown.set(
        index,
        new Markdown(sanitizeQuestionText(question.question), 0, 0, createMarkdownTheme(theme)),
      )
    })
    this.editor.onChange = () => {
      if (this.suppressEditorChange) return
      this.customValues.set(this.currentQuestionIndex, this.editor.getText())
      this.syncCurrentAnswers()
      this.refresh()
    }
  }

  private getEditorTheme(): EditorTheme {
    return {
      borderColor: () => "",
      selectList: {
        selectedPrefix: (value) => this.theme.fg("accent", value),
        selectedText: (value) => this.theme.fg("accent", value),
        description: (value) => this.theme.fg("muted", value),
        scrollInfo: (value) => this.theme.fg("dim", value),
        noMatch: (value) => this.theme.fg("warning", value),
      },
    }
  }

  private getCurrentQuestion(): NormalizedQuestion {
    const question = this.questions[this.currentQuestionIndex]
    if (question === undefined) {
      throw new Error(`Missing question at index ${this.currentQuestionIndex}`)
    }
    return question
  }

  private isCurrentQuestionMultiple(): boolean {
    return this.getCurrentQuestion().multiple === true
  }

  private getOptionCount(): number {
    return this.getCurrentQuestion().options.length + 1
  }

  private getQuestionLines(width: number): string[] {
    return this.questionMarkdown.get(this.currentQuestionIndex)?.render(width) ?? []
  }

  private isOtherSelected(index: number): boolean {
    return this.selected.get(index)?.has(OTHER_OPTION_LABEL) === true
  }

  private getSelected(index: number): Set<string> {
    const existing = this.selected.get(index)
    if (existing !== undefined) {
      return existing
    }

    const created = new Set<string>()
    this.selected.set(index, created)
    return created
  }

  private setEditorText(text: string): void {
    this.suppressEditorChange = true
    try {
      this.editor.setText(text)
    } finally {
      this.suppressEditorChange = false
    }
  }

  private syncEditorForCurrentQuestion(): void {
    this.setEditorText(this.customValues.get(this.currentQuestionIndex) ?? "")
  }

  private syncCurrentAnswers(): void {
    const selected = this.getSelected(this.currentQuestionIndex)
    const custom = this.customValues.get(this.currentQuestionIndex) ?? ""
    const predefinedOptions = this.getCurrentQuestion().options.map((option) => option.label)
    replaceAnswerSelection(selected, selected, custom, predefinedOptions)
  }

  private toggleCurrentOption(): "toggled" | "editing-other" {
    const selected = this.getSelected(this.currentQuestionIndex)
    const question = this.getCurrentQuestion()
    const otherIndex = question.options.length
    const multiple = this.isCurrentQuestionMultiple()

    if (this.currentOptionIndex === otherIndex) {
      if (selected.has(OTHER_OPTION_LABEL)) {
        selected.delete(OTHER_OPTION_LABEL)
        this.customValues.set(this.currentQuestionIndex, "")
        this.setEditorText("")
        this.editingOther = false
      } else {
        if (!multiple) {
          selected.clear()
        }
        selected.add(OTHER_OPTION_LABEL)
        this.editingOther = true
        this.syncEditorForCurrentQuestion()
      }
      this.syncCurrentAnswers()
      return this.editingOther ? "editing-other" : "toggled"
    }

    const label = question.options[this.currentOptionIndex]?.label
    if (!label) return "toggled"

    if (multiple) {
      if (selected.has(label)) selected.delete(label)
      else selected.add(label)
    } else {
      selected.clear()
      this.customValues.set(this.currentQuestionIndex, "")
      this.setEditorText("")
      selected.add(label)
    }
    this.editingOther = false
    this.syncCurrentAnswers()
    return "toggled"
  }

  private collectAnswers(): string[][] {
    return this.questions.map((question, index) => {
      const selected = this.getSelected(index)
      const custom = this.customValues.get(index) ?? ""
      return normalizeAnswerSelection(
        Array.from(selected),
        custom,
        question.options.map((option) => option.label),
      )
    })
  }

  private finish(cancelled: boolean) {
    if (!cancelled) this.syncCurrentAnswers()
    this.onDone({ cancelled, answers: this.collectAnswers() })
  }

  private advanceOrSubmit() {
    if (this.currentQuestionIndex >= this.questions.length - 1) {
      this.finish(false)
      return
    }
    this.moveQuestion(1)
  }

  private moveQuestion(direction: -1 | 1) {
    const next = this.currentQuestionIndex + direction
    if (next < 0 || next >= this.questions.length) return
    this.syncCurrentAnswers()
    this.currentQuestionIndex = next
    this.currentOptionIndex = 0
    this.editingOther = false
    this.syncEditorForCurrentQuestion()
  }

  private refresh() {
    this.dirty = true
    this.tui.requestRender()
  }

  handleInput(data: string) {
    if (this.editingOther) {
      if (matchesKey(data, Key.escape)) {
        this.editingOther = false
        this.syncCurrentAnswers()
        this.refresh()
        return
      }
      if (matchesKey(data, Key.enter)) {
        this.editingOther = false
        this.syncCurrentAnswers()
        if (!this.isCurrentQuestionMultiple()) {
          this.advanceOrSubmit()
        }
        this.refresh()
        return
      }
      if (matchesKey(data, Key.tab)) {
        this.editingOther = false
        this.moveQuestion(1)
        this.refresh()
        return
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.editingOther = false
        this.moveQuestion(-1)
        this.refresh()
        return
      }
      if (matchesKey(data, Key.ctrl("s"))) {
        this.editingOther = false
        this.finish(false)
        return
      }
      this.editor.handleInput(data)
      this.refresh()
      return
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish(true)
      return
    }
    if (matchesKey(data, Key.up)) {
      this.currentOptionIndex = Math.max(0, this.currentOptionIndex - 1)
      this.refresh()
      return
    }
    if (matchesKey(data, Key.down)) {
      this.currentOptionIndex = Math.min(this.getOptionCount() - 1, this.currentOptionIndex + 1)
      this.refresh()
      return
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.moveQuestion(1)
      this.refresh()
      return
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.moveQuestion(-1)
      this.refresh()
      return
    }
    if (matchesKey(data, Key.enter)) {
      const result = this.toggleCurrentOption()
      if (!this.isCurrentQuestionMultiple() && result !== "editing-other") {
        this.advanceOrSubmit()
      }
      this.refresh()
      return
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      this.finish(false)
      return
    }
  }

  invalidate() {
    this.cachedWidth = undefined
    for (const markdown of this.questionMarkdown.values()) markdown.invalidate()
  }

  render(width: number): string[] {
    if (!this.dirty && this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines
    }

    const lines: string[] = []
    const question = this.getCurrentQuestion()
    const px = 2
    const contentWidth = Math.max(1, width - px * 2)
    const multiple = this.isCurrentQuestionMultiple()
    const add = (value = "") => lines.push(truncateToWidth(value, contentWidth))

    const answers = this.collectAnswers()
    const progress = this.questions
      .map((item, index) => {
        const isActive = index === this.currentQuestionIndex
        const answered = (answers[index]?.length ?? 0) > 0
        const bullet = answered ? "■" : "□"
        const label = ` ${bullet} ${item.header} `
        return isActive
          ? this.theme.bg("selectedBg", this.theme.fg("text", label))
          : this.theme.fg(answered ? "success" : "muted", label)
      })
      .join(" ")

    // Wrap text, prefixing continuation lines with `prefix`.
    const wrap = (text: string, prefix = "") => {
      const wrapWidth = Math.max(1, contentWidth - prefix.length)
      for (const line of wrapTextWithAnsi(text, wrapWidth)) {
        if (line === undefined) continue
        lines.push(prefix + line)
      }
    }
    // Wrap text, but only indent continuation lines (first line is already prefixed).
    const wrapHanging = (text: string, hangIndent: string) => {
      const wrapped = wrapTextWithAnsi(text, contentWidth)
      for (let i = 0; i < wrapped.length; i++) {
        const line = wrapped[i]
        if (line === undefined) continue
        lines.push(i === 0 ? line : hangIndent + line)
      }
    }

    add(progress)
    add()

    this.getQuestionLines(contentWidth).forEach(add)
    add()

    // multi: "▶ ✔ " = 4 chars indent; single: "▶ 1. " = 5 chars indent
    const indent = multiple ? "    " : "     "

    question.options.forEach((option: NormalizedQuestion["options"][number], index: number) => {
      const selected = this.getSelected(this.currentQuestionIndex).has(option.label)
      const active = this.currentOptionIndex === index
      wrapHanging(this.renderOptionLine(option.label, index, active, selected, multiple), indent)
      if (option.description) {
        wrap(this.theme.fg("muted", option.description), indent)
      }
    })

    const otherIndex = question.options.length
    const otherSelected = this.isOtherSelected(this.currentQuestionIndex)
    const otherActive = this.currentOptionIndex === otherIndex
    wrapHanging(
      this.renderOptionLine(
        OTHER_OPTION_DISPLAY_LABEL,
        otherIndex,
        otherActive,
        otherSelected,
        multiple,
      ),
      indent,
    )

    const customValue = this.customValues.get(this.currentQuestionIndex)?.trim() ?? ""
    if (otherSelected || this.editingOther) {
      if (this.editingOther) {
        for (const line of this.renderEditor(contentWidth, indent)) add(line)
      } else if (customValue) {
        add(`${indent}${customValue}`)
      }
    }

    add()
    const key = (value: string) => this.theme.fg("accent", value)
    const action = (value: string) => this.theme.fg("muted", value)
    const divider = this.theme.fg("dim", "·")
    add(
      [
        key("⇆"),
        action("tab"),
        divider,
        key("↑↓"),
        action("select"),
        divider,
        key("enter"),
        action(multiple ? "toggle" : "confirm"),
        divider,
        key("ctrl+s"),
        action("submit"),
        divider,
        key("esc"),
        action("dismiss"),
      ].join(" "),
    )
    if (this.editingOther) {
      add(
        this.theme.fg(
          "dim",
          `Editing ${this.theme.italic(OTHER_OPTION_DISPLAY_LABEL)}: type freely, Enter accepts, Esc stops editing.`,
        ),
      )
    }
    add()

    this.cachedWidth = width
    this.dirty = false
    const margin = " ".repeat(px)
    this.cachedLines = ["", ...lines, ""].map((line) =>
      truncateToWidth(margin + line, width, ""),
    )
    return this.cachedLines
  }

  private renderOptionLine(
    label: string,
    index: number,
    active: boolean,
    selected: boolean,
    multiple: boolean,
  ): string {
    const prefix = active ? this.theme.fg("accent", "▶") : " "
    const styledLabel = active ? this.theme.fg("accent", label) : label
    if (multiple) {
      const check = selected ? this.theme.fg("success", "✔") : this.theme.fg("muted", "○")
      return `${prefix} ${check} ${styledLabel}`
    }
    const number = `${index + 1}.`
    if (selected) {
      return `${prefix} ${this.theme.fg("success", number)} ${this.theme.fg("success", label)}`
    }
    return `${prefix} ${this.theme.fg(active ? "accent" : "muted", number)} ${styledLabel}`
  }

  private renderEditor(width: number, indent: string): string[] {
    const editorWidth = Math.max(20, width - indent.length - 1)
    const rendered = this.editor.render(editorWidth)
    return rendered.filter((line) => line.trim() !== "").map((line) => `${indent}${line}`)
  }
}
