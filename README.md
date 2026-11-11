# Pi configuration and work artifacts

Repo config: `pi/dot-pi/agent/`; live config: `~/.pi/agent/` through Stow. Shared skills live in `skills/dot-agents/skills/` and are exposed through `~/.agents/skills/`. Pi-specific skills live in `pi/dot-pi/agent/skills/`. Installed Pi 0.87.1 discovers both locations; no extra settings registration is needed. After skill changes use `/reload`; start a fresh session to ensure changed SYSTEM.md instructions are loaded.

## Local work area

All paths below are relative to the **target project repository**, not the dotfiles repo or installed skill directory:

```text
.agent-work/
  work/<work-id>/
    spec.md                       # what and why; acceptance criteria
    plan.md                       # how; design, constraints, validation
    tickets/index.md              # breakdown outline, statuses, coverage
    tickets/NN-<slug>.md          # one reviewed ticket per file
  context/CONTEXT.md              # shared domain glossary
  context/CONTEXT-MAP.md          # optional multi-context map
  context/<context>/CONTEXT.md    # optional per-context glossary
  decisions/NNNN-<decision>.md    # approved architecture decisions
```

Use a stable kebab-case `<work-id>` matching the documents' Work-ID. Keep each work item's spec and plan together; shared domain context and ADRs stay outside individual work directories. Default to one `spec.md` and one `plan.md`. Only when explicitly needed and approved, use `specs/` and/or `plans/` within that work directory for multiple documents, with actual relative links. Do not reorganize existing files automatically.

Create lazily, only as needed. The managed global excludes file (`gitconfig/dot-config/git/ignore`, stowed to `~/.config/git/ignore`) ignores `.agent-work/` in every repository, so untracked artifacts stay out of normal `git status` and `git add .`. Do not add per-repository ignore rules. Never stage/commit these artifacts; if legacy, tracked, or force-added content is staged, stop and ask without silently unstaging. Avoid secrets and customer data.

This convention governs generated working documents, not application source, tests, user-requested project documentation, or skill implementation files. Existing project docs remain useful evidence. Do not migrate earlier flat work-area layouts, `.prd/`, `docs/design/`, project glossaries or ADRs, or overwrite existing files automatically. Confirm legacy document selection and any migration first; preserve inbound links when moving an approved artifact.

## Commands

| Skill | Purpose | Output |
| --- | --- | --- |
| `create-plan` | Research and agree technical design | `.agent-work/work/<work-id>/plan.md` |
| `to-feature-spec` (formerly `to-prd`) | Capture agreed requirements, not a new interview | `.agent-work/work/<work-id>/spec.md` |
| `feature-spec-breakdown` (formerly `feature-spec-to-todos`) | Agree slice list, review each ticket, then optionally create todos or publish to a named tracker | `.agent-work/work/<work-id>/tickets/`; todos with `spec:<Work-ID>` prefix |
| `grill-with-docs` | Challenge design, settle terms, offer significant ADRs | `.agent-work/context/` and `decisions/` |

Plan → spec → tickets is optional. A spec can precede its plan; simple work can have neither. Planning, document selection, and design approval never imply implementation approval.

## Spec ↔ plan navigation

Every spec and plan has a stable `Work-ID`, explicit `Status`, and `Spec` / `Plan` fields. Use relative Markdown links, including a self-link. Example spec `.agent-work/work/session-restore/spec.md`:

```markdown
# Session restore — Feature Spec

**Work-ID:** session-restore
**Status:** Draft
**Spec:** [Session restore](./spec.md)
**Plan:** [Session restore plan](./plan.md)
```

Matching plan `.agent-work/work/session-restore/plan.md`:

```markdown
# Session restore — Design Doc

**Work-ID:** session-restore
**Status:** Draft
**Spec:** [Session restore spec](./spec.md)
**Plan:** [Session restore plan](./plan.md)
```

Use `Not created` for an absent counterpart, not a nonexistent file link. When the counterpart is created, reuse the confirmed work directory, update both headers through normal permissions and verify link targets, Work-ID matching the directory, and reciprocal links. Matching filenames/IDs or directory proximity alone do not establish selection. Multiple specs/plans require explicit user-confirmed relationships and lists of links rather than overwriting an existing pairing. If either write is blocked, report incomplete linkage. Read-only/draft workflows do not update either file.

ADRs include confirmed Work-ID and relative Spec/Plan links (for example `../work/session-restore/spec.md` and `../work/session-restore/plan.md` from `decisions/`), or absent markers for standalone decisions. Tickets link the actual source spec and plan (or `Not created`); never invent a local source file for pasted text. Decomposition leaves parent documents unchanged. Todo persistence is limited to what the available runtime guarantees; specs, plans and ticket files remain the cross-session source of truth.

## Session-start and handoff rule

Before code generation, implementation, review, or artifact editing:

1. Inspect `.agent-work/work/` explicitly, even when normal search ignores hidden files. Identify candidate work directories and their specs/plans without loading every unrelated document. Follow explicitly selected legacy paths without silently migrating them.
2. An explicit user path, current-session confirmation, or validated reciprocal link from an already-selected document establishes identity. Otherwise ask the user to select. Offer likely candidates with path, title, status and short scope summary, plus **Other** and **None / standalone work**. Ask even when there is only one candidate. Do not infer selection from branch, filename, slug, recency, or unavailable prior-session memory. A clear new standalone request or no artifacts plus explicit ordinary task intent does not require creating documents.
3. Use the question tool when available; if no way to obtain an answer exists, return the blocker rather than guess. Example: “Which work describes this implementation: A, B, another path, or neither?” Preselection is only a recommendation awaiting confirmation.
4. Read the selected spec and plan, status, acceptance criteria, non-goals, design/testing choices, and relevant glossary/ADRs. Broken/one-way links, conflicting IDs, superseded docs or contradictory requirements require clarification. Do not quietly pair documents, choose the newer text, or mark Draft as approved.
5. Pass exact selected paths, Work-ID, status, relevant decisions and authorized scope to workers, or explicitly confirmed no-artifact context. A worker missing this identity must return candidate paths and a clarification request to the coordinator, not choose independently or launch new interviews it cannot complete.
6. Selection is context only. Respect each skill's implementation, review-item, write and publication gates. Report selected paths and any remaining ambiguity at handoff.

Pi's always-loaded rule lives in `dot-pi/agent/SYSTEM.md`; portable skills and isolated agent definitions also carry the relevant contract so it does not depend on this README being loaded.

## Maintenance acceptance checks

Static desk checks, not claims of observed agent behavior:

- New spec without plan → `Not created`, no invented design or required scaffolding.
- Plan first, spec later → reuse confirmed work directory and Work-ID; verify `./spec.md` ↔ `./plan.md` links.
- Same-folder documents without confirmed current-work selection → ask; proximity is not authorization.
- Fresh execution session with one plausible spec → ask; do not auto-select.
- Several candidates / mismatched or broken links → ask before acting on requirements.
- Explicit spec with valid reciprocal plan link → read both without redundant identity interview.
- Read-only request / denied backlink write → no silent mutation; report draft/incomplete pairing.
- Grill with existing `docs/adr/` → read existing evidence; new ADR stays under `.agent-work/decisions/`.
- Review/breakdown → consume chosen context, preserve parent docs and existing approval gates; publish only accepted tickets on explicit instruction.
- Commit request → `.agent-work/` globally excluded from ordinary adds; inspect the whole index for tracked or force-added artifacts.

Strict skill validation uses `skills/dot-agents/skills/skill-writer/scripts/quick_validate.py`; do not install its dependencies without approval. Runtime adherence needs separate model-session testing.
