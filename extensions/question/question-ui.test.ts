import { describe, test, expect } from "vitest"
import { Key } from "@mariozechner/pi-tui"
import { Theme } from "@mariozechner/pi-coding-agent"
import { createQuestionPromptComponent } from "./question-ui.ts"
import { OTHER_OPTION_DISPLAY_LABEL, type NormalizedQuestion } from "./types.ts"

// --- Raw terminal sequences for handleInput ---

const RAW: Record<string, string> = {
  [Key.enter]: "\r",
  [Key.escape]: "\x1b",
  [Key.up]: "\x1b[A",
  [Key.down]: "\x1b[B",
  [Key.left]: "\x1b[D",
  [Key.right]: "\x1b[C",
  [Key.tab]: "\t",
  [Key.shift("tab")]: "\x1b[Z",
  [Key.ctrl("s")]: "\x13",
  [Key.ctrl("c")]: "\x03",
  [Key.alt("o")]: "\x1bo",
}

/** Convert a Key identifier or plain character to its raw terminal byte sequence. */
function raw(key: string): string {
  return RAW[key] ?? key
}

// --- Real dependencies for testing ---

const FG_COLORS = {
  accent: 0,
  border: 0,
  borderAccent: 0,
  borderMuted: 0,
  success: 0,
  error: 0,
  warning: 0,
  muted: 0,
  dim: 0,
  text: 0,
  thinkingText: 0,
  userMessageText: 0,
  customMessageText: 0,
  customMessageLabel: 0,
  toolTitle: 0,
  toolOutput: 0,
  mdHeading: 0,
  mdLink: 0,
  mdLinkUrl: 0,
  mdCode: 0,
  mdCodeBlock: 0,
  mdCodeBlockBorder: 0,
  mdQuote: 0,
  mdQuoteBorder: 0,
  mdHr: 0,
  mdListBullet: 0,
  toolDiffAdded: 0,
  toolDiffRemoved: 0,
  toolDiffContext: 0,
  syntaxComment: 0,
  syntaxKeyword: 0,
  syntaxFunction: 0,
  syntaxVariable: 0,
  syntaxString: 0,
  syntaxNumber: 0,
  syntaxType: 0,
  syntaxOperator: 0,
  syntaxPunctuation: 0,
  thinkingOff: 0,
  thinkingMinimal: 0,
  thinkingLow: 0,
  thinkingMedium: 0,
  thinkingHigh: 0,
  thinkingXhigh: 0,
  bashMode: 0,
} as const

const BG_COLORS = {
  selectedBg: 0,
  userMessageBg: 0,
  customMessageBg: 0,
  toolPendingBg: 0,
  toolSuccessBg: 0,
  toolErrorBg: 0,
} as const

const theme = new Theme(FG_COLORS, BG_COLORS, "256color", { name: "test" })

const tui = { requestRender() {} } as Parameters<typeof createQuestionPromptComponent>[0]["tui"]

function makeQuestion(overrides: Partial<NormalizedQuestion> = {}): NormalizedQuestion {
  return {
    question: "Pick a color",
    header: "Color",
    multiple: false,
    options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
    ...overrides,
  }
}

interface DoneResult {
  cancelled: boolean
  answers: string[][]
}

function setup(questions: NormalizedQuestion[]) {
  let result: DoneResult | undefined
  const component = createQuestionPromptComponent({
    tui,
    theme,
    questions,
    onDone(r) {
      result = r
    },
  })
  return {
    component,
    send(key: string) {
      component.handleInput(raw(key))
    },
    render(width = 80) {
      return component.render(width)
    },
    getResult() {
      return result
    },
  }
}

// --- Single-select ---

describe("single-select", () => {
  test("Enter on first option selects and submits", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.enter)
    const r = getResult()!
    expect(r.cancelled).toBe(false)
    expect(r.answers).toEqual([["Red"]])
  })

  test("down + Enter selects second option", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.down)
    send(Key.enter)
    const r = getResult()!
    expect(r.answers).toEqual([["Blue"]])
  })

  test("Escape cancels", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.escape)
    const r = getResult()!
    expect(r.cancelled).toBe(true)
  })

  test("up at top stays at top", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.up)
    send(Key.enter)
    const r = getResult()!
    expect(r.answers).toEqual([["Red"]])
  })

  test("down past last option stays at last", () => {
    const q = makeQuestion({ options: [{ label: "Only" }] })
    const { send, getResult } = setup([q])
    // options: Only + "type your own" = 2 entries, index 0 and 1
    send(Key.down) // -> "type your own" (index 1)
    send(Key.down) // should stay at index 1
    send(Key.up) // -> "Only" (index 0)
    send(Key.enter)
    expect(getResult()!.answers).toEqual([["Only"]])
  })
})

// --- Multi-select ---

