# Local task agents

This extension evolves the repository's existing subprocess-based task tool. Task lifecycle, RPC transport, and UI are built on Pi's documented RPC protocol.

## Usage

Existing foreground calls stay valid:

```ts
task({
  description: "Find authentication flow",
  prompt: "Trace authentication from routes to persistence. Read-only.",
  subagent_type: "explore",
})
```

Return immediately while independent work continues:

```ts
task({
  description: "Investigate test coverage",
  prompt: "Find coverage gaps in the changed module. Read-only.",
  subagent_type: "explore",
  background: true,
})
```

Every call returns a full task ID. Background completion arrives as a parent follow-up message; do not poll routinely.

```ts
task_control({ action: "list" })
task_control({ action: "status", id: "<task-id>" })
task_control({ action: "steer", id: "<task-id>", message: "Focus on the retry path." })
task_control({ action: "cancel", id: "<task-id>" })
task({ description: "Explain retry findings", prompt: "Why does this retry fail?", resume: "<task-id>" })
```

- `task_list` still lists agent definitions, not running tasks.
- `background` defaults to `false`, including resumed calls.
- Resume retains the child conversation and ID, increments its run number, and resolves the current agent definition and caller model defaults. Missing or invalid saved sessions fail instead of silently starting fresh.
- An active task cannot be resumed concurrently. Steering is accepted after its subprocess is ready, and takes effect at Pi's next steering boundary, not midway through a tool.
- `status` consumes a finished result and suppresses an unsent completion notification. A notification already queued to the parent can still arrive.

## Visual controls

Use `/tasks` for a searchable task browser. Task names lead, with status and elapsed time alongside them. Selection reveals agent details and a result/activity preview; wide terminals use a side-by-side layout. Search text and selection survive an action and return to the browser. Resume from this browser starts background work.

Default browser keys:

| Key | Action |
| --- | --- |
| Up/Down, Page Up/Down | Move selection |
| Enter | Inspect transcript |
| Tab | Switch All / Active / History |
| Alt+R | Resume a finished task |
| Alt+S | Steer an active, non-queued task |
| Alt+X | Cancel an active task, with confirmation |
| Alt+F | Show or hide the fleet and close the browser |
| Escape | Close or return from transcript inspection |

Navigation honors Pi's configured keybindings. Ordinary typing filters task names, agent types, and status. RPC clients retain native selection dialogs instead of a terminal-only screen.

The fleet sits below the editor as a tree: agent name, description, and elapsed time per row, a spinner for running work, colored icons for other states, and a dim sub-line with live activity (`thinking...`, `bash sleep 60`, `needs input`). Rows stay in launch order. Queued work collapses into one summary row; finished rows linger for a few seconds and then drop out. Up to six rows render before an overflow count. It disappears when nothing is running. Use `/tasks toggle` to show or hide it.

Press Down at an empty prompt to enter the fleet. Up/Down select, Enter opens the live transcript, `x` cancels, Esc or Up past the first row returns to the prompt. The transcript viewer auto-follows new output; scrolling up pauses following and `e` resumes it. From the viewer, `s` steers, `x` cancels, and `r` resumes a finished task. Full IDs remain available through `task_control`.

Transcript viewing wraps long lines and supports arrow-key and page scrolling. The viewer loads files only on demand and refuses files larger than 8 MiB. The session file remains available for full inspection.

## Lifecycle and storage

- At most four workers run concurrently per parent process; excess calls queue. Nested workers have their own parent-local limit, not a global machine-wide limit.
- Each parent owns its task IDs. Metadata follows its active session branch. Tasks from another parent session, including a fork, are not adopted.
- Child Pi sessions live in `~/.pi/agent/task-sessions/<parent-hash>/<task-id>.jsonl` (respecting `PI_CODING_AGENT_DIR`). Metadata is saved in the parent session, not this repository.
- Reload, branch navigation, session replacement, and shutdown cancel owned workers. Recovered active work is marked `interrupted`; nothing restarts automatically. Explicit resume can continue a saved conversation.
- Background results are acknowledged when their completion message reaches the parent transcript. Recovery also checks recorded delivery messages to avoid replaying acknowledged results. A completion queued but never delivered is eligible for redelivery after reload.
- Sessions retain at most 200 task identities; start a new parent session after that limit. Completed in-memory results and durable result summaries are bounded. Complete child history remains in its session file. Session files are not automatically deleted.
- Queued cancellation never launches the child. Running cancellation clears steering/follow-up queues before aborting, then waits for subprocess cleanup with TERM/KILL escalation.
- A small child-only lifetime extension is always loaded, including when other extensions are disabled. It aborts work when the owning process disappears and enforces an exit deadline; it registers no tools or commands.

## Permissions and boundaries

Shared agent discovery, provider-specific model maps, extension selection, and normal Pi context-file loading remain supported. No new dependency or permission configuration is required.

Children inherit the parent's project-trust decision. Supported RPC `select`, `confirm`, and `input` dialogs are serialized, labeled with the worker, and forwarded to the parent UI. Without a UI, on cancellation, or on dialog failure, requests are denied/cancelled, never auto-approved. Dialog timeouts include queue time.

RPC does not support custom TUI dialogs. Extensions that require `ctx.ui.custom()` (including some permission/question UIs) may refuse or be unavailable in a worker; this bridge does not bypass them. RPC editor requests are cancelled because Pi's editor API cannot be dismissed with an abort signal. Do not interpret an unsupported interaction as approval.

Separate processes isolate context and runtime, not operating-system permissions or files. Workers share the checkout and environment. Avoid overlapping edits; use read-only tools for read-only work. No scheduling, automatic Git commits, worktrees, workflow language, or persistent agent memory is added.

## Validation

```sh
pnpm exec vitest run extensions/subagent
pnpm test
```

Use `/reload` after changing the extension. Live TUI appearance and compatibility with each installed permission extension require interactive acceptance checks; mocked protocol tests do not establish that compatibility.
