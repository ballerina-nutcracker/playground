import { test } from "node:test";
import assert from "node:assert/strict";
import {
	conversationItems,
	summarizeTool,
} from "../../src/components/bal-bot/tool-summaries.ts";

const call = (id, name = "edit_file") => ({
	type: "toolCall",
	id,
	name,
	arguments: {
		path: "private.bal",
		oldText: "secret old source",
		newText: "secret new source",
	},
});
const assistant = (...content) => ({
	role: "assistant",
	content,
	stopReason: "toolUse",
});
const result = (id, text = "private.bal\nsecret output", isError = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "edit_file",
	content: [{ type: "text", text }],
	isError,
});
const text = (value) => ({ type: "text", text: value });

test("all workspace tools use action-only templates and diagnostics never imply a clean check", () => {
	for (const [name, running, completed] of [
		["list_files", "Listing files…", "Listed files"],
		["read_file", "Reading file…", "Read file"],
		["write_file", "Writing file…", "Wrote file"],
		["edit_file", "Editing file…", "Edited file"],
		["delete_file", "Deleting file…", "Deleted file"],
		["get_diagnostics", "Checking source…", "Checked source"],
	]) {
		assert.equal(summarizeTool(name, "running"), running);
		assert.equal(summarizeTool(name, "completed"), completed);
	}
	assert.equal(summarizeTool("private.bal", "completed"), "Finished action");
	assert.equal(summarizeTool("toString", "running"), "Working…");
});

test("pairs multiple calls by ID, keeps prose in order, hides all raw data, and preserves agent history", () => {
	const messages = [
		assistant(
			text("Before"),
			call("a"),
			text("Between"),
			call("b", "read_file"),
		),
		result("b"),
		result("a"),
		assistant(text("After")),
	];
	const before = structuredClone(messages);
	const items = conversationItems(messages, false);
	assert.deepEqual(
		items.map((item) =>
			item.kind === "tool" ? item.text : item.message.content[0].text,
		),
		["Before", "Edited file", "Between", "Read file", "After"],
	);
	assert.doesNotMatch(
		JSON.stringify(items),
		/private\.bal|secret|oldText|newText/,
	);
	assert.deepEqual(messages, before);
});

test("partial arguments stay hidden and pending operations stop without reviving on later turns", () => {
	const partial = assistant({
		...call("a"),
		arguments: { path: "private.bal", content: "partial source" },
		partialJson: '{"path":"private.bal"',
	});
	assert.deepEqual(conversationItems([partial], true), [
		{ kind: "tool", id: "a", state: "running", text: "Editing file…" },
	]);
	assert.equal(conversationItems([partial], false)[0].state, "stopped");
	assert.equal(
		conversationItems(
			[partial, { role: "user", content: "Next turn" }],
			true,
		)[0].state,
		"stopped",
	);
	assert.equal(
		conversationItems([{ ...partial, stopReason: "aborted" }], true)[0].state,
		"stopped",
	);
	assert.equal(
		conversationItems([{ ...partial, stopReason: "error" }], true)[0].state,
		"failed",
	);
});

test("failure reasons are concise templates with no filename or source disclosure", () => {
	for (const [raw, reason] of [
		["File not found: private.bal", "File not found."],
		[
			"Error: oldText must match exactly once. Read the file and try again.",
			"Text to replace must match exactly once.",
		],
		[
			"Could not save browser files. Workspace is read-only. secret details",
			"Browser storage is unavailable.",
		],
		["Only .md, .bal and .toml files are supported.", "Unsupported file type."],
		[
			"Invalid arguments for tool edit_file: private.bal secret source",
			"Invalid tool arguments.",
		],
		[
			"private.bal\nsecret source\nstack trace",
			"Operation could not be completed.",
		],
	]) {
		const [item] = conversationItems(
			[assistant(call("a")), result("a", raw, true)],
			false,
		);
		assert.equal(item.state, "failed");
		assert.equal(item.text, `Could not edit file. ${reason}`);
		assert.doesNotMatch(
			JSON.stringify(item),
			/private\.bal|secret|stack trace/,
		);
	}
});

test("aborted results are stopped, successful results stay completed even when the turn stops", () => {
	for (const raw of [
		"Operation aborted",
		"Error: This operation was aborted",
		"Request aborted by user",
	]) {
		assert.equal(
			conversationItems(
				[assistant(call("a")), result("a", raw, true)],
				false,
			)[0].state,
			"stopped",
		);
	}
	assert.equal(
		conversationItems([assistant(call("a")), result("a")], false)[0].state,
		"completed",
	);
});

test("restored conversations and orphan results remain compact; system messages and thinking stay hidden", () => {
	const messages = [
		{ role: "system", content: "hidden" },
		assistant({ type: "thinking", thinking: "hidden" }, call("a")),
		result("a"),
	];
	assert.deepEqual(
		conversationItems(messages, false),
		conversationItems(structuredClone(messages), false),
	);
	assert.equal(conversationItems(messages, false).length, 1);
	assert.equal(
		conversationItems([result("orphan")], false)[0].text,
		"Edited file",
	);
	const user = { role: "user", content: "Keep my message" };
	const failed = {
		...assistant(),
		stopReason: "error",
		errorMessage: "Connection failed",
	};
	assert.deepEqual(
		conversationItems([user, failed], false).map((item) => item.message),
		[user, failed],
	);
});
