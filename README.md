# Pi configuration

This repository (`~/Developer/pi-config`) is linked into `~/.pi/agent/` by the dotfiles installer with `stow -d ~/Developer -t ~/.pi/agent pi-config`. `~/.pi/agent` stays a real directory, so runtime files (auth, sessions, `keybindings.json`, `trust.json`) never land here.

- Pi-specific skills and agents: `skills/` and `agents/` here.
- Shared skills and agents: the `agents` repository, linked into `~/.agents/skills/` and `~/.agents/agents/`. Pi discovers `~/.agents/skills/` natively; the subagent extension reads `~/.agents/agents/`, and a same-named agent here overrides a shared one.
- `herdr integration install pi` writes `extensions/herdr-agent-state.ts` here through the link; it stays untracked.
- Tests: `pnpm install`, then `pnpm test`. The `btw` and `compact-min` tests load your installed Pi from `PATH`. `skills/fewer-permission-prompts` tests run separately: `python3 -m unittest discover -s skills/fewer-permission-prompts/tests`.

After skill changes use `/reload`; start a fresh session to ensure changed SYSTEM.md instructions are loaded.

## Workflow and work artifacts

The skill workflow and the `.agent-work/` conventions (layout, commands, spec/plan linking, session-start and handoff rule, maintenance checks) live in the `agents` repository:

- Workflow diagram: `~/Developer/agents/README.md` (`docs/workflow.svg`)
- Work artifacts: `~/Developer/agents/docs/work-artifacts.md`

Pi's always-loaded version of the session-start rule lives in `SYSTEM.md`.
