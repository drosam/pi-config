# Examples

## Happy path: narrow inspection rule

Evidence:

- 18 calls across one project.
- All fingerprints resolve to exact `git status` or `git status --short` invocations.
- Effective project policy currently asks.
- No wrapper, configuration override, shell operator, redirection, or external directory appears.

Proposal:

```text
Scope: project
Rules:
- git status → allow
- git status --short → allow
Boundary: exact observed invocations only; broader Git forms remain ask/deny.
```

Apply only after the operator selects them. Verify the final ordered matches for both exact invocations and confirm shell suffixes, additional flags, and neighboring Git commands still ask or deny.

## Guarded path: recurring tests remain reviewable

Evidence:

- `pnpm test` appears 31 times across seven projects.
- Each project controls its own package scripts.
- Some variants add filters; one project runs setup hooks.

Result:

```text
Skipped: pnpm test *
Reason: a task-runner wildcard executes repository-controlled code and crosses project trust boundaries.
Alternative: keep ask, or consider an exact project-local invocation only after explicit operator review.
```

Frequency does not convert executable project code into a global low-risk operation.

## Anti-pattern and correction

Bad:

```text
mcp__github__get_* → allow
```

Why bad:

- The name is not a behavior contract.
- A wildcard can include future tools with different inputs or effects.
- The server implementation or credentials may change.

Corrected:

```text
No proposal until the exact tool schema and canonical behavior are verified.
If verified, propose one exact tool name at project scope and document permitted inputs; otherwise retain ask.
```

## Failure recovery: incomplete scan

Coverage reports 420 sessions scanned, two unreadable files, and one unsupported future session version.

Correct response:

```text
Coverage: partial. 420 sessions analyzed; three sessions/records were not analyzable.
Proposals are based on available evidence and are not an all-session result.
Next action: grant access or update the parser, then rerun before applying rules affected by those projects.
```

Do not silently call the result complete or discard the usable evidence.
