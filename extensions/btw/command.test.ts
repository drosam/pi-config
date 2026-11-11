import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function installedPiRoot() {
	// Skip package-manager shims so a local dev dependency never shadows the active Pi.
	const executable = (process.env.PATH ?? "").split(delimiter).filter((dir) => !dir.endsWith(join("node_modules", ".bin")))
		.map((dir) => join(dir, "pi")).find(existsSync);
	assert.ok(executable, "Pi executable must be on PATH");
	let dir = dirname(realpathSync(executable));
	while (dirname(dir) !== dir) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const { name } = JSON.parse(readFileSync(manifest, "utf8"));
			if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(name)) return dir;
		}
		dir = dirname(dir);
	}
	throw new Error("Cannot resolve active Pi package");
}

const root = installedPiRoot();
const importHost = (path: string) => import(pathToFileURL(join(root, path)).href);
const { loadExtensions } = await importHost("dist/core/extensions/loader.js");
const { SessionManager } = await importHost("dist/core/session-manager.js");
const { convertToLlm } = await importHost("dist/core/messages.js");
const aiRoot = "node_modules/@earendil-works/pi-ai/dist";
const { initTheme, theme } = await importHost("dist/modes/interactive/theme/theme.js");
const { CURSOR_MARKER, matchesKey, visibleWidth } = await importHost("node_modules/@earendil-works/pi-tui/dist/index.js");
initTheme("dark", false);
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../btw.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
const answer = (text = "Side answer", stopReason = "stop", extra: object = {}) => ({
	role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 1,
	provider: "test", model: "test", api: "openai-completions",
	usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra,
});

async function setup(mode = "tui") {
	const loaded = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const command = extension.commands.get("btw");
	assert.ok(command);
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "system", content: "Main system prompt", timestamp: 0,
		toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
	manager.appendMessage(user("Main task context"));
	const calls: any[] = [];
	const notices: string[] = [];
	const ui = { component: undefined as any, options: undefined as any, renders: 0, rows: 30, columns: 120 };
	const state = { response: answer(), hold: undefined as Promise<void> | undefined, events: [] as any[], throwError: false, noResult: false };
	const ctx = {
		mode, hasUI: mode === "tui" || mode === "rpc", sessionManager: manager,
		model: { id: "test", provider: "test", maxTokens: 16384 }, thinkingLevel: "low",
		getSystemPrompt: () => "Fallback main prompt",
		isIdle: () => { throw new Error("Must not wait for main agent"); },
		abort: () => { throw new Error("Must not abort main agent"); },
		modelRegistry: { streamSimple(model: any, context: any, options: any) {
			calls.push({ model, context, options });
			return (async function* () {
				if (state.throwError) throw new Error("Provider unavailable");
				if (state.hold) {
					let onAbort: () => void = () => {};
					try {
						await Promise.race([state.hold, new Promise<void>((resolve) => {
							onAbort = resolve;
							options.signal.addEventListener("abort", onAbort, { once: true });
							if (options.signal.aborted) resolve();
						})]);
					} finally { options.signal.removeEventListener("abort", onAbort); }
				}
				for (const event of state.events) yield event;
				if (!state.noResult) yield { type: "done", message: state.response };
			})();
		} },
		ui: {
			notify: (text: string) => notices.push(text),
			custom: (factory: any, options: any) => new Promise<void>((resolve) => {
				assert.equal(mode, "tui");
				ui.options = options;
				ui.component = factory({ terminal: ui, requestRender: () => ui.renders++ },
					theme,
					{ matches: (data: string, action: string) => matchesKey(data, ({
						"tui.select.cancel": "escape", "tui.select.confirm": "enter",
						"tui.select.up": "up", "tui.select.down": "down",
					} as Record<string, string>)[action]) },
					() => { ui.component = undefined; resolve(); });
				ui.component.focused = true;
			}),
		},
	};
	const invoke = (question = "") => command.handler(question, ctx);
	const press = (key: string) => { assert.ok(ui.component); ui.component.handleInput(key); };
	const render = (width = 90) => ui.component.render(width).join("\n").replaceAll(CURSOR_MARKER, "").replace(/\u001b_[^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*m/g, "");
	const ask = async (question: string) => {
		const pending = invoke(question);
		await tick();
		const text = render();
		press("\u001b");
		await pending;
		return text;
	};
	const emit = async (event: string) => {
		for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx);
		await tick();
	};
	return { extension, manager, ctx, calls, notices, ui, state, invoke, press, render, ask, emit };
}