describe("multi-select", () => {
  test("Enter toggles and does not auto-advance", () => {
    const q = makeQuestion({ multiple: true })
    const { send, getResult } = setup([q])
    send(Key.enter) // toggle Red
    expect(getResult()).toBeUndefined()
  })

  test("toggle two options then ctrl+s submits both", () => {
    const q = makeQuestion({ multiple: true })
    const { send, getResult } = setup([q])
    send(Key.enter) // toggle Red
    send(Key.down)
    send(Key.enter) // toggle Blue
    send(Key.ctrl("s"))
    const r = getResult()!
    expect(r.cancelled).toBe(false)
    expect(r.answers).toEqual([["Red", "Blue"]])
  })

  test("toggle on then off deselects", () => {
    const q = makeQuestion({ multiple: true })
    const { send, getResult } = setup([q])
    send(Key.enter) // toggle Red on
    send(Key.enter) // toggle Red off
    send(Key.ctrl("s"))
    expect(getResult()!.answers).toEqual([[]])
  })
})

// --- Multi-question navigation ---

describe("multi-question navigation", () => {
  test("Tab advances to next question", () => {
    const q1 = makeQuestion()
    const q2 = makeQuestion({
      question: "Pick a size",
      header: "Size",
      options: [{ label: "S" }, { label: "M" }],
    })
    const { send, getResult } = setup([q1, q2])
    send(Key.enter) // select Red on Q1 -> auto-advance to Q2
    send(Key.enter) // select S on Q2 -> review
    expect(getResult()).toBeUndefined()
    send(Key.enter) // submit from review
    const r = getResult()!
    expect(r.cancelled).toBe(false)
    expect(r.answers).toEqual([["Red"], ["S"]])
  })

  test("Tab from last question wraps or stays, ctrl+s submits", () => {
    const q1 = makeQuestion()
    const q2 = makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }] })
    const { send, getResult } = setup([q1, q2])
    send(Key.enter) // select Red -> advance to Q2
    send(Key.enter) // select S -> review
    send(Key.ctrl("s")) // submit from review
    const r = getResult()!
    expect(r.answers).toEqual([["Red"], ["S"]])
  })

  test("Shift+Tab navigates back", () => {
    const q1 = makeQuestion()
    const q2 = makeQuestion({
      question: "Size",
      header: "Size",
      options: [{ label: "S" }, { label: "M" }],
    })
    const { send, getResult } = setup([q1, q2])
    send(Key.enter) // select Red -> advance to Q2
    send(Key.shift("tab")) // back to Q1
    send(Key.down) // move to Blue
    send(Key.enter) // select Blue (replaces Red) -> advance to Q2
    send(Key.down) // move to M
    send(Key.enter) // select M -> review
    send(Key.enter) // submit
    const r = getResult()!
    expect(r.answers).toEqual([["Blue"], ["M"]])
  })
})

describe("review tab", () => {
  const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
  const twoQuestions = () => [
    makeQuestion(),
    makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }, { label: "M" }] }),
  ]

  test("lists answers and flags unanswered questions", () => {
    const { send, render, getResult } = setup(twoQuestions())
    send(Key.enter) // Red -> Q2
    send(Key.tab) // skip Q2 -> review
    const output = plain(render())
    expect(getResult()).toBeUndefined()
    expect(output).toContain("Review your answers")
    expect(output).toContain("1. Color: Red")
    expect(output).toContain("2. Size: Unanswered")
    expect(output).toContain("1 unanswered")
  })

  test("number key jumps back to edit an answer", () => {
    const { send, getResult } = setup(twoQuestions())
    send(Key.enter) // Red -> Q2
    send(Key.enter) // S -> review
    send("1") // back to Color
    send(Key.down)
    send(Key.enter) // Blue -> Q2
    send(Key.tab) // review
    send(Key.enter) // submit
    expect(getResult()!.answers).toEqual([["Blue"], ["S"]])
  })

  test("shift+tab returns to the last question and esc cancels", () => {
    const { send, render, getResult } = setup(twoQuestions())
    send(Key.tab) // Q2
    send(Key.tab) // review
    send(Key.shift("tab")) // back to Q2
    expect(plain(render())).not.toContain("Review your answers")
    send(Key.tab)
    send(Key.escape)
    expect(getResult()!.cancelled).toBe(true)
  })

  test("reports the review tab as index past the last question", () => {
    const seen: number[] = []
    const component = createQuestionPromptComponent({
      tui,
      theme,
      questions: twoQuestions(),
      onDone() {},
      onQuestionChange: (index) => seen.push(index),
    })
    component.handleInput(raw(Key.tab))
    component.handleInput(raw(Key.tab))
    expect(seen).toEqual([1, 2])
  })
})

