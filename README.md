# Pi configuration

This repository holds Pi agent configuration. Link its contents into `~/.pi/agent/` (for example, from this repo's parent directory: `stow -t ~/.pi/agent pi-config`). Keep `~/.pi/agent` a real directory, so runtime files (auth, sessions, `keybindings.json`, `trust.json`) never land here.

- Pi-specific skills and agents: `skills/` and `agents/` here.
- Shared skills and agents: the [`agents`](https://github.com/drosam/agents) repository, linked into `~/.agents/skills/` and `~/.agents/agents/`. Pi discovers `~/.agents/skills/` natively; the subagent extension reads `~/.agents/agents/`, and a same-named agent here overrides a shared one.
- [Task agents](extensions/subagent/README.md): foreground/background delegation, saved-session resume, steering/cancellation, and `/tasks` fleet controls.
- `herdr integration install pi` writes `extensions/herdr-agent-state.ts` here through the link; it stays untracked.
- Tests: `pnpm install`, then `pnpm test`. The `btw` and `compact-min` tests load your installed Pi from `PATH`. `skills/fewer-permission-prompts` tests run separately: `python3 -m unittest discover -s skills/fewer-permission-prompts/tests`.

After skill changes use `/reload`; start a fresh session to ensure changed SYSTEM.md instructions are loaded.

## Workflow and work artifacts

The skill workflow and the `.agent-work/` conventions (layout, commands, spec/plan linking, session-start and handoff rule, maintenance checks) live in the [`agents`](https://github.com/drosam/agents) repository:

- [Workflow diagram](https://github.com/drosam/agents#workflow)
- [Work artifacts](https://github.com/drosam/agents/blob/main/docs/work-artifacts.md)

Pi's always-loaded version of the session-start rule lives in `SYSTEM.md`.
