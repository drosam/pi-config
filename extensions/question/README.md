# question

Pi extension that registers a `question` tool for interactive clarification.

## Tool

### `question`

Parameters:

- `questions` — array of questions
  - `question` — short decision prompt shown with the options
  - `context` — optional Markdown of any length (analysis, evidence, drafts, previews) shown in the transcript
  - `header` — short label used in progress tabs
  - `options` — predefined answer options
    - `label` — visible answer label
    - `description` — optional explanation
  - `multiple` — optional; when `true`, allows selecting more than one answer

Behavior:

- `context` renders in the transcript (scrollable, any length) and `question` renders above the options, so nothing is shown twice while the prompt is open
- without `context`, a multi-paragraph `question` renders fully in the transcript and only its final paragraph (last 8 lines at most) above the options
- with several questions, the transcript shows only the question on the active tab while the prompt is open
- completed questions collapse to a compact answer summary and expand to context plus question with Pi's `Ctrl+O` tool toggle
- terminal and bidirectional control characters in question text are removed before rendering
- questions are **single-select by default**
- set `multiple: true` to allow **multi-select**
- every question always includes a **`type your own answer`** option
- `type your own answer` supports free-form text input
- returns answers as arrays of selected labels in question order
- in **single-select** mode, `Enter` selects the current option and advances
- in **multi-select** mode, `Enter` toggles the current option and stays on the same question
- footer key hints are shown as: `⇆ tab • ↑↓ select • enter confirm/toggle • ctrl+s submit • esc dismiss`
- requires interactive UI mode

## Source of truth

- extension entry: `~/.pi/agent/extensions/question/index.ts`
- tool: `~/.pi/agent/extensions/question/question-tool.ts`
- UI: `~/.pi/agent/extensions/question/question-ui.ts`
- shared types/helpers: `~/.pi/agent/extensions/question/types.ts`