describe("hide toggle", () => {
  const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")

  test("alt+o collapses the selector to one hint line and restores it", () => {
    const { send, render } = setup([makeQuestion()])
    expect(plain(render())).toContain("alt+o hide")
    send(Key.alt("o"))
    const hidden = plain(render())
    expect(hidden).toContain("Question hidden")
    expect(hidden).not.toContain("Pick a color")
    expect(render().filter((line) => line.trim()).length).toBe(1)
    send(Key.alt("o"))
    expect(plain(render())).toContain("Pick a color")
  })

  test("other keys are ignored while hidden and state is kept", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.down) // Blue
    send(Key.alt("o"))
    send(Key.enter)
    send(Key.escape)
    expect(getResult()).toBeUndefined()
    send(Key.alt("o"))
    send(Key.enter)
    expect(getResult()!.answers).toEqual([["Blue"]])
  })
})

describe("question change callback", () => {
  test("reports the active question on navigation", () => {
    const seen: number[] = []
    const q2 = makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }] })
    const component = createQuestionPromptComponent({
      tui,
      theme,
      questions: [makeQuestion(), q2],
      onDone() {},
      onQuestionChange: (index) => seen.push(index),
    })
    component.handleInput(raw(Key.tab))
    component.handleInput(raw(Key.shift("tab")))
    component.handleInput(raw(Key.shift("tab")))
    expect(seen).toEqual([1, 0])
  })
})

// --- "Type your own answer" ---

describe("type your own answer", () => {
  test("single-select: type-your-own via other option", () => {
    const q = makeQuestion({ options: [{ label: "A" }] })
    const { send, getResult } = setup([q])
    send(Key.down) // move to "type your own" (index 1)
    send(Key.enter) // enter editor mode
    for (const ch of "custom") send(ch)
    send(Key.enter) // submit custom text -> auto-advance -> finish
    const r = getResult()!
    expect(r.cancelled).toBe(false)
    expect(r.answers).toEqual([["custom"]])
  })

  test("single-select: Escape in editor returns to options without submitting", () => {
    const q = makeQuestion({ options: [{ label: "A" }] })
    const { send, getResult } = setup([q])
    send(Key.down) // -> "type your own"
    send(Key.enter) // enter editor
    for (const ch of "draft") send(ch)
    send(Key.escape) // exit editor, back to options
    expect(getResult()).toBeUndefined()
    send(Key.up) // -> "A"
    send(Key.enter) // select A
    expect(getResult()!.answers).toEqual([["A"]])
  })

  test("multi-select: custom answer does not auto-submit", () => {
    const q = makeQuestion({ multiple: true, options: [{ label: "A" }, { label: "B" }] })
    const { send, getResult } = setup([q])
    send(Key.enter) // toggle A
    send(Key.down)
    send(Key.down) // -> "type your own"
    send(Key.enter) // enter editor
    for (const ch of "extra") send(ch)
    send(Key.enter) // accept custom and stay on the current question
    expect(getResult()).toBeUndefined()
    send(Key.ctrl("s"))
    const r = getResult()!
    expect(r.answers).toEqual([["A", "extra"]])
  })

  test("multi-select: can add predefined options after entering custom text first", () => {
    const q = makeQuestion({ multiple: true, options: [{ label: "A" }, { label: "B" }] })
    const { send, getResult } = setup([q])
    send(Key.down)
    send(Key.down) // -> "type your own"
    send(Key.enter) // enter editor
    for (const ch of "extra") send(ch)
    send(Key.enter) // accept custom and stay on the question
    expect(getResult()).toBeUndefined()
    send(Key.up)
    send(Key.up) // -> "A"
    send(Key.enter) // toggle A
    send(Key.ctrl("s"))
    expect(getResult()!.answers).toEqual([["A", "extra"]])
  })

  test("empty text yields no custom answer", () => {
    const q = makeQuestion({ options: [{ label: "A" }] })
    const { send, getResult } = setup([q])
    send(Key.down) // -> "type your own"
    send(Key.enter) // enter editor
    send(Key.enter) // submit empty -> finishes
    const r = getResult()!
    expect(r.answers).toEqual([[]])
  })
})

// --- Render output ---

