import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent"
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"
import {
  getQuestionHeader,
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
    description: "Complete Markdown prompt, including any background needed to decide",
  }),
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

export function createQuestionTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof QuestionParams, QuestionResultDetails> {
  return {
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more questions. Complete Markdown prompts render above their options, and completed results retain expandable question context. Questions are single-select by default, support a type-your-own-answer option, and can allow multiple selections when multiple=true. Use this to clarify requirements or gather choices during execution.",
    promptSnippet:
      "Ask one or more user questions with complete Markdown prompts, single-select by default, optional multiple selection, and a type-your-own-answer option.",
    promptGuidelines: [
      "Use this tool when you need clarification, preferences, or implementation choices from the user.",
      "When a decision depends on analysis or evidence, include all background needed to decide in the question field and end with one focused question; do not rely on private reasoning or separate narration.",
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        const details: QuestionResultDetails = {
          cancelled: true,
          questions: params.questions.map((question) => ({
            question: question.question,
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
      pi.events.emit("herdr:blocked", { active: true, label: "Waiting for answer" })
      try {
        result = await ctx.ui.custom<{ cancelled: boolean; answers: string[][] }>(
          (tui, theme, _kb, done) =>
            createQuestionPromptComponent({ tui, theme, questions, onDone: done }),
        )
      } finally {
        pi.events.emit("herdr:blocked", { active: false })
      }

      const details: QuestionResultDetails = {
        cancelled: result.cancelled,
        questions: questions.map((question) => ({
          question: question.question,
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
    renderCall(args, theme) {
      const count = Array.isArray(args.questions) ? args.questions.length : 0
      return new Text(
        theme.fg("toolTitle", theme.bold("question ")) +
          theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
        0,
        0,
      )
    },
    renderResult(result, options, theme, context) {
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
      if (!options.expanded) {
        const lines = details.questions.map((question, index) => {
          const answers = details.answers[index] ?? []
          const value = answers.length > 0 ? answers.join(", ") : "Unanswered"
          const header = `${index + 1}. ${getQuestionHeader(question, index)}`
          return `${theme.fg("accent", header)}: ${theme.fg("muted", sanitizeQuestionText(value))}`
        })
        return new Text(lines.join("\n"), 0, 0)
      }

      const container = new Container()
      details.questions.forEach((question, index) => {
        const answers = details.answers[index] ?? []
        const value = answers.length > 0 ? answers.join(", ") : "Unanswered"
        container.addChild(
          new Markdown(
            sanitizeQuestionText(question.question),
            0,
            0,
            createMarkdownTheme(theme),
          ),
        )
        container.addChild(new Spacer(1))
        container.addChild(
          new Text(
            `${theme.fg("success", theme.bold("Answer:"))} ${sanitizeQuestionText(value)}`,
            0,
            0,
          ),
        )
        if (index < details.questions.length - 1) container.addChild(new Spacer(1))
      })
      return container
    },
  }
}
