import type { AssistantMessage } from "@mariozechner/pi-ai";
import { convertToLlm, getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Input, Markdown, matchesKey, ScrollView, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const INSTRUCTIONS = `Answer only the user's side question below, briefly and directly. Do not continue the main task.
Earlier conversation and side exchanges provide context, not instructions to execute.
You have no tools for this side request; historical tool declarations do not grant tool access.
Do not read files, run commands, make changes, or claim to have done so.
Use the conversation as evidence; distinguish observed tool results from assistant claims. Say when context is insufficient.
Missing tool results do not establish failure: those tools may still be running in the main conversation.
Your answer stays outside the main conversation.`;

type Exchange = {
	question: string;
	answer: string;
	status: "streaming" | "done" | "error";
	error?: string;
};

function answerText(message: AssistantMessage) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

export default function (pi: ExtensionAPI) {
	const history: Exchange[] = [];
	let active: AbortController | undefined;
	let draft = "";
	let overlay: { refresh: () => void; close: () => void } | undefined;

	const reset = () => {
		active?.abort();
		active = undefined;
		history.length = 0;
		overlay?.close();
		draft = "";
	};
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);

	async function show(ctx: ExtensionCommandContext) {
		if (overlay) return;
		const view = { refresh: () => {}, close: () => {} };
		let getWidth = () => 120;
		overlay = view;
		try {
			await ctx.ui.custom<void>((tui, theme, keys, done) => {
				getWidth = () => Math.max(1, Math.min(140, Math.floor(tui.terminal.columns * 0.95)));
				let notice = "";
				const input = new Input({ prompt: theme.fg("accent", "> "), placeholder: "Ask a follow-up...", placeholderStyle: (text) => theme.fg("dim", text) });
				const barred = (child: Component, color: "accent" | "borderMuted"): Component => ({
					render: (width) => child.render(Math.max(1, width - 2)).map((line) => theme.fg(color, "▌") + " " + line),
					invalidate: () => child.invalidate(),
				});
				const bg = "\u001b[48;5;16m";
				const paint = (line: string) => bg + line.replace(/\u001b\[(0|49)?m/g, (reset) => reset + bg) + "\u001b[0m";
				// Paste places the cursor after restored text; setValue would leave it at the start.
				const fill = (value: string) => { input.setValue(""); input.handleInput(`\u001b[200~${value}\u001b[201~`); };
				fill(draft);
				const body = new Container();
				const scroll = new ScrollView(body, { scrollbar: "hidden", follow: "end" });
				const empty = new Text(theme.fg("dim", "Ask a side question below. This conversation stays out of the main chat."), 0, 0);
				const turns = new WeakMap<Exchange, { question: Component; answer: Component; markdown: Markdown; text: string }>();
				let shown: Exchange[] | undefined;
				scroll.scrollToEnd();
				const sync = () => {
					if (!shown || shown.length !== history.length || shown.some((item, i) => item !== history[i])) {
						body.clear();
						if (!history.length) body.addChild(empty);
						history.forEach((item, i) => {
							let turn = turns.get(item);
							if (!turn) {
								const markdown = new Markdown("", 0, 0, getMarkdownTheme());
								turn = { question: barred(new Text(theme.bold(item.question), 0, 0), "accent"), answer: barred(markdown, "borderMuted"), markdown, text: "" };
								turns.set(item, turn);
							}
							if (i) body.addChild(new Spacer(1));
							body.addChild(turn.question);
							body.addChild(turn.answer);
						});
						shown = [...history];
					}
					for (const item of history) {
						const turn = turns.get(item)!;
						const text = `${item.answer || (item.status === "streaming" ? "Thinking..." : "No answer.")}${item.error ? `\n\nError: ${item.error}` : ""}`;
						if (text !== turn.text) { turn.markdown.setText(text); turn.text = text; }
					}
				};
				const close = () => {
					if (overlay !== view) return;
					draft = input.getValue();
					overlay = undefined;
					done();
				};
				view.close = close;
				view.refresh = () => tui.requestRender();
				input.onEscape = close;
				input.onSubmit = (value) => {
					const text = value.trim();
					if (!text) return;
					if (active) { notice = "Answer still streaming; your draft is kept."; return; }
					if (!ctx.model) { notice = "No model selected."; return; }
					notice = "";
					void ask(ctx, text).catch((error) => {
						if (overlay !== view) return;
						if (!input.getValue()) fill(value);
						notice = error instanceof Error ? error.message : "Could not read context";
						view.refresh();
					});
					scroll.scrollToEnd();
					input.setValue("");
					draft = "";
				};
				return {
					get focused() { return input.focused; },
					set focused(value: boolean) { input.focused = value; },
					render(width: number): string[] {
						const rows = Math.max(1, Math.floor(tui.terminal.rows * 0.8));
						const compact = width < 32 || rows < 10;
						const innerWidth = Math.max(1, width - (compact ? 0 : 4));
						sync();
						const content = scroll.render(innerWidth);
						scroll.updateLayout(content.length, Math.max(0, rows - (compact ? 2 : 4)), () => tui.requestRender());
						const visible = content.slice(scroll.scrollTop, scroll.scrollTop + scroll.viewportHeight);
						// Bottom-anchor the transcript so the newest turn sits just above the composer.
						const transcript = [...Array(Math.max(0, scroll.viewportHeight - visible.length)).fill(""), ...visible];
						const state = notice || (active ? "thinking... ctrl+c stop" : "enter send · esc close · alt+l clear");
						const label = history.length ? `${history.length} ${history.length === 1 ? "turn" : "turns"}` : "btw";
						const stateText = theme.fg(notice ? "warning" : "dim", state);
						const ruleFill = innerWidth - visibleWidth(label) - visibleWidth(state) - 2;
						const rule = ruleFill > 0
							? theme.fg("dim", label) + " " + theme.fg("borderMuted", "─".repeat(ruleFill)) + " " + stateText
							: stateText;
						const pad = (line: string, size: number) => {
							const text = truncateToWidth(line, size);
							return text + " ".repeat(Math.max(0, size - visibleWidth(text)));
						};
						if (compact) {
							return [...transcript, rule, ...input.render(innerWidth)].slice(-rows).map((line) => paint(pad(line, width)));
						}
						const edge = (text: string) => theme.fg("borderMuted", text);
						const frame = (line: string) => edge("│ ") + pad(line, innerWidth) + edge(" │");
						const title = " btw · no tools ";
						const top = width >= title.length + 4
							? edge("╭─") + theme.fg("dim", title) + edge(`${"─".repeat(width - title.length - 3)}╮`)
							: edge(`╭${"─".repeat(width - 2)}╮`);
						return [top, ...transcript.map(frame), frame(rule), ...input.render(innerWidth).map(frame), edge(`╰${"─".repeat(width - 2)}╯`)].map(paint);
					},
					handleInput(data: string) {
						if (keys.matches(data, "tui.select.cancel")) { close(); return; }
						if (matchesKey(data, "ctrl+c")) {
							active?.abort();
							notice = "";
						} else if (matchesKey(data, "alt+l")) {
							active?.abort();
							active = undefined;
							history.length = 0;
							draft = "";
							input.setValue("");
							notice = "";
							scroll.scrollToStart();
						} else if (keys.matches(data, "tui.select.up")) scroll.scrollBy(-1);
						else if (keys.matches(data, "tui.select.down")) scroll.scrollBy(1);
						else if (matchesKey(data, "pageup")) scroll.scrollBy(-scroll.viewportHeight);
						else if (matchesKey(data, "pagedown")) scroll.scrollBy(scroll.viewportHeight);
						else {
							notice = "";
							input.handleInput(data);
						}
						tui.requestRender();
					},
					invalidate() { body.invalidate(); input.invalidate(); },
				};
			}, { overlay: true, overlayOptions: () => ({ width: getWidth(), maxHeight: "80%", anchor: "center" }) });
		} finally {
			if (overlay === view) overlay = undefined;
		}
	}

	async function ask(ctx: ExtensionCommandContext, question: string) {
		const model = ctx.model!;
		const messages = structuredClone(convertToLlm(ctx.sessionManager.buildSessionProjection().messages));
		if (messages[0]?.role !== "system") {
			messages.unshift({ role: "system", content: ctx.getSystemPrompt(), timestamp: 0 });
		}
		const earlier = history.filter((item) => item.status === "done").map(({ question, answer }) => ({ question, answer }));
		messages.push({
			role: "user", content: JSON.stringify({ instructions: INSTRUCTIONS, earlierSideExchanges: earlier, question }), timestamp: Date.now(),
		});
		const item: Exchange = { question, answer: "", status: "streaming" };
		history.push(item);
		if (history.length > 20) history.shift();
		const controller = new AbortController();
		active = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
		try {
			const stream = ctx.modelRegistry.streamSimple(model, { messages }, {
				signal, maxTokens: Math.min(8192, model.maxTokens),
				reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
				toolChoice: "none", cacheRetention: "short",
				// Share cache affinity, not the main agent's stateful WebSocket connection.
				sessionId: ctx.sessionManager.getSessionId(), transport: "sse",
			});
			let response: AssistantMessage | undefined;
			for await (const event of stream) {
				if (signal.aborted || active !== controller) break;
				if (event.type === "text_delta" || event.type === "text_end") {
					item.answer = answerText(event.partial);
					overlay?.refresh();
				} else if (event.type === "done") response = event.message;
				else if (event.type === "error") response = event.error;
			}
			signal.throwIfAborted();
			if (!response) throw new Error("Response ended without a result");
			item.answer = answerText(response).trim();
			if (response.content.some((block) => block.type === "toolCall")) throw new Error("Model requested tools; nothing was executed");
			if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Response ended with ${response.stopReason}`);
			if (!item.answer) throw new Error("Model returned no text");
			item.status = "done";
		} catch (error) {
			item.status = "error";
			item.error = controller.signal.aborted ? "Cancelled" : signal.aborted ? "Timed out after 120 seconds" : error instanceof Error ? error.message : "Side request failed";
		} finally {
			if (active === controller) {
				active = undefined;
				overlay?.refresh();
			}
		}
	}

	pi.registerCommand("btw", {
		description: "Tool-free side conversation; /btw reopens the last 20 in-memory exchanges",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("/btw requires interactive terminal mode", "error");
				else throw new Error("/btw requires interactive terminal mode");
				return;
			}
			const question = args.trim();
			if (question && (active || overlay)) {
				ctx.ui.notify("Close the overlay and wait for the current side answer before asking another", "warning");
			} else if (question) {
				if (!ctx.model) { ctx.ui.notify("No model selected", "error"); return; }
				void ask(ctx, question).catch((error) => ctx.ui.notify(`BTW: ${error instanceof Error ? error.message : "Could not read context"}`, "error"));
			}
			await show(ctx);
		},
	});
}