describe("render output", () => {
  test("includes question text and option labels", () => {
    const { render } = setup([makeQuestion()])
    const output = render().join("\n")
    expect(output).toContain("Pick a color")
    expect(output).toContain("Red")
    expect(output).toContain("Blue")
    expect(output).toContain(OTHER_OPTION_DISPLAY_LABEL)
  })

  test("shows only the final block of a long Markdown question above the options", () => {
    const evidence = Array.from({ length: 24 }, (_, index) => `- Evidence ${index + 1}`).join("\n")
    const question = makeQuestion({
      question: `### Item C6\n\n${evidence}\n\n**Choose unmistakable-final-word**`,
      options: [{ label: "A" }],
    })
    const { render, send, getResult } = setup([question])

    const output = render(30).join("\n")
    expect(output).not.toContain("Item C6")
    expect(output).not.toContain("Evidence 24")
    expect(output).toContain("unmistakable-final-word")
    expect(output).toContain("Full question")
    expect(output).toContain("A")

    send(Key.down)
    send(Key.enter)
    for (const ch of "draft") send(ch)
    send(Key.enter)
    expect(getResult()!.answers).toEqual([["draft"]])
  })

  test("with context, shows the question and a context hint but not the context", () => {
    const q = makeQuestion({ question: "Approve draft?", context: "Secret-draft-body" })
    const output = setup([q]).render().join("\n")
    expect(output).toContain("Approve draft?")
    expect(output).toContain("Context is shown in the transcript")
    expect(output).not.toContain("Secret-draft-body")
  })

  test("single-block question has no transcript hint", () => {
    const output = setup([makeQuestion()]).render().join("\n")
    expect(output).not.toContain("shown in the transcript")
  })

  test("clips a very long final block to its last lines", () => {
    const block = Array.from({ length: 20 }, (_, index) => `- line-${index + 1}`).join("\n")
    const output = setup([makeQuestion({ question: `Intro\n\n${block}` })]).render().join("\n")
    expect(output).toContain("line-20")
    expect(output).not.toMatch(/line-1(?!\d)/)
    expect(output).toContain("...")
  })

  test("includes option description", () => {
    const { render } = setup([makeQuestion()])
    const output = render().join("\n")
    expect(output).toContain("Warm")
  })

  test("shows progress tabs for multi-question", () => {
    const q1 = makeQuestion()
    const q2 = makeQuestion({ question: "Size?", header: "Size", options: [{ label: "S" }] })
    const { render } = setup([q1, q2])
    const output = render().join("\n")
    expect(output).toContain("Color")
    expect(output).toContain("Size")
  })

  test("caching: same width returns cached lines", () => {
    const { render } = setup([makeQuestion()])
    const first = render(80)
    const second = render(80)
    expect(first).toBe(second)
  })

  test("invalidation: invalidate clears cache", () => {
    const { component, render } = setup([makeQuestion()])
    const first = render(80)
    component.invalidate()
    const second = render(80)
    expect(first).not.toBe(second)
  })
})

// --- Ctrl+S submit ---

describe("ctrl+s submit", () => {
  test("submits from option mode", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.ctrl("s"))
    const r = getResult()!
    expect(r.cancelled).toBe(false)
  })

  test("submits from editor mode", () => {
    const q = makeQuestion({ options: [{ label: "A" }] })
    const { send, getResult } = setup([q])
    send(Key.down)
    send(Key.enter) // enter editor
    for (const ch of "text") send(ch)
    send(Key.ctrl("s"))
    const r = getResult()!
    expect(r.cancelled).toBe(false)
    expect(r.answers).toEqual([["text"]])
  })

  test("advances to next question before last, submits on last", () => {
    const q1 = makeQuestion({ multiple: true })
    const q2 = makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }] })
    const { send, getResult } = setup([q1, q2])
    send(Key.enter) // toggle Red
    send(Key.ctrl("s")) // advance to Q2
    expect(getResult()).toBeUndefined()
    send(Key.enter) // select S -> review
    send(Key.enter) // submit
    expect(getResult()!.answers).toEqual([["Red"], ["S"]])
  })

  test("advances from editor mode before last question", () => {
    const q1 = makeQuestion({ multiple: true, options: [{ label: "A" }] })
    const q2 = makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }] })
    const { send, getResult } = setup([q1, q2])
    send(Key.down)
    send(Key.enter) // enter editor
    for (const ch of "x") send(ch)
    send(Key.ctrl("s")) // advance to Q2
    expect(getResult()).toBeUndefined()
    send(Key.ctrl("s")) // review on last
    send(Key.ctrl("s")) // submit from review
    expect(getResult()!.answers).toEqual([["x"], []])
  })

  test("footer shows next before last question, review on last", () => {
    const q1 = makeQuestion()
    const q2 = makeQuestion({ question: "Size", header: "Size", options: [{ label: "S" }] })
    const { send, render } = setup([q1, q2])
    const plain = () => render().join("\n").replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain()).toContain("ctrl+s next")
    send(Key.tab)
    expect(plain()).toContain("ctrl+s review")
  })

  test("single question footer still says submit", () => {
    const plain = setup([makeQuestion()]).render().join("\n").replace(/\x1b\[[0-9;]*m/g, "")
    expect(plain).toContain("ctrl+s submit")
    expect(plain).not.toContain("Submit ")
  })
})

// --- Ctrl+C cancel ---

describe("ctrl+c cancel", () => {
  test("cancels from option mode", () => {
    const { send, getResult } = setup([makeQuestion()])
    send(Key.ctrl("c"))
    expect(getResult()!.cancelled).toBe(true)
  })
})
