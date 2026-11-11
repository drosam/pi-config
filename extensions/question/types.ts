export const QUESTION_EXTENSION_NAME = "question"
export const OTHER_OPTION_LABEL = "_other_"
export const OTHER_OPTION_DISPLAY_LABEL = "Type your own answer"

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionInput {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
}

export interface NormalizedQuestion extends QuestionInput {
  options: QuestionOption[]
  multiple: boolean
}

export interface QuestionResultDetails {
  cancelled: boolean
  questions: Array<{
    question: string
    header: string
    options: string[]
    multiple: boolean
  }>
  answers: string[][]
}
