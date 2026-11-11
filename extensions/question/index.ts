import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { createQuestionTool } from "./question-tool.ts"

export default function questionExtension(pi: ExtensionAPI) {
  pi.registerTool(createQuestionTool(pi))
}
