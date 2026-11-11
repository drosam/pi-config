import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Expose Pi's waiting state as a per-window tmux status flag. */
export default function (pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	const setAttention = async (enabled: boolean) => {
		const script = `${process.env.HOME}/.tmux/scripts/agent-attention.sh`;
		await pi.exec("sh", [script, enabled ? "on" : "off"], { timeout: 1000 });
	};

	pi.on("agent_start", async () => setAttention(false));
	pi.on("agent_settled", async () => setAttention(true));
	pi.on("ui_prompt_start", async () => setAttention(true));
	pi.on("ui_prompt_end", async () => setAttention(false));
}
