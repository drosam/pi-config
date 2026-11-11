# Fewer Permission Prompts — Sources

Retrieved: 2026-10-08. Class: `workflow-process`. Shape: script-backed inventory plus human-reviewed policy workflow.

## Source inventory

| Source | Trust tier | Confidence | Contribution | Usage constraints |
| --- | --- | --- | --- | --- |
| Installed `@earendil-works/pi-coding-agent` 1.0.4 `docs/sessions.md`, `docs/session-format.md`, `docs/message-types.md`, `docs/skills.md` | canonical installed | high | Session roots, JSONL header/tree/tool-call schema, skill discovery | Version-specific; future session versions must fail visibly |
| Installed/local `pi-permission-system` 0.8.0 README, policy, matcher mirror, and logging source | canonical local implementation | high for inspected checkout | Ordered last-match policy, layered scope, review-event behavior, sensitive log risks | Checkout has unrelated local modifications; do not copy behavior into scanner or claim pristine upstream state |
| Claude Code commands/permissions docs and changelog | canonical upstream | high | Official purpose, introduction in 2.1.111, narrow-rule and shell-pattern hazards | Claude precedence and built-in auto-allows do not transfer to Pi |
| Public snapshot of Claude `fewer-permission-prompts/SKILL.md` in `asgeirtj/system_prompts_leaks` | secondary/untrusted | medium | Candidate extraction, frequency ranking, broad-execution exclusions | Unverified mirror; reuse concepts only, not text or claimed lineage |
| `oratis/deepcode` `fewer-permission-prompts` skill | secondary open source, MIT | medium-high | Approval-oriented history workflow, project-scope default, confirm-before-write | Different session/settings format; safety rules require strengthening |
| `volleio/claude-permissions-audit` and `chrismo/cc-audit` source | secondary open source, MIT | medium | Per-change review, provenance, duplicate/conflict concepts | Unsafe classifications and defaults were rejected |
| Agent Skills specification | canonical format | high | Frontmatter, relative resources, progressive disclosure | `disable-model-invocation` is a Pi extension, documented by installed Pi docs |
| Local `skill-writer` mode, synthesis, authoring, workflow, evaluation, and validation references | canonical local process | high | Required artifacts, process/failure coverage, registration and validation | Maintenance guidance; not runtime policy |

## Decisions

| Decision | Status | Rationale |
| --- | --- | --- |
| Scan every authorized root without age/session/project cap | adopted | Explicit user requirement; coverage counters make completeness reviewable |
| Require explicit roots rather than search the home directory | adopted | Minimizes privacy exposure and prevents accidental unrelated traversal |
| Scan raw session entries across all branches | adopted | Pi stores branches in one append-only tree; active-branch-only analysis would miss evidence |
| Emit per-run keyed HMAC identifiers and locators, not raw arguments or transcript-controlled names/paths | adopted | Supports exhaustive variant review while resisting low-entropy recovery and transcript data leakage |
| De-duplicate overlapping physical files and reliable cloned call identities | adopted | Prevents systematic inflation while avoiding fuzzy guesses |
| Treat frequency as safety or approval evidence | rejected | Sessions prove execution only; permission decisions may be absent |
| Infer MCP safety from names | rejected | Names are not behavior contracts and future wildcard matches can broaden authority |
| Copy Claude allow syntax/precedence into Pi | rejected | Pi permission policy has different ordered matching and layering semantics |
| Add an auto-approval extension or model classifier | rejected | User requested a reusable history-checking skill; another enforcement layer adds risk and complexity |
| Persist reports by default | rejected | Project paths, hashes, and source locators remain sensitive metadata |

## Coverage matrix

| Dimension | Coverage status | Evidence |
| --- | --- | --- |
| Preconditions and required context | complete | Explicit roots, exclusions, active policies, tool semantics |
| Ordered execution flow | complete | Resolve → inventory → coverage gate → review → propose → approve → apply → verify |
| Failure handling and recovery | complete | Root, version, malformed, oversized, sensitive-content, and policy-resolution branches |
| Safety and permission boundaries | complete | No execution/network/write in scanner; no automatic broadening; deny preservation |
| Outputs and acceptance checks | complete | Structured inventory, opaque identifiers, alias/symlink controls, ranked proposal schema, synthetic tests, strict validator target |
| Escalation and handoff | complete | Ask for roots/access/scope; stop on fatal or unresolved policy |
| Happy path | complete | `references/examples.md` exact inspection rule |
| Secure/guarded path | complete | Executable project test remains reviewable |
| Anti-pattern and correction | complete | MCP wildcard rejected and narrowed |
| Version/platform variance | complete | Versions 1–3 accepted; future versions reported unsupported; filesystem symlinks guarded |

Selected profile: `skill-writer/references/examples/workflow-process-skill.md`. Preconditions, sequencing, safety, failure recovery, deterministic output, and guarded examples are represented.

## Open gaps

- Permission-review logs are implementation-specific and may contain raw sensitive inputs; the skill treats them as optional corroboration rather than a required scan source.
- Session execution does not prove whether a human prompt occurred. Reports must distinguish actual corroborated prompts from likely prompts.
- Textual command matching cannot provide an OS sandbox or fully understand executable behavior.
- Quantitative prompt reduction remains unmeasured until the skill is run on authorized real history and compared after selected policy changes.

## Retrieval stopping rationale

Canonical Pi session schemas, current local policy behavior, the official Claude feature contract, two reusable open-source workflows, safety counterexamples, and the Agent Skills format cover every high-impact workflow dimension. Further repository collection is low-yield before a real authorized run exposes concrete matcher or session-version gaps.
