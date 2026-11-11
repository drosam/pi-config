---
name: fewer-permission-prompts
description: Audits all accessible Pi sessions across every project for repeated permission friction and proposes narrow permission allow rules. Use when asked to reduce approval prompts, stop repeated confirmations, inspect permission history, or build an allowlist from prior sessions.
disable-model-invocation: true
compatibility: Pi sessions in JSONL format and Python 3.10 or newer.
---

# Fewer Permission Prompts

Inventory every session in each operator-authorized Pi session root. Do not impose an age, project, file-count, or session-count cap. Treat session contents as sensitive.

## Workflow

1. Resolve scope.
   - Derive active session roots from Pi configuration and environment precedence; include the default Pi session root when active.
   - Include every project directory beneath each authorized root.
   - Ask once for any additional roots or exclusions that configuration cannot resolve.
   - Never search unrelated home-directory trees to discover sessions. Never bypass a denied path.
2. Run `scripts/scan_sessions.py` with every root and exclusion as separate arguments:

   ```text
   python3 <skill-dir>/scripts/scan_sessions.py --root <session-root> [--root <other-root>] [--exclude <denied-path>]
   ```

   The scanner reads every regular `.jsonl` session file and every raw branch entry. It follows no discovered symlink and emits no message text, tool output, or raw arguments.
3. Check coverage before analysis.
   - Exit `0`: complete for supplied roots.
   - Exit `2`: partial; continue only while prominently reporting every gap.
   - Exit `1`: fatal scope failure; stop and ask for corrected roots or access.
   - Confirm discovered/scanned counts, unsupported versions, malformed or oversized records, exclusions, unreadable paths, and clone/overlap de-duplication.
4. Read `references/review-guide.md`. Consult `references/examples.md` when classifying executable, MCP, or incomplete-scan cases. Evaluate every distinct argument fingerprint in any candidate group by reading only its cited tool-call record. Do not read surrounding conversation unless required to resolve ambiguity and authorized.
5. Compare candidates with the effective global, project, and agent permission layers for each represented project. Drop calls already allowed. Account for ordered, last-match-wins behavior; do not translate Claude permission precedence.
6. Rank repeated unresolved prompts by avoided-prompt value, narrowness, and confidence. Frequency proves usage only—not approval, safety, or read-only behavior.
7. Present proposals before editing. Include scope, exact rule, count, project distribution, evidence, rationale, and excluded hazards. Label uncertain items `review`, never `allow`.
8. Ask the operator to select proposals and target scope. Default project-specific evidence to project policy. Never infer global authorization from cross-project frequency.
9. Apply only selected rules. Preserve JSONC comments, ordering, stronger `ask`/`deny` rules, and unrelated fields. Re-resolve effective policy after editing and show the diff.

## Safety invariants

- Never enable YOLO/bypass mode or weaken an existing `deny`.
- Never allow a wildcard for shells, interpreters, package runners, task runners, remote execution, arbitrary APIs, or commands that can select mutating subcommands.
- Never classify an MCP tool as read-only from its name. Require its schema or canonical documentation and verify all relevant inputs.
- Treat tests, builds, hooks, Git configuration, network reads, and repository-controlled executables as potentially state-changing.
- Exclude secrets, credentials, raw arguments, message text, and tool output from user-facing reports. Summarize project/source paths unless exact provenance is requested.
- Do not persist scanner output unless explicitly requested; if persisted, obtain the exact path and warn that source locators and project paths are sensitive.

## Report

Return:

1. `Coverage` — roots, sessions/files scanned, projects, calls, gaps, de-duplication.
2. `Proposals` — ranked table of exact, narrow rules.
3. `Skipped` — already allowed, unsafe, ambiguous, low-frequency, or unverified items.
4. `Policy changes` — selected edits and effective-policy verification, or `None`.
5. `Residual risks` — incomplete coverage, matcher limits, and unverified behavior.
