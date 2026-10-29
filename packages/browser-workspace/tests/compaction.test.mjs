import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createWorkspaceAgent, BrowserWorkspace } from "../src/index.ts";
import { testAgentScope } from "./fixtures.mjs";

const model = {
	id: "test-model",
	name: "Test",
	api: "openai-responses",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 12000,
	maxTokens: 2000,
};
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function answer(text = "Done.", stopReason = "stop", content) {
	const message = {
		role: "assistant",
		content: content ?? [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	if (stopReason === "error" || stopReason === "aborted")
		stream.push({
			type: "error",
			reason: stopReason,
			error: { ...message, errorMessage: "sensitive raw failure" },
		});
	else stream.push({ type: "done", reason: stopReason, message });
	return stream;
}
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const isSummary = (context) =>
	context.messages[0]?.content?.startsWith?.("Summarize conversation data");
function setup(handler) {
	const requests = [];
	const workspace = new BrowserWorkspace({ getItem: () => null, setItem() {} });
	const agent = createWorkspaceAgent(
		workspace,
		model,
		(selectedModel, context, options) => {
			const request = {
				model: selectedModel,
				context,
				options,
				summary: isSummary(context),
			};
			requests.push(request);
			return (
				handler?.(request) ??
				answer(
					request.summary
						? "Goal: implement the requested change. Older work completed."
						: "Done.",
				)
			);
		},
		testAgentScope,
	);
	return { agent, requests, workspace };
}
function seed(agent, length = 36000) {
	agent.state.messages.push(user(`old goal ${"x".repeat(length)}`), {
		role: "assistant",
		content: [{ type: "text", text: "old response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: 0,
	});
}

test("short conversations do not compact", async () => {
	const { agent, requests } = setup();
	await agent.prompt("Hello");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].summary, false);
	assert.equal(agent.compactionState, "idle");
});

test("automatic compaction preserves visible history, system/tools and latest input; reuses summary", async () => {
	const { agent, requests } = setup();
	seed(agent);
	const oldHistory = [...agent.state.messages];
	const statuses = [];
	const unsubscribe = agent.subscribeCompaction(() =>
		statuses.push(agent.compactionState),
	);
	await agent.prompt("new request");
	assert.deepEqual(statuses, ["compacting", "idle"]);
	assert.ok(requests.some((request) => request.summary));
	for (const request of requests.filter((request) => request.summary)) {
		assert.equal(request.model, model);
		assert.equal(request.options.reasoning, undefined);
		assert.equal(request.options.cacheRetention, "none");
		assert.ok(request.options.maxTokens > 0);
		assert.equal(JSON.stringify(request.context).includes("toolsAdded"), false);
	}
	const projected = requests.at(-1).context.messages;
	assert.equal(projected[0].role, "system");
	assert.match(projected[0].content, /Ballerina coding assistant/);
	assert.ok(projected[0].toolsAdded.some((tool) => tool.name === "read_file"));
	assert.match(projected[1].content, /Earlier conversation summary/);
	assert.equal(JSON.stringify(projected).includes("x".repeat(100)), false);
	assert.match(JSON.stringify(projected.at(-1)), /new request/);
	assert.deepEqual(
		agent.state.messages.slice(0, oldHistory.length),
		oldHistory,
	);
	const summaryRequests = requests.filter((request) => request.summary).length;
	unsubscribe();
	await agent.prompt("one more");
	assert.equal(
		requests.filter((request) => request.summary).length,
		summaryRequests,
	);
	assert.match(
		JSON.stringify(requests.at(-1).context),
		/Earlier conversation summary/,
	);
	assert.match(JSON.stringify(requests.at(-1).context), /one more/);
});

test("large tool results trigger compaction between tool rounds without replaying tools", async () => {
	let conversationCalls = 0;
	const { agent, requests, workspace } = setup((request) => {
		if (request.summary)
			return answer(
				"Goal: inspect large.bal. Its contents were read. Next: respond.",
			);
		conversationCalls++;
		return conversationCalls === 1
			? answer("", "toolUse", [
					{
						type: "toolCall",
						id: "read-1",
						name: "read_file",
						arguments: { path: "large.bal" },
					},
				])
			: answer();
	});
	workspace.write("large.bal", `// ${"x".repeat(45000)}`);
	await agent.prompt("Read large.bal");
	assert.equal(conversationCalls, 2);
	assert.ok(requests.slice(1, -1).every((request) => request.summary));
	assert.ok(requests.some((request) => request.summary));
	assert.equal(
		agent.state.messages.filter((message) => message.role === "toolResult")
			.length,
		1,
	);
	for (const request of requests.filter((request) => !request.summary)) {
		const calls = new Set(
			request.context.messages.flatMap((message) =>
				message.role === "assistant"
					? message.content
							.filter((part) => part.type === "toolCall")
							.map((part) => part.id)
					: [],
			),
		);
		for (const message of request.context.messages)
			if (message.role === "toolResult")
				assert.ok(calls.has(message.toolCallId));
	}
});

test("repeated compaction includes previous summary and newly retired history", async () => {
	const { agent, requests } = setup();
	seed(agent);
	await agent.prompt("first new request");
	const initial = requests.length;
	seed(agent);
	await agent.prompt("second new request");
	const summaries = requests
		.slice(initial)
		.filter((request) => request.summary);
	assert.ok(summaries.length);
	assert.match(
		JSON.stringify(summaries[0].context),
		/Previous summary:.*Goal:/s,
	);
	assert.match(JSON.stringify(summaries[0].context), /first new request/);
	assert.match(JSON.stringify(requests.at(-1).context), /second new request/);
});

test("Stop aborts compaction, leaves history intact and allows automatic retry", async () => {
	let started;
	const began = new Promise((resolve) => {
		started = resolve;
	});
	let cancelled = false;
	const { agent, requests } = setup((request) => {
		if (!request.summary || cancelled)
			return answer(request.summary ? "Summary after retry." : "Done.");
		const stream = createAssistantMessageEventStream();
		request.options.signal.addEventListener(
			"abort",
			() => {
				cancelled = true;
				stream.push({
					type: "error",
					reason: "aborted",
					error: {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage,
						stopReason: "aborted",
						timestamp: 0,
					},
				});
			},
			{ once: true },
		);
		started();
		return stream;
	});
	seed(agent);
	const oldHistory = [...agent.state.messages];
	const pending = agent.prompt("request");
	await began;
	assert.equal(agent.compactionState, "compacting");
	agent.abort();
	await pending;
	assert.equal(agent.compactionState, "idle");
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.messages.at(-1).stopReason, "aborted");
	assert.deepEqual(
		agent.state.messages.slice(0, oldHistory.length),
		oldHistory,
	);
	assert.ok(requests.every((request) => request.summary));
	await agent.prompt("retry");
	assert.equal(requests.at(-1).summary, false);
	assert.equal(agent.compactionState, "idle");
});

for (const failure of ["error", "empty", "length", "throw", "too-large"]) {
	test(`summary ${failure} adds a safe history error and blocks only this conversation`, async () => {
		const { agent, requests } = setup((request) => {
			if (!request.summary)
				assert.fail("Must not run a conversational request after failure");
			if (failure === "throw") throw new Error("secret");
			return answer(
				failure === "empty"
					? ""
					: failure === "too-large"
						? "z".repeat(36000)
						: "bad",
				failure === "error"
					? "error"
					: failure === "length"
						? "length"
						: "stop",
			);
		});
		seed(agent);
		const oldHistory = [...agent.state.messages];
		await agent.prompt("pending request");
		assert.equal(agent.compactionState, "failed");
		assert.equal(agent.state.isStreaming, false);
		assert.match(
			agent.state.messages.at(-1).errorMessage,
			/compaction failed.*no longer accept/,
		);
		assert.equal(
			JSON.stringify(agent.state.messages).includes("sensitive raw failure"),
			false,
		);
		assert.deepEqual(
			agent.state.messages.slice(0, oldHistory.length),
			oldHistory,
		);
		const count = requests.length,
			historyLength = agent.state.messages.length;
		await assert.rejects(agent.prompt("not accepted"), /compaction failed/);
		assert.throws(() => agent.continue(), /compaction failed/);
		assert.equal(requests.length, count);
		assert.equal(agent.state.messages.length, historyLength);
		const other = setup();
		await other.agent.prompt("independent conversation");
		assert.equal(other.agent.compactionState, "idle");
	});
}

test("switching to a smaller model reevaluates the budget and uses that model to summarize", async () => {
	const { agent, requests } = setup();
	agent.state.model = { ...model, contextWindow: 200000 };
	seed(agent);
	await agent.prompt("large-model request");
	assert.ok(requests.every((request) => !request.summary));
	agent.state.model = { ...model, id: "smaller-model" };
	await agent.prompt("small-model request");
	assert.ok(
		requests.some(
			(request) => request.summary && request.model.id === "smaller-model",
		),
	);
});

test("oversized latest input fails safely rather than truncating it or sending oversized context", async () => {
	const { agent, requests } = setup();
	const text = `oversized ${"x".repeat(60000)}`;
	await agent.prompt(text);
	assert.equal(agent.compactionState, "failed");
	assert.equal(requests.length, 0);
	assert.equal(agent.state.messages[1].content[0].text, text);
});