test("registers only btw and cleanup hooks; empty invocation does not call model", async () => {
	const h = await setup();
	assert.deepEqual([...h.extension.commands.keys()], ["btw"]);
	assert.deepEqual([...h.extension.handlers.keys()].sort(), ["session_shutdown", "session_tree"]);
	assert.equal(h.extension.tools.size, 0);
	const open = h.invoke();
	assert.match(h.render(), /Ask a side question below/);
	assert.equal(h.calls.length, 0);
	h.press("\u001b");
	await open;
});

test("preserves projected context and model without tool execution, session writes, or main control", async () => {
	const h = await setup();
	const replaced = h.manager.appendMessage(user("obsolete secret"));
	h.manager.appendContextEdit(replaced, { content: "replacement context" });
	h.manager.appendMessage({ role: "system", content: "Main system", toolsAdded: [{ name: "bash", description: "Run", parameters: {} }], timestamp: 1 });
	h.manager.appendMessage(answer("Observed code", "toolUse", { content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "file.ts" } }] }));
	h.manager.appendMessage({ role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(15000) }], timestamp: 1 });
	const before = structuredClone(h.manager.getEntries());
	const projected = structuredClone(convertToLlm(h.manager.buildSessionProjection().messages));
	assert.match(await h.ask("Which file?"), /Side answer/);
	assert.deepEqual(h.manager.getEntries(), before);
	assert.equal(h.calls.length, 1);
	const { model, context, options } = h.calls[0];
	assert.equal(model, h.ctx.model);
	assert.equal(options.reasoning, "low");
	assert.equal(options.maxTokens, 8192);
	assert.equal(options.sessionId, h.manager.getSessionId());
	assert.equal(options.cacheRetention, "short");
	assert.equal(options.transport, "sse");
	assert.equal(options.toolChoice, "none");
	assert.equal(context.systemPrompt, undefined, "must not override the cached system prompt");
	assert.equal(context.tools, undefined, "tool declarations remain in native system messages");
	assert.deepEqual(context.messages.slice(0, -1), projected);
	const payload = JSON.parse(context.messages.at(-1).content);
	assert.match(payload.instructions, /no tools/);
	assert.equal(payload.question, "Which file?");
	assert.ok(!JSON.stringify(context).includes("obsolete secret"));
	assert.ok(JSON.stringify(context).includes("replacement context"));
	assert.ok(JSON.stringify(context).includes("x".repeat(15000)), "tool results are not silently truncated");
	assert.equal(h.ui.options.overlay, true);
});

test("streams while main agent is busy; dismiss/reopen does not cancel or repeat request", async () => {
	const h = await setup();
	let release!: () => void;
	h.state.hold = new Promise<void>((resolve) => { release = resolve; });
	const pending = h.invoke("Side question");
	assert.match(h.render(), /Thinking/);
	h.press("\u001b");
	await pending;
	assert.equal(h.calls[0].options.signal.aborted, false);
	const reopen = h.invoke();
	assert.match(h.render(), /Side question/);
	h.state.events = [{ type: "text_delta", partial: answer("Streaming partial") }];
	release();
	await tick();
	assert.ok(h.ui.renders >= 2, "stream and completion request render");
	assert.doesNotMatch(h.render(), /Thinking/);
	assert.match(h.render(), /Side answer/);
	assert.equal(h.calls.length, 1);
	h.press("\u001b");
	await reopen;
});

test("rejects overlapping questions without another request", async () => {
	const h = await setup();
	h.state.hold = new Promise(() => {});
	const pending = h.invoke("first");
	await h.invoke("second");
	assert.equal(h.calls.length, 1);
	assert.match(h.notices.at(-1)!, /wait/);
	h.press("\u0003");
	await tick();
	assert.equal(h.calls[0].options.signal.aborted, true);
	assert.ok(h.ui.component, "cancelling keeps the panel open");
	h.press("\u001b");
	await pending;
});

test("history caps at 20, replays previous answers, shows transcript and clears", async () => {
	const h = await setup();
	for (let i = 0; i < 22; i++) await h.ask(`Question ${i}`);
	const last = JSON.parse(h.calls.at(-1).context.messages.at(-1).content);
	assert.equal(last.earlierSideExchanges.length, 20);
	assert.equal(last.earlierSideExchanges[0].question, "Question 1");
	const open = h.invoke();
	assert.match(h.render(), /20 turns/);
	assert.match(h.render(), /▌ Question 21/);
	h.press("\u001b[5~");
	assert.match(h.render(), /▌ Question 11/);
	assert.doesNotMatch(h.render(), /Question 21/);
	h.press("\u000c");
	assert.match(h.render(), /20 turns/, "ctrl+l no longer clears");
	h.press("\u001bl");
	assert.match(h.render(), /Ask a side question below/);
	h.press("\u001b");
	await open;
	await h.ask("Fresh");
	assert.deepEqual(JSON.parse(h.calls.at(-1).context.messages.at(-1).content).earlierSideExchanges, []);
});

