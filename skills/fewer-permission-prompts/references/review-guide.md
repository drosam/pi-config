# Review Guide

## Evidence model

The scanner groups calls by safe tool identifier and conservative command label. Each distinct argument object has a per-run HMAC fingerprint and up to three source locators. Transcript-controlled project paths and extension tool names become opaque identifiers. Group and variant totals are exhaustive; locator samples are bounded.

Before proposing a rule:

1. Inspect at least one cited record for every fingerprint in the group.
2. Extract only the tool call's name and relevant arguments.
3. Do not quote secrets, free-form queries, URLs with tokens, user messages, or results.
4. Verify whether the effective policy would currently ask for that exact call.
5. Keep separate variants separate when flags, paths, hosts, subcommands, or tool inputs change authority.

A repeated call is not evidence that the operator approved it. Session JSONL records execution, not the permission decision that preceded it. If structured permission-review events are available, use them only as corroboration and apply the same confidentiality rules.

## Candidate thresholds

- Prefer calls observed at least three times.
- Rank by likely prompts avoided; do not truncate scanning or classification.
- Show at most 20 proposals initially, then state how many lower-ranked reviewed candidates remain.
- An exact rule is preferred over a wildcard.
- A wildcard is acceptable only when every matched variation has the same verified, low-risk behavior and no argument can introduce execution, mutation, network expansion, or secret access.

## Required rejection checks

Reject or retain `ask` when any condition applies:

| Condition | Examples |
| --- | --- |
| Arbitrary execution | shells, interpreters, `eval`, `exec`, `ssh`, inline code |
| Package/task dispatch | broad `npm`, `pnpm`, `npx`, `bun`, `make`, `just`, language task runners |
| Mutating selector | broad `git *`, `gh *`, `docker *`, `kubectl *`, command families with write flags |
| Hidden execution/write | substitutions, pipes, redirects, heredocs, `xargs`, `find -exec/-delete`, config-controlled hooks |
| Unbounded network/API | arbitrary URL tools, `gh api`, mutable MCP operations |
| Sensitive access | credentials, tokens, keychains, `.env`, private home data, production/customer data |
| Unverified plugin/MCP semantics | tool name looks like `get`/`read`, but schema and implementation are unknown |
| Project-controlled execution | tests, builds, linters, scripts, hooks, binaries from the repository |
| Policy ambiguity | unknown project layer, malformed policy, unsupported matcher behavior |

Commands that usually inspect state can still mutate through flags or configuration. Verify the complete invocation and relevant runtime behavior; never approve from the command label alone.

## Scope choice

- `project`: default for project tools, paths, scripts, tests, and MCP servers.
- `global`: use only when the operator explicitly selects it and the rule is safe independent of repository content.
- `agent`: use only for a named agent whose bounded role justifies the rule.

Cross-project frequency supports prioritization, not global scope. A project policy may tighten global policy and must never relax a trusted global deny.

## Proposal format

| Rank | Scope | Rule | Calls | Projects | Confidence | Evidence | Risk boundary |
| --- | --- | --- | ---: | ---: | --- | --- | --- |
| 1 | project | `git status` | 24 | 1 | high | 1 fingerprint; effective policy asks | Exact invocation only |

For every proposal, state:

- why the operation is low-risk in that scope;
- which variants were reviewed;
- what broader neighboring pattern was rejected;
- where a later `ask` or `deny` must remain in ordered policy;
- whether the rule avoids actual recorded prompts or only likely prompts.

## Failure and recovery

- Missing/unreadable roots: stop on total failure; otherwise report partial coverage and do not claim an all-session audit.
- Unsupported session version: skip that session, name the version, and request a parser update.
- Malformed/oversized record: skip only that record, retain other evidence, and lower confidence for affected groups.
- Sensitive content encountered during targeted inspection: do not reproduce it; classify the candidate as unsafe or ambiguous.
- Policy cannot be resolved: present usage inventory only; make no allow recommendation.
- Validation mismatch after editing: revert only the proposed edit if authorized; otherwise report the mismatch and stop.
