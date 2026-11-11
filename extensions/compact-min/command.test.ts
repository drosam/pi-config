import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionCommandContext, SessionBeforeCompactEvent } from "@mariozechner/pi-coding-agent";

function installedPiRoot() {
	const executable = (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "pi")).find(existsSync);
	assert.ok(executable, "Pi executable must be on PATH for host-loader tests");
	let dir = dirname(realpathSync(executable));
	while (dirname(dir) !== dir) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			const { name } = JSON.parse(readFileSync(manifest, "utf8"));
			if (["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"].includes(name)) return dir;
		}
		dir = dirname(dir);
	}
	throw new Error("Cannot resolve Pi package backing active executable");
}

const root = installedPiRoot();
const { loadExtensions } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")).href);
const { SessionManager } = await import(pathToFileURL(join(root, "dist/core/session-manager.js")).href);
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../compact-min.ts");
const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
const usage = { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const summary = "## Verified state\nTriage finished; replies posted.\n## Read again\ncurrent.ts";

async function setup(hasUI = true) {
	const loaded = await loadExtensions([extensionPath], process.cwd());
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const command = extension.commands.get("compact-min");
	assert.ok(command);
	const hook = extension.handlers.get("session_before_compact")[0];
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage(user("Start the approved task"));
	const tail = manager.appendMessage(user("Latest: triage finished; replies posted"));
	const compactions: any[] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
	const calls: any[] = [];
	const state = {
		idle: true, queued: false,
		response: { stopReason: "stop", content: [{ type: "text", text: summary }], usage } as any,
		complete: undefined as undefined | ((...args: any[]) => Promise<any>),
	};
	const ctx = {
		hasUI, isIdle: () => state.idle, hasPendingMessages: () => state.queued,
		compact: (options: any) => compactions.push(options),
		sessionManager: manager,
		model: { id: "test", provider: "test", api: "openai-completions", maxTokens: 8192, contextWindow: 200000 },
		modelRegistry: { complete: async (...args: any[]) => {
			calls.push(args);
			return state.complete ? state.complete(...args) : state.response;
		} },
		ui: { notify: (message: string, type?: string) => {
			assert.ok(hasUI, "headless command must not use UI");
			notifications.push({ message, type });
		} },
	} as unknown as ExtensionCommandContext;
	const controller = new AbortController();
	const event = (): SessionBeforeCompactEvent => ({
		type: "session_before_compact", reason: "manual", willRetry: false,
		customInstructions: compactions.at(-1)?.customInstructions,
		branchEntries: manager.getBranch(), signal: controller.signal,
		preparation: {
			firstKeptEntryId: tail, tokensBefore: 12345, isSplitTurn: true,
			messagesToSummarize: [user("Older work")], turnPrefixMessages: [user("Old prefix")],
			previousSummary: "Stale: continue C3; commit not pushed",
			fileOps: { read: new Set(["irrelevant-old.ts"]), edited: new Set(["old-change.ts"]), written: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
	});
	const run = async (focus = "") => {
		await command.handler(focus, ctx);
		return hook(event(), ctx);
	};
	return { extension, command, hook, manager, tail, compactions, notifications, calls, state, ctx, controller, event, run };
}

test("host loader registers only compact-min and narrowly scoped lifecycle hooks", async () => {
	const h = await setup();
	assert.deepEqual([...h.extension.commands.keys()], ["compact-min"]);
	assert.deepEqual([...h.extension.handlers.keys()].sort(), ["session_before_compact", "session_shutdown"]);
	assert.match(h.command.description, /keeps configured recent history/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.compactions.length, 0);
	assert.equal(await h.hook(h.event(), h.ctx), undefined);
});

test("one request uses full projected context, current model, signal, and custom prompt", async () => {
	const h = await setup();
	const result = await h.run();
	assert.equal(h.calls.length, 1);
	const [model, context, options] = h.calls[0];
	assert.equal(model, h.ctx.model);
	assert.equal(options.signal, h.controller.signal);
	assert.equal(options.cacheRetention, "none");
	assert.equal(options.maxTokens, 4096);
	assert.ok(options.sessionId);
	assert.equal(context.messages.length, 1);
	assert.match(context.messages[0].content, /Start the approved task[\s\S]*Latest: triage finished; replies posted/);
	for (const instruction of [
		"300 words or fewer excluding file paths", "state at its END", "Previous summaries are historical claims",
		"Never present completed work as the next task", "explicit constraints, preferences, approvals",
		"skill SKILL.md paths", "never infer a selection", "Do not copy historical read-files/modified-files inventories",
		"reported/unverified", "Reread relevant files and skill SKILL.md files before acting",
		"Missing evidence is not evidence of absence", "no confirmation recorded", "never infer that an action did not happen",
		"Distinguish implementation finished from acceptance verified",
		"passing tests alone do not establish visual parity, user acceptance",
		"do not repeat completed work", "do not continue the task",
	]) assert.ok(context.systemPrompt.includes(instruction), instruction);
	assert.deepEqual(result.compaction, { summary, firstKeptEntryId: h.tail, tokensBefore: 12345, usage });
	assert.ok(!result.compaction.summary.includes("irrelevant-old.ts"));
	assert.ok(!result.compaction.summary.includes("Turn Context (split turn)"));
	assert.equal(h.notifications.length, 1, "completion is not reported before native callback");
	h.compactions[0].onComplete(result.compaction);
	assert.equal(h.notifications.at(-1)?.message, "Minimal compaction completed");
});

test("projected context excludes abandoned branches and omissions, and honors replacements", async () => {
	const h = await setup();
	const rootId = h.manager.getEntries()[0].id;
	h.manager.appendMessage(user("ABANDONED_BRANCH"));
	h.manager.branch(rootId);
	const omitted = h.manager.appendMessage(user("OMITTED_MESSAGE"));
	h.manager.appendContextEdit(omitted, null);
	const replaced = h.manager.appendMessage(user("REPLACED_OLD_CONTENT"));
	h.manager.appendContextEdit(replaced, { content: "REPLACEMENT_CONTENT" });
	h.manager.appendMessage(user("LATEST_VISIBLE_EVIDENCE"));
	await h.run();
	const transcript = h.calls[0][1].messages[0].content;
	assert.match(transcript, /REPLACEMENT_CONTENT/);
	assert.match(transcript, /LATEST_VISIBLE_EVIDENCE/);
	assert.doesNotMatch(transcript, /ABANDONED_BRANCH|OMITTED_MESSAGE|REPLACED_OLD_CONTENT/);
});

test("previous checkpoint and newer retained tail reach the same request in chronological order", async () => {
	const h = await setup();
	h.manager.appendCompaction("Historical checkpoint: resume C3", h.tail, 20000);
	h.manager.appendMessage(user("New evidence: C3 completed, all triage finished, commits pushed"));
	await h.run();
	assert.equal(h.calls.length, 1);
	assert.match(h.calls[0][1].messages[0].content, /Historical checkpoint: resume C3[\s\S]*New evidence: C3 completed/);
});

test("custom checkpoint preserves retained boundary and raw journal", async () => {
	const h = await setup();
	const before = h.manager.getEntries();
	const { compaction } = await h.run();
	assert.deepEqual(h.manager.getEntries(), before, "hook does not persist changes itself");
	h.manager.appendCompaction(compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore,
		compaction.details, true, compaction.usage);
	assert.deepEqual(h.manager.getEntries().slice(0, before.length), before);
	const messages = h.manager.buildSessionProjection().messages;
	assert.equal(messages[0].role, "compactionSummary");
	assert.equal(messages[0].summary, summary);
	assert.equal(messages[1].content, "Latest: triage finished; replies posted");
});

test("optional focus is trimmed, separate from system instructions, and not used as identity", async () => {
	const h = await setup();
	await h.run("  billing API  ");
	assert.match(h.calls[0][1].messages[0].content, /Optional focus: "billing API"/);
	assert.doesNotMatch(h.calls[0][1].systemPrompt, /billing API/);
	assert.match(h.compactions[0].customInstructions, /^compact-min:/);
});

test("whitespace focus becomes empty", async () => {
	const h = await setup();
	await h.run(" \n\t ");
	assert.match(h.calls[0][1].messages[0].content, /Optional focus: ""/);
});

test("normal manual, threshold, and overflow compaction remain untouched even while pending", async () => {
	const h = await setup();
	await h.command.handler("", h.ctx);
	const event = h.event();
	assert.equal(await h.hook({ ...event, customInstructions: "ordinary focus" }, h.ctx), undefined);
	for (const reason of ["threshold", "overflow"]) {
		assert.equal(await h.hook({ ...event, reason }, h.ctx), undefined);
	}
	assert.equal(h.calls.length, 0);
	assert.ok((await h.hook(event, h.ctx)).compaction);
});

test("busy runs, queued messages, and duplicate invocations do not start another compaction", async () => {
	const h = await setup();
	h.state.idle = false;
	await h.command.handler("", h.ctx);
	h.state.idle = true;
	h.state.queued = true;
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 0);
	h.state.queued = false;
	await h.command.handler("", h.ctx);
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 1);
});

for (const stopReason of ["error", "length", "aborted", "toolUse"]) {
	test(`rejects ${stopReason} response and cancels rather than falling back`, async () => {
		const h = await setup();
		h.state.response.stopReason = stopReason;
		const before = h.manager.getEntries();
		assert.deepEqual(await h.run(), { cancel: true });
		assert.deepEqual(h.manager.getEntries(), before);
		h.compactions[0].onError(new Error("Compaction cancelled"));
		assert.match(h.notifications.at(-1)!.message, new RegExp(`Summary ended with ${stopReason}.*existing context kept`));
		await h.command.handler("retry", h.ctx);
		assert.equal(h.compactions.length, 2, "failure releases pending command");
	});
}

for (const content of [[], [{ type: "text", text: " \n " }], [{ type: "toolCall", name: "bash", arguments: {} }]]) {
	test(`rejects unsafe or empty content: ${JSON.stringify(content)}`, async () => {
		const h = await setup();
		h.state.response.content = content;
		assert.deepEqual(await h.run(), { cancel: true });
	});
}

test("provider exceptions cancel and preserve context", async () => {
	const h = await setup();
	h.state.complete = async () => { throw new Error("provider unavailable"); };
	assert.deepEqual(await h.run(), { cancel: true });
	h.compactions[0].onError(new Error("Compaction cancelled"));
	assert.match(h.notifications.at(-1)!.message, /provider unavailable; existing context kept/);
});

test("cancellation before request avoids provider call", async () => {
	const h = await setup();
	h.controller.abort();
	assert.deepEqual(await h.run(), { cancel: true });
	assert.equal(h.calls.length, 0);
});

test("cancellation during request rejects even a successful response", async () => {
	const h = await setup();
	h.state.complete = async () => { h.controller.abort(); return h.state.response; };
	assert.deepEqual(await h.run(), { cancel: true });
	h.compactions[0].onError(new Error("Compaction cancelled"));
	assert.match(h.notifications.at(-1)!.message, /Cancelled; existing context kept/);
});

test("session shutdown disarms hook and ignores stale callbacks", async () => {
	const h = await setup();
	await h.command.handler("", h.ctx);
	const stale = h.compactions[0];
	await h.extension.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "reload" }, h.ctx);
	assert.equal(await h.hook(h.event(), h.ctx), undefined);
	stale.onComplete({});
	assert.equal(h.notifications.length, 1);
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 2);
	stale.onError(new Error("old failure"));
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 2, "stale callback must not release newer pending command");
});

