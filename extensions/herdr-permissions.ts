import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const waiting = new Set<string>();

	pi.events.on("pi-permission-system:permission-request", (data) => {
		if (!data || typeof data !== "object") return;
		const event = data as { requestId?: unknown; state?: unknown };
		if (typeof event.requestId !== "string" || !event.requestId) return;

		if (event.state === "waiting") {
			if (waiting.has(event.requestId)) return;
			waiting.add(event.requestId);
			pi.events.emit("herdr:blocked", { active: true, label: "Waiting for permission" });
		} else if (event.state === "approved" || event.state === "denied") {
			if (!waiting.delete(event.requestId)) return;
			pi.events.emit("herdr:blocked", { active: false });
		}
	});

	pi.on("session_shutdown", () => {
		for (const requestId of waiting) {
			waiting.delete(requestId);
			pi.events.emit("herdr:blocked", { active: false });
		}
	});
}
