---
name: pi-docs
description: Pi coding agent documentation lookup. Use when asked about pi itself, SDK, extensions, themes, skills, prompt templates, TUI components, keybindings, custom providers, adding models, packages, settings, sessions, RPC/JSON mode, providers, usage, shell aliases, terminal setup, or customizing pi.
disable-model-invocation: true
---

# Pi Docs

Use this skill for pi-specific questions and implementation work.

## Resolve Pi Root

Resolve the package actually backing the active `pi` executable; do not assume a machine-specific Node version or package manager.

1. Inspect the active executable/symlink target and package metadata when available.
2. Otherwise run `pnpm root -g` and check for `@earendil-works/pi-coding-agent/package.json` beneath that directory. A successful root command does not prove Pi is installed there.
3. If absent, try `npm root -g` separately. Older installations may use `@mariozechner/pi-coding-agent`; verify rather than guessing.
4. Read the resolved `package.json` version and verify its `docs/` directory. If neither candidate matches the executable, ask for the installation path.

Use separate permitted commands; do not install/upgrade Pi as part of lookup.

## Read Docs by Topic

Read the relevant docs completely before answering or editing pi config.
Follow cross-references relevant to the question, not the whole documentation graph. Prefer installed-version docs over latest web docs. If a routed file is missing, inspect that installation's docs index and report version differences rather than inventing a path.

| Topic | Read |
| --- | --- |
| Overview | `README.md` |
| Extensions | `docs/extensions.md`, then `examples/extensions/` |
| Themes | `docs/themes.md` |
| Skills | `docs/skills.md` |
| Prompt templates | `docs/prompt-templates.md` |
| TUI/components | `docs/tui.md` |
| Keybindings | `docs/keybindings.md` |
| SDK/embedding | `docs/sdk.md`, then `examples/sdk/` |
| Custom providers | `docs/custom-provider.md` |
| Adding models | `docs/models.md` |
| Packages | `docs/packages.md` |
| Sessions | `docs/sessions.md`, `docs/session-format.md` |
| Settings and trust | `docs/settings.md`, `docs/configuration.md` |
| Compaction | `docs/compaction.md` |
| JSON/print mode | `docs/json.md` |
| RPC | `docs/rpc.md`, then `docs/rpc-commands.md` or `docs/rpc-extension-ui.md` when relevant |
| Providers | `docs/providers.md` |
| Usage / CLI / environment | `docs/usage.md`, then `docs/cli.md` or `docs/environment-variables.md` when relevant |
| Shell aliases | `docs/shell-aliases.md` |
| Terminal setup | `docs/terminal-setup.md` |
| Quickstart | `docs/quickstart.md` |

## Local Config

This dotfiles repo stores pi config under:

```text
pi/dot-pi/agent/
```

Live config is usually symlinked under:

```text
~/.pi/agent/
```

Useful local paths:

| Area | Path |
| --- | --- |
| Settings | `pi/dot-pi/agent/settings.json` |
| Extensions | `pi/dot-pi/agent/extensions/` |
| Themes | `pi/dot-pi/agent/themes/` |
| Agents | `pi/dot-pi/agent/agents/` |
| Skills | `pi/dot-pi/agent/skills/` |

## Implementation Rules

- Read before changing.
- Prefer extension APIs over guessing JSON settings.
- For GitHub work, prefer GitHub CLI (`gh`) over web UI or raw API when available.
- For existing extension examples in this repo, preserve local `@mariozechner/pi-coding-agent` / `@mariozechner/pi-tui` imports unless intentionally migrating. Use the resolved package/version for API facts. Treat legacy import aliases as a separate local compatibility concern: inspect existing imports and loader/package aliases before copying an import or migrating it.
- Use `/reload` after extension/skill/theme changes in interactive pi.
- Verify with a version-supported cheap command after checking `docs/cli.md`. Loading an extension executes code even with `--offline`; inspect it first and obtain required permission. Report command/result and any unverified behavior.
