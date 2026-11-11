# Pi Docs Sources

Retrieved: 2026-09-24. Class: workflow-process; shape: installed-documentation router, not a vendored API guide.

| Source | Trust tier | Confidence | Usage constraints |
| --- | --- | --- | --- |
| Installed @earendil-works/pi-coding-agent 0.87.1 package.json, docs index, skills.md, settings.md, packages.md | canonical installed documentation | high for observed package | Active-executable binding not verified; lookup workflow must confirm it |
| Existing local pi-docs skill and dotfiles README/layout | canonical local | high | Preserve repo locations and intentional legacy imports |
| https://agentskills.io/specification | canonical format | high | Relative bundled paths; no host-specific installation fallback |

Observation: the old skill fallback resolved to `$HOME/.local/share/mise/installs/node/24.14.1/lib/node_modules/@earendil-works/pi-coding-agent`; its package.json reports 0.87.1 and docs were readable. The pnpm global candidate was absent. The active executable was not independently resolved in this audit, so this is an observed installed source, not proof of active CLI selection.

Decision: replace hardcoded Node path and shell fallback with verified executable/package/version resolution. Add current docs-index routes and bounded cross-reference traversal. Loading extensions executes code even offline; do not treat it as inherently safe validation.

Workflow profile: lookup preconditions, route, missing-doc recovery, version boundary, safety and output evidence covered. Desk cases: pnpm root exists but package absent → try npm/active executable; stale docs path → inspect installed index; non-Pi library question → do not route here.

Stop: installed layout/runtime docs cover lookup changes; API implementation docs must be read on demand for actual API tasks. Gap: no CLI startup smoke test run; strict validator blocked by missing PyYAML. No settings/import migration or registration change performed.
