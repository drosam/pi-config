import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import register from "../herdr-permissions.ts";

function setup() {
	const events = new EventEmitter();
	const lifecycle = new EventEmitter();
	const states: unknown[] = [];
	events.on("herdr:blocked", (state) => states.push(state));
	register({ events, on: lifecycle.on.bind(lifecycle) } as unknown as ExtensionAPI);
	return {
		states,
		send: (requestId: string, state: string) => events.emit(
			"pi-permission-system:permission-request", { requestId, state },
		),
		events,
		lifecycle,
	};
}

const blocked = { active: true, label: "Waiting for permission" };
const cleared = { active: false };

for (const decision of ["approved", "denied"]) {
	test(`clears permission waiting on ${decision}`, () => {
		const { send, states } = setup();
		send("one", "waiting");
		assert.deepEqual(states, [blocked]);
		send("one", decision);
		assert.deepEqual(states, [blocked, cleared]);
	});
}

test("counts overlapping requests once and ignores duplicate terminal events", () => {
	const { send, states } = setup();
	send("one", "waiting");
	send("one", "waiting");
	send("two", "waiting");
	send("one", "approved");
	send("one", "approved");
	assert.deepEqual(states, [blocked, blocked, cleared]);
	send("two", "denied");
	assert.deepEqual(states, [blocked, blocked, cleared, cleared]);
});

test("ignores auto-approvals, unknown states, and malformed events", () => {
	const { send, events, states } = setup();
	send("auto", "approved");
	send("unknown", "other");
	for (const event of [null, undefined, "waiting", {}, { state: "waiting" },
		{ requestId: "", state: "waiting" }, { requestId: 42, state: "waiting" }]) {
		events.emit("pi-permission-system:permission-request", event);
	}
	assert.deepEqual(states, []);
});

test("shutdown releases only this bridge's outstanding requests", () => {
	const { send, states, lifecycle } = setup();
	send("one", "waiting");
	send("two", "waiting");
	lifecycle.emit("session_shutdown");
	assert.deepEqual(states, [blocked, blocked, cleared, cleared]);
	lifecycle.emit("session_shutdown");
	send("one", "approved");
	assert.equal(states.length, 4);
});