for (const event of ["session_shutdown", "session_tree"]) {
	test(`${event} aborts pending work, closes UI and clears memory`, async () => {
		const h = await setup();
		h.state.hold = new Promise(() => {});
		const pending = h.invoke("Old branch");
		await h.emit(event);
		await pending;
		assert.equal(h.ui.component, undefined);
		assert.equal(h.calls[0].options.signal.aborted, true);
		const reopened = h.invoke();
		assert.match(h.render(), /Ask a side question below/);
		h.press("\u001b");
		await reopened;
	});
}

for (const kind of ["provider", "empty", "length", "tool", "missing", "error-event"]) {
	test(`reports ${kind} failure without replaying it as successful context`, async () => {
		const h = await setup();
		if (kind === "provider") h.state.throwError = true;
		if (kind === "empty") h.state.response = answer("");
		if (kind === "length") h.state.response = answer("Partial", "length");
		if (kind === "tool") h.state.response = answer("", "toolUse", { content: [{ type: "toolCall", name: "bash", id: "t", arguments: {} }] });
		if (kind === "missing") h.state.noResult = true;
		if (kind === "error-event") {
			h.state.noResult = true;
			h.state.events = [{ type: "error", error: answer("", "error", { errorMessage: "Bad credentials" }) }];
		}
		assert.match(await h.ask("Fail"), /Error:/);
		h.state.throwError = false;
		h.state.noResult = false;
		h.state.events = [];
		h.state.response = answer();
		await h.ask("Retry");
		assert.deepEqual(JSON.parse(h.calls.at(-1).context.messages.at(-1).content).earlierSideExchanges, []);
	});
}

test("UI wraps narrow/wide text, scrolls, resizes and invalidates", async () => {
	const h = await setup();
	h.state.response = answer(Array.from({ length: 100 }, (_, i) => `row${i} 漢字 👋 ${"long ".repeat(12)}`).join("\n\n"));
	const pending = h.invoke("Render test");
	await tick();
	for (const width of [1, 12, 40, 100]) {
		const lines = h.ui.component.render(width);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		assert.ok(lines.length <= Math.floor(h.ui.rows * 0.8));
	}
	const bottom = h.render(40);
	assert.match(bottom, /row99/, "follows newest output");
	h.press("\u001b[5~");
	assert.notEqual(h.render(40), bottom);
	h.ui.rows = 12;
	h.ui.component.invalidate();
	assert.ok(h.ui.component.render(40).length <= 9);
	h.press("\u001b");
	await pending;
});

test("follow-up input sends in the same panel with fresh main context and side history", async () => {
	const h = await setup();
	const open = h.invoke("First question");
	await tick();
	const panel = h.ui.component;
	const before = structuredClone(h.manager.getEntries());
	h.press("Follow-up with x [brackets] and spaces");
	assert.match(h.render(), /Follow-up with x \[brackets\] and spaces/);
	h.manager.appendMessage(user("Latest main evidence"));
	h.press("\r");
	await tick();
	assert.equal(h.ui.component, panel);
	assert.equal(h.calls.length, 2);
	const payload = JSON.parse(h.calls[1].context.messages.at(-1).content);
	assert.equal(payload.question, "Follow-up with x [brackets] and spaces");
	assert.deepEqual(payload.earlierSideExchanges, [{ question: "First question", answer: "Side answer" }]);
	assert.equal(h.calls[1].context.messages.at(-2).content, "Latest main evidence");
	assert.equal(h.calls[1].options.toolChoice, "none");
	assert.deepEqual(h.manager.getEntries().slice(0, -1), before);
	assert.match(h.render(), /2 turns/);
	h.press("\r");
	await tick();
	assert.equal(h.calls.length, 2, "empty input does not send or close");
	h.press("\u001b");
	await open;
});

