import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"
import {
  getQuestionHeader,
  getTranscriptText,
  normalizeQuestions,
  sanitizeQuestionText,
  summarizeAnswers,
} from "./helpers.ts"
import { createMarkdownTheme, createQuestionPromptComponent } from "./question-ui.ts"
import {
  OTHER_OPTION_DISPLAY_LABEL,
  type QuestionInput,
  type QuestionResultDetails,
} from "./types.ts"

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional explanation for this option" })),
})

const QuestionSchema = Type.Object({
  question: Type.String({
    description: "Short, focused decision prompt shown with the options",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Markdown of any length with everything needed to decide (analysis, evidence, drafts, exact previews), shown in the transcript",
    }),
  ),
  header: Type.String({ description: "Short label for progress tabs" }),
  options: Type.Array(OptionSchema, { description: "Available predefined options" }),
  multiple: Type.Optional(
    Type.Boolean({ description: "Allow selecting multiple answers for this question" }),
  ),
})

const QuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description:
      "Questions to ask. Questions are single-select by default and support a custom answer; set multiple=true to allow selecting more than one option.",
    minItems: 1,
  }),
})

// Links an open prompt to its transcript row so the row shows only the active question.
const activeQuestionByCall = new Map<string, number>()
const rowInvalidators = new Map<string, () => void>()

export function createQuestionTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof QuestionParams, QuestionResultDetails> {
  return {
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more questions. Optional Markdown context of any length is shown in the scrollable transcript and the short question is shown with the options; completed questions collapse to their answers and expand to the context and question. Questions are single-select by default, support a type-your-own-answer option, and can allow multiple selections when multiple=true. Use this to clarify requirements or gather choices during execution.",
    promptSnippet:
      "Ask one or more user questions with optional Markdown context, single-select by default, optional multiple selection, and a type-your-own-answer option.",
    promptGuidelines: [
      "Use this tool when you need clarification, preferences, or implementation choices from the user.",
      "When a decision depends on analysis, evidence, drafts or previews, put all of that content in the context field, at any length, and keep question to the short decision prompt. Do not put it in separate narration or private reasoning, and do not refer to content 'above' instead of including it; reasoning is not visible to the user.",
      "Keep option labels and descriptions concise when the question contains detailed context.",
      "Questions are single-select by default; set multiple=true only when the user should choose more than one option.",
      "Every question supports entering a custom answer; do not simulate user answers yourself.",
    ],
    parameters: QuestionParams,
    style: {
      paddingX: 1,
      paddingY: 0,
      pendingBg: null,
      successBg: null,
      errorBg: null,
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        const details: QuestionResultDetails = {
          cancelled: true,
          questions: params.questions.map((question) => ({
            question: question.question,
            context: question.context,
            header: question.header,
            options: [
              ...question.options.map((option) => option.label),
              OTHER_OPTION_DISPLAY_LABEL,
            ],
            multiple: question.multiple === true,
          })),
          answers: [],
        }
        return {
          content: [{ type: "text", text: "Error: question requires interactive UI mode" }],
          details,
        }
      }

      const questions = normalizeQuestions(params.questions as QuestionInput[])
      let result: { cancelled: boolean; answers: string[][] }
      const showQuestion = (index: number) => {
        activeQuestionByCall.set(toolCallId, index)
        rowInvalidators.get(toolCallId)?.()
      }
      pi.events.emit("herdr:blocked", { active: true, label: "Waiting for answer" })
      try {
        showQuestion(0)
        result = await ctx.ui.custom<{ cancelled: boolean; answers: string[][] }>(
          (tui, theme, _kb, done) =>
            createQuestionPromptComponent({
              tui,
              theme,
              questions,
              onDone: done,
              onQuestionChange: showQuestion,
            }),
        )
      } finally {
        activeQuestionByCall.delete(toolCallId)
        pi.events.emit("herdr:blocked", { active: false })
      }

      const details: QuestionResultDetails = {
        cancelled: result.cancelled,
        questions: questions.map((question) => ({
          question: question.question,
          context: question.context,
          header: question.header,
          options: [...question.options.map((option) => option.label), OTHER_OPTION_DISPLAY_LABEL],
          multiple: question.multiple,
        })),
        answers: result.answers,
      }

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the question prompt." }],
          details,
        }
      }

      const summary = summarizeAnswers(questions, result.answers)
      return {
        content: [{ type: "text", text: `User answered: ${summary}` }],
        details,
      }
    },
    renderCall(args, theme, context) {
      const questions: Array<Partial<QuestionInput> | undefined> = Array.isArray(args.questions)
        ? args.questions
        : []
      const count = questions.length
      const title = new Text(
        theme.fg("toolTitle", theme.bold("question ")) +
          theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
        0,
        0,
      )
      if (context.isPartial) rowInvalidators.set(context.toolCallId, context.invalidate)
      else rowInvalidators.delete(context.toolCallId)
      if (!context.isPartial && !context.expanded) return title

      const open = context.isPartial && !context.expanded
      const active = open ? activeQuestionByCall.get(context.toolCallId) : undefined
      const container = new Container()
      container.addChild(title)
      questions.forEach((question, index) => {
        if (typeof question?.question !== "string") return
        if (active !== undefined && index !== active) return
        const parts = {
          question: question.question,
          context: typeof question.context === "string" ? question.context.trim() : undefined,
        }
        const text = getTranscriptText(parts, open)
        if (!text && count === 1) return
        container.addChild(new Spacer(1))
        if (count > 1) {
          const header = getQuestionHeader({ header: question.header ?? "" }, index)
          const label = `${header} (${index + 1} of ${count})`
          container.addChild(new Text(theme.fg("accent", theme.bold(label)), 0, 0))
        }
        if (text) {
          container.addChild(
            new Markdown(sanitizeQuestionText(text), 0, 0, createMarkdownTheme(theme)),
          )
        }
      })
      return container
    },
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        const msg = result.content.find((c: any) => c.type === "text")?.text || "Failed"
        return new Text(theme.fg("error", msg), 0, 0)
      }
      const details = result.details as QuestionResultDetails | undefined
      if (!details) {
        const part = result.content.find((item) => item.type === "text")
        return new Text(part?.type === "text" ? part.text : "", 0, 0)
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0)
      }
      // The full prompt is rendered by renderCall when expanded.
      const lines = details.questions.map((question, index) => {
        const answers = details.answers[index] ?? []
        const value = answers.length > 0 ? answers.join(", ") : "Unanswered"
        const header = `${index + 1}. ${getQuestionHeader(question, index)}`
        return `${theme.fg("accent", header)}: ${theme.fg("muted", sanitizeQuestionText(value))}`
      })
      return new Text(lines.join("\n"), 0, 0)
    },
  }
}
