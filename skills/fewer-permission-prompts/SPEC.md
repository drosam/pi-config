# Fewer Permission Prompts — Specification

## Scope

Create a manual Pi workflow that inventories all sessions in every explicitly authorized session root, across all projects and branches, then proposes narrowly scoped permission rules. No age, recency, project, file-count, or session-count scan cap is permitted.

Out of scope: automatic approval, YOLO/bypass modes, sandboxing, permission enforcement, inferred global authorization, and silent policy writes.

## Inputs

- One or more operator-authorized Pi session roots.
- Optional excluded paths representing denied or unwanted scope.
- Effective global, project, and agent permission policies.
- Optional canonical schemas/documentation for candidate MCP or extension tools.

## Outputs

- Machine-readable usage inventory containing coverage, conservative labels, per-run opaque argument fingerprints, opaque project identifiers, project counts, and source locators.
- Human-reviewed proposals with exact rule, evidence, target scope, and risk boundary.
- Explicit skipped items and coverage gaps.
- Policy diff and effective-match verification only after operator selection.

## Safety invariants

- Read session data without modifying it, following discovered symlinks, executing transcript content, or making network calls.
- Never emit raw arguments, conversation text, thinking, tool results, or secrets from the inventory helper.
- Treat frequency and names as usage evidence only.
- Never weaken denies or propose broad arbitrary-execution, mutating-selector, network, or unverified MCP patterns.
- Require approval before any policy edit; preserve comments and ordered matching.

## Evidence

Every candidate must trace to all distinct observed argument fingerprints, representative file/line locators, opaque project distribution, and the resolved effective policy. Duplicate physical files and reliable cloned call identities must not inflate counts; clone provenance must retain every represented project. Partial scans must not be described as complete.

## Acceptance checks

1. More than 50 synthetic sessions and old timestamps are all processed.
2. Multiple projects and raw branch entries are represented.
3. Overlapping roots and cloned tool calls do not inflate totals.
4. Missing, excluded, symlinked, malformed, oversized, and unsupported inputs produce bounded gaps.
5. Raw secrets, transcript-controlled project paths/tool names, and arguments do not appear in scanner output.
6. Excluded roots and symlink aliases cannot reopen denied scope; discovered symlinks and replaced files are not followed.
7. Arbitrary JSONL without a Pi session header is ignored.
8. No policy changes occur without explicit selection.
9. Skill validation passes as `workflow-process` with strict depth.

## Limitations

Pi session files record tool execution, not a complete permission-decision ledger. A proposal may therefore represent a likely prompt unless corroborated by permission-review events. Per-run HMAC identifiers distinguish variants only within one report and require targeted source inspection for semantics. Source locator paths remain sensitive operator metadata. Text-pattern permission systems are policy gates, not OS sandboxes.