test("composer keeps a draft during streaming and permits retry after cancellation", async () => {
	const h = await setup();
	h.state.hold = new Promise(() => {});
	const open = h.invoke("First");
	h.press("Next question");
	h.press("\r");
	assert.equal(h.calls.length, 1);
	assert.match(h.render(), /draft is kept/);
	assert.match(h.render(), /> Next question/);
	h.press("\u0003");
	await tick();
	h.state.hold = undefined;
	h.press("\r");
	await tick();
	assert.equal(h.calls.length, 2);
	assert.equal(JSON.parse(h.calls[1].context.messages.at(-1).content).question, "Next question");
	h.press("\u001b");
	await open;
});

test("composer propagates focus, preserves drafts on reopen, and handles bracketed paste", async () => {
	const h = await setup();
	const open = h.invoke();
	assert.ok(h.ui.component.render(90).join("\n").includes(CURSOR_MARKER));
	h.ui.component.focused = false;
	assert.ok(!h.ui.component.render(90).join("\n").includes(CURSOR_MARKER));
	h.ui.component.focused = true;
	h.press("\u001b[200~x [hello]");
	h.press(" world\u001b[201~");
	assert.equal(h.calls.length, 0);
	h.press("\u001b");
	await open;
	const reopen = h.invoke();
	assert.match(h.render(), /> x \[hello\] world/);
	h.press("!");
	assert.match(h.render(), /> x \[hello\] world!/, "cursor restored at draft end");
	h.press("\u007f");
	h.press("\r");
	await tick();
	assert.equal(JSON.parse(h.calls[0].context.messages.at(-1).content).question, "x [hello] world");
	h.press("\u001b");
	await reopen;
});

test("clear cancels pending work without closing and prevents stale answers resurfacing", async () => {
	const h = await setup();
	h.state.hold = new Promise(() => {});
	const open = h.invoke("Old question");
	h.press("draft to clear");
	h.press("\u001bl");
	assert.equal(h.calls[0].options.signal.aborted, true);
	await tick();
	assert.match(h.render(), /Ask a side question below/);
	assert.doesNotMatch(h.render(), /Old question|draft to clear|Cancelled/);
	h.state.hold = undefined;
	h.press("Fresh question");
	h.press("\r");
	await tick();
	assert.deepEqual(JSON.parse(h.calls[1].context.messages.at(-1).content).earlierSideExchanges, []);
	assert.match(h.render(), /1 turn\b/);
	h.press("\u001b");
	await open;
});

test("panel shows the side conversation as one transcript", async () => {
	const h = await setup();
	const open = h.invoke("First question");
	await tick();
	h.state.response = answer("Second answer");
	h.press("Second question");
	h.press("\r");
	await tick();
	const text = h.render();
	assert.match(text, /2 turns/);
	const order = ["▌ First question", "▌ Side answer", "▌ Second question", "▌ Second answer"].map((part) => text.indexOf(part));
	assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), text);
	h.press("\u001b");
	await open;
});