test("native failure before hook and synchronous errors release command state", async () => {
	const h = await setup();
	await h.command.handler("", h.ctx);
	h.compactions[0].onError(new Error("Nothing to compact (session too small)"));
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 2);
	h.compactions[1].onError(new Error("Already compacted"));
	const compact = h.ctx.compact;
	h.ctx.compact = () => { throw new Error("synchronous failure"); };
	await assert.rejects(h.command.handler("", h.ctx), /synchronous failure/);
	h.ctx.compact = compact;
	await h.command.handler("", h.ctx);
	assert.equal(h.compactions.length, 3);
});

test("missing model or empty transcript cancels before provider call", async () => {
	const missingModel = await setup();
	missingModel.ctx.model = undefined;
	assert.deepEqual(await missingModel.run(), { cancel: true });
	assert.equal(missingModel.calls.length, 0);
	const empty = await setup();
	empty.manager.resetLeaf();
	assert.deepEqual(await empty.run(), { cancel: true });
	assert.equal(empty.calls.length, 0);
});

test("output allowance respects model limit", async () => {
	const h = await setup();
	h.ctx.model!.maxTokens = 1024;
	await h.run();
	assert.equal(h.calls[0][2].maxTokens, 1024);
});

test("shutdown during generation rejects a response from the old session", async () => {
	const h = await setup();
	h.state.complete = async () => {
		await h.extension.handlers.get("session_shutdown")[0]({ type: "session_shutdown", reason: "new" }, h.ctx);
		return h.state.response;
	};
	assert.deepEqual(await h.run(), { cancel: true });
});

test("successful command releases scope before subsequent normal compaction", async () => {
	const h = await setup();
	const result = await h.run();
	h.compactions[0].onComplete(result.compaction);
	assert.equal(await h.hook(h.event(), h.ctx), undefined);
	await h.command.handler("new focus", h.ctx);
	assert.equal(h.compactions.length, 2);
});

test("headless success and failure do not use UI", async () => {
	const h = await setup(false);
	const result = await h.run();
	h.compactions[0].onComplete(result.compaction);
	h.state.response.stopReason = "error";
	assert.deepEqual(await h.run(), { cancel: true });
	h.compactions[1].onError(new Error("Compaction cancelled"));
	assert.deepEqual(h.notifications, []);
});
