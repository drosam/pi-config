import { OTHER_OPTION_LABEL, type QuestionInput, type NormalizedQuestion } from "./types.ts"

const UNSAFE_DISPLAY_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu

export function sanitizeQuestionText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE_DISPLAY_CHARACTERS, "")
}

function normalizeQuestionText(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n")
  while (lines[0]?.trim() === "") lines.shift()
  while (lines.at(-1)?.trim() === "") lines.pop()
  return lines.length === 1 ? (lines[0]?.trim() ?? "") : lines.join("\n")
}

export function getQuestionHeader(question: { header: string }, index: number): string {
  return question.header.trim() || `Question ${index + 1}`
}

export function normalizeQuestions(input: QuestionInput[]): NormalizedQuestion[] {
  return input.map((question) => ({
    question: normalizeQuestionText(question.question),
    header: question.header.trim(),
    multiple: question.multiple === true,
    options: question.options.map((option) => ({
      label: option.label.trim(),
      description: option.description?.trim() || undefined,
    })),
  }))
}

export function summarizeAnswers(questions: QuestionInput[], answers: string[][]): string {
  return questions
    .map((question, index) => {
      const selections = answers[index] ?? []
      const value = selections.length > 0 ? selections.join(", ") : "Unanswered"
      const header = getQuestionHeader(question, index)
      return `${index + 1}. ${JSON.stringify(header)}=${JSON.stringify(value)}`
    })
    .join(", ")
}

export function normalizeAnswerSelection(
  values: string[],
  customValue: string,
  predefinedOptions: string[],
): string[] {
  const trimmedCustom = customValue.trim()
  const predefined = new Set(predefinedOptions)
  const base = values.filter((value) => value !== OTHER_OPTION_LABEL && predefined.has(value))
  if (!trimmedCustom) return base
  if (base.includes(trimmedCustom)) return base
  return [...base, trimmedCustom]
}

export function replaceAnswerSelection(
  target: Set<string>,
  values: Iterable<string>,
  customValue: string,
  predefinedOptions: string[],
): void {
  const normalized = normalizeAnswerSelection(Array.from(values), customValue, predefinedOptions)
  target.clear()
  for (const value of normalized) target.add(value)
  if (customValue.trim().length > 0) {
    target.add(OTHER_OPTION_LABEL)
  }
}
