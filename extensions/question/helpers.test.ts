import { describe, test, expect } from "vitest"
import {
  normalizeAnswerSelection,
  normalizeQuestions,
  replaceAnswerSelection,
  sanitizeQuestionText,
  summarizeAnswers,
} from "./helpers.ts"
import { OTHER_OPTION_LABEL } from "./types.ts"

describe("sanitizeQuestionText", () => {
  test("removes terminal and bidi controls while preserving line breaks", () => {
    expect(sanitizeQuestionText("before\u001b[2J\r\nafter\u202e")).toBe("before[2J\nafter")
  })
})

describe("normalizeQuestions", () => {
  test("trims question fields and defaults multiple to false", () => {
    const questions = normalizeQuestions([
      {
        question: "  Which targets?  ",
        header: "  Targets  ",
        options: [{ label: "  iOS  ", description: "  Mobile  " }],
      },
      {
        question: "Pick extras",
        header: "Extras",
        multiple: true,
        options: [{ label: "Docs" }],
      },
    ])

    const first = questions[0]!
    const second = questions[1]!

    expect(first.question).toBe("Which targets?")
    expect(first.header).toBe("Targets")
    expect(first.multiple).toBe(false)
    expect(first.options).toEqual([{ label: "iOS", description: "Mobile" }])
    expect(second.multiple).toBe(true)
  })

  test("preserves indentation in multiline Markdown while removing boundary blank lines", () => {
    const q = normalizeQuestions([
      {
        question: "\n\n    const answer = 42\n\nChoose whether to keep it.\n\n",
        header: "Code",
        options: [],
      },
    ])[0]!
    expect(q.question).toBe("    const answer = 42\n\nChoose whether to keep it.")
  })

  test("strips undefined description to undefined", () => {
    const q = normalizeQuestions([{ question: "Q", header: "H", options: [{ label: "L" }] }])[0]!
    expect(q.options).toEqual([{ label: "L", description: undefined }])
  })

  test("handles empty options array", () => {
    const q = normalizeQuestions([{ question: "Q", header: "H", options: [] }])[0]!
    expect(q.options).toEqual([])
  })
})

describe("normalizeAnswerSelection", () => {
  test("removes sentinel and appends custom value", () => {
    expect(normalizeAnswerSelection(["A", OTHER_OPTION_LABEL], "Custom", ["A", "B"])).toEqual([
      "A",
      "Custom",
    ])
    expect(normalizeAnswerSelection([OTHER_OPTION_LABEL], "  ", ["A", "B"])).toEqual([])
  })

  test("drops stale incremental _other_ edits", () => {
    expect(
      normalizeAnswerSelection(
        ["TypeScript", "t", "te", "tec", OTHER_OPTION_LABEL],
        "tech equipment",
        ["TypeScript", "Rust"],
      ),
    ).toEqual(["TypeScript", "tech equipment"])
  })

  test("returns empty for empty values and empty custom", () => {
    expect(normalizeAnswerSelection([], "", ["A", "B"])).toEqual([])
  })

  test("returns empty for only sentinel and empty custom", () => {
    expect(normalizeAnswerSelection([OTHER_OPTION_LABEL], "", ["A", "B"])).toEqual([])
  })

  test("deduplicates custom matching a predefined option", () => {
    expect(
      normalizeAnswerSelection(["Alpha", OTHER_OPTION_LABEL], "Alpha", ["Alpha", "Beta"]),
    ).toEqual(["Alpha"])
  })

  test("custom only (no predefined selected)", () => {
    expect(normalizeAnswerSelection([OTHER_OPTION_LABEL], "my answer", ["X", "Y"])).toEqual([
      "my answer",
    ])
  })

  test("ignores values not in predefined options", () => {
    expect(normalizeAnswerSelection(["Ghost", "A"], "", ["A", "B"])).toEqual(["A"])
  })

  test("with empty predefined options list", () => {
    expect(normalizeAnswerSelection(["A", OTHER_OPTION_LABEL], "custom", [])).toEqual(["custom"])
    expect(normalizeAnswerSelection(["A"], "", [])).toEqual([])
  })
})

describe("summarizeAnswers", () => {
  test("formats unanswered and selected values", () => {
    const result = summarizeAnswers(
      [
        { question: "Which targets?", header: "Targets", options: [] },
        { question: "Need docs?", header: "Docs", options: [], multiple: true },
      ],
      [["iOS"], ["API", "CLI"]],
    )

    expect(result).toBe('1. "Targets"="iOS", 2. "Docs"="API, CLI"')
  })

  test("shows Unanswered for missing answer entries", () => {
    const result = summarizeAnswers([{ question: "Q1", header: "H1", options: [] }], [])
    expect(result).toBe('1. "H1"="Unanswered"')
  })

  test("shows Unanswered for empty answer array", () => {
    const result = summarizeAnswers([{ question: "Q1", header: "H1", options: [] }], [[]])
    expect(result).toBe('1. "H1"="Unanswered"')
  })

  test("handles single answer", () => {
    const result = summarizeAnswers(
      [{ question: "Color?", header: "Color", options: [] }],
      [["Blue"]],
    )
    expect(result).toBe('1. "Color"="Blue"')
  })

  test("disambiguates duplicate and empty headers by ordinal", () => {
    const result = summarizeAnswers(
      [
        { question: "First?", header: "Same", options: [] },
        { question: "Second?", header: "Same", options: [] },
        { question: "Third?", header: "", options: [] },
      ],
      [["A"], ["B"], ["C"]],
    )
    expect(result).toBe('1. "Same"="A", 2. "Same"="B", 3. "Question 3"="C"')
  })

  test("escapes quotes and newlines", () => {
    const result = summarizeAnswers(
      [{ question: 'Say "hi"?', header: "Prompt", options: [] }],
      [['line "one"\nline two']],
    )
    expect(result).toBe('1. "Prompt"="line \\"one\\"\\nline two"')
  })
})

describe("replaceAnswerSelection", () => {
  test("mutates the same Set instance in place", () => {
    const selected = new Set<string>()
    const reference = selected

    replaceAnswerSelection(selected, [], "", ["Alpha", "Beta"])
    selected.add("Alpha")
    replaceAnswerSelection(selected, Array.from(selected), "", ["Alpha", "Beta"])

    expect(selected).toBe(reference)
    expect(Array.from(selected)).toEqual(["Alpha"])
  })

  test("keeps custom sentinel while returning final custom text", () => {
    const selected = new Set<string>([OTHER_OPTION_LABEL])

    replaceAnswerSelection(selected, Array.from(selected), "hello", ["Alpha", "Beta"])

    expect(Array.from(selected)).toEqual(["hello", OTHER_OPTION_LABEL])
  })

  test("clears stale values when custom is removed", () => {
    const selected = new Set<string>(["old-custom", OTHER_OPTION_LABEL])

    replaceAnswerSelection(selected, selected, "", ["Alpha", "Beta"])

    expect(Array.from(selected)).toEqual([])
  })

  test("preserves predefined + custom together", () => {
    const selected = new Set<string>(["Alpha", OTHER_OPTION_LABEL])

    replaceAnswerSelection(selected, selected, "extra", ["Alpha", "Beta"])

    expect(Array.from(selected)).toEqual(["Alpha", "extra", OTHER_OPTION_LABEL])
  })
})