test("panel is framed, width-capped, responsive, and keeps composer visible", async () => {
	const h = await setup();
	const open = h.invoke();
	assert.equal(h.ui.options.overlayOptions().width, 114);
	h.ui.columns = 60;
	assert.equal(h.ui.options.overlayOptions().width, 57);
	const lines = h.ui.component.render(90);
	assert.equal(lines.length, 24);
	assert.ok(lines.every((line: string) => visibleWidth(line) === 90));
	const framed = h.render().split("\n");
	assert.match(framed[0], /^╭─ btw · no tools ─+╮$/);
	assert.match(framed.at(-1)!, /^╰─+╯$/);
	assert.match(framed.at(-3)!, /^│ btw ─+ enter send · esc close · alt\+l clear │$/);
	assert.match(framed.at(-2)!, /^│ > /);
	assert.ok(lines.every((line: string) => line.startsWith("\u001b[48;5;16m")), "panel has solid background");
	assert.ok(lines.every((line: string) => !/\u001b\[0m(?!\u001b\[48|$)/.test(line)), "background survives inner resets");
	for (const rows of [2, 6, 12, 40]) {
		h.ui.rows = rows;
		for (const width of [1, 12, 40, 90]) {
			const rendered = h.ui.component.render(width);
			assert.ok(rendered.length <= Math.max(1, Math.floor(rows * 0.8)));
			assert.ok(rendered.every((line: string) => visibleWidth(line) <= width));
			assert.ok(rendered.join("\n").includes(">"), "composer survives small viewports");
		}
	}
	h.press("\u001b");
	await open;
});

test("follow-up history eviction keeps the newest turn visible", async () => {
	const h = await setup();
	const open = h.invoke();
	for (let i = 0; i < 22; i++) {
		h.press(`In-panel ${i}`);
		h.press("\r");
		await tick();
	}
	assert.equal(h.calls.length, 22);
	assert.match(h.render(), /20 turns/);
	assert.match(h.render(), /▌ In-panel 21/);
	assert.match(h.render(), /▌ In-panel 20/);
	const rows = h.render().split("\n");
	assert.ok(rows.findIndex((line: string) => line.includes("In-panel 21")) > rows.length - 8, "newest turn sits above composer");
	h.press("\u001b");
	await open;
});

test("follow-up validation keeps draft when model or context is unavailable", async () => {
	const h = await setup();
	const open = h.invoke();
	const model = h.ctx.model;
	h.ctx.model = undefined as any;
	h.press("Keep this draft");
	h.press("\r");
	assert.match(h.render(), /No model selected/);
	assert.match(h.render(), /> Keep this draft/);
	h.ctx.model = model;
	h.ctx.getSystemPrompt = () => { throw new Error("Context unavailable"); };
	h.manager.resetLeaf();
	h.press("\r");
	await tick();
	assert.match(h.render(), /Context unavailable/);
	assert.match(h.render(), /> Keep this draft/);
	h.press("!");
	assert.match(h.render(), /> Keep this draft!/, "cursor restored at draft end");
	assert.equal(h.calls.length, 0);
	h.press("\u001b");
	await open;
});

test("reuses cache identity and refreshes native context on subsequent side questions", async () => {
	const h = await setup();
	await h.ask("First");
	const first = structuredClone(h.calls[0]);
	h.manager.appendMessage(user("New main-context evidence"));
	await h.ask("Second");
	assert.equal(h.calls[1].options.sessionId, first.options.sessionId);
	assert.deepEqual(h.calls[1].context.messages.slice(0, first.context.messages.length - 1), first.context.messages.slice(0, -1));
	assert.deepEqual(h.calls[1].context.messages.at(-2), user("New main-context evidence"));
	assert.deepEqual(JSON.parse(h.calls[1].context.messages.at(-1).content).earlierSideExchanges, [{ question: "First", answer: "Side answer" }]);
	const other = await setup();
	await other.ask("Different session");
	assert.notEqual(other.calls[0].options.sessionId, first.options.sessionId);
});

test("preserves images and signatures in an isolated snapshot", async () => {
	const h = await setup();
	h.manager.appendMessage({ role: "user", content: [{ type: "image", data: "test-image", mimeType: "image/png" }], timestamp: 2 });
	h.manager.appendMessage(answer("", "stop", { content: [
		{ type: "thinking", thinking: "", thinkingSignature: "opaque-signature", redacted: true },
		{ type: "text", text: "Image answer", textSignature: "text-signature" },
	] }));
	const before = structuredClone(h.manager.getEntries());
	await h.ask("Explain");
	const messages = h.calls[0].context.messages;
	assert.deepEqual(messages.slice(0, -1), convertToLlm(h.manager.buildSessionProjection().messages));
	messages[0].toolsAdded[0].description = "Mutated by provider";
	messages.at(-3).content[0].data = "Mutated image";
	messages.at(-2).content[0].thinkingSignature = "Mutated signature";
	assert.deepEqual(h.manager.getEntries(), before, "provider mutations cannot reach main session");
});

test("compaction and branch changes use the active projection, not abandoned history", async () => {
	const h = await setup();
	const kept = h.manager.appendMessage(user("Retained tail"));
	h.manager.appendCompaction("Checkpoint summary", kept, 1000);
	const fork = h.manager.getLeafId();
	h.manager.appendMessage(user("Abandoned branch"));
	h.manager.branch(fork);
	h.manager.appendMessage(user("Current branch"));
	await h.ask("Where are we?");
	const messages = h.calls[0].context.messages;
	assert.deepEqual(messages.slice(0, -1), convertToLlm(h.manager.buildSessionProjection().messages));
	const serialized = JSON.stringify(messages);
	assert.match(serialized, /Checkpoint summary/);
	assert.match(serialized, /Retained tail/);
	assert.match(serialized, /Current branch/);
	assert.doesNotMatch(serialized, /Abandoned branch|Main task context/);
});

test("empty or legacy context gets a leading fallback system prompt", async () => {
	const h = await setup();
	h.manager.resetLeaf();
	await h.ask("No main messages yet");
	assert.equal(h.calls[0].context.messages[0].content, "Fallback main prompt");
	h.manager.appendMessage(user("Legacy user-only history"));
	await h.ask("Legacy");
	assert.equal(h.calls[1].context.messages[0].content, "Fallback main prompt");
	assert.deepEqual(h.calls[1].context.messages[1], user("Legacy user-only history"));
});

test("pending tool calls remain native and host repairs missing results without executing tools", async () => {
	const h = await setup();
	const pending = answer("", "toolUse", { content: [
		{ type: "toolCall", id: "finished", name: "read", arguments: { path: "one.ts" } },
		{ type: "toolCall", id: "pending", name: "read", arguments: { path: "two.ts" } },
	] });
	h.manager.appendMessage(pending);
	h.manager.appendMessage({ role: "toolResult", toolCallId: "finished", toolName: "read", isError: false, content: [{ type: "text", text: "Existing result" }], timestamp: 1 });
	const before = structuredClone(h.manager.getEntries());
	await h.ask("What is happening?");
	const { context, options } = h.calls[0];
	assert.deepEqual(context.messages.at(-3), pending);
	assert.equal(options.toolChoice, "none");
	const { transformMessages } = await importHost(`${aiRoot}/api/transform-messages.js`);
	const normalized = transformMessages(context.messages, { ...h.ctx.model, api: "openai-completions", input: ["text"] });
	const results = normalized.filter((message: any) => message.role === "toolResult");
	assert.equal(results.length, 2);
	assert.equal(results[0].toolCallId, "finished");
	assert.equal(results[0].content[0].text, "Existing result");
	assert.equal(results[1].toolCallId, "pending");
	assert.equal(results[1].content[0].text, "No result provided");
	assert.match(JSON.parse(context.messages.at(-1).content).instructions, /may still be running/);
	assert.deepEqual(h.manager.getEntries(), before);
});

for (const api of ["anthropic-messages", "openai-responses", "openai-codex-responses"]) {
	test(`${api} payload preserves the prefix, cache settings and disabled tool choice (no network)`, async () => {
		const h = await setup();
		h.manager.appendMessage(answer("Main answer"));
		await h.ask("Side question");
		const { context, options } = h.calls[0];
		const { streamSimple } = await importHost(`${aiRoot}/api/${api}.js`);
		const model = {
			...h.ctx.model, api, name: "Test", reasoning: false, input: ["text"], contextWindow: 200000,
			provider: api === "anthropic-messages" ? "anthropic" : api === "openai-codex-responses" ? "openai-codex" : "openai",
			baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const fakeToken = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64url")}.test`;
		const capture = async (messages: any[], toolChoice: string) => {
			let payload: any;
			let fetched = false;
			const stream = streamSimple(model, { messages }, {
				...options, toolChoice, apiKey: api === "openai-codex-responses" ? fakeToken : "test-key",
				fetch: async () => { fetched = true; throw new Error("Network forbidden"); },
				onPayload: (body: any) => { payload = structuredClone(body); throw new Error("Payload captured; no request sent"); },
			});
			const result = await stream.result();
			assert.equal(fetched, false);
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage, /Payload captured/);
			assert.ok(payload);
			return payload;
		};
		const main = await capture(context.messages.slice(0, -1), "auto");
		const side = await capture(context.messages, options.toolChoice);
		assert.deepEqual(side.tools, main.tools, "unchanged declarations preserve cacheable tool prefix");
		assert.ok(side.tools.length > 0);
		if (api === "anthropic-messages") {
			assert.deepEqual(side.system, main.system);
			assert.deepEqual(side.messages.slice(0, main.messages.length), main.messages);
			assert.deepEqual(side.tool_choice, { type: "none" });
			assert.equal(side.system[0].cache_control.type, "ephemeral");
			assert.equal(side.messages.at(-1).content.at(-1).cache_control.type, "ephemeral");
		} else {
			assert.equal(side.instructions, main.instructions);
			assert.deepEqual(side.input.slice(0, main.input.length), main.input);
			assert.equal(side.tool_choice, "none");
			assert.equal(side.prompt_cache_key, h.manager.getSessionId());
		}
	});
}

test("non-terminal modes and missing model cannot make a request", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const h = await setup(mode);
		if (mode === "rpc") await h.invoke("hello");
		else await assert.rejects(h.invoke("hello"), /interactive terminal/);
		assert.equal(h.calls.length, 0);
	}
	const h = await setup();
	h.ctx.model = undefined as any;
	await h.invoke("hello");
	assert.match(h.notices[0], /No model/);
	assert.equal(h.calls.length, 0);
});
