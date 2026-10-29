import {
	analyze,
	testAgentScope,
} from "../../../../packages/browser-workspace/tests/fixtures.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createWorkspaceAgent,
	BrowserWorkspace,
} from "@bal-bot/browser-workspace";
import {
	models,
	providerOptions,
	getAccounts,
	loginProvider,
	logoutProvider,
	streamBrowser,
} from "../../src/components/bal-bot/providers.ts";

const model = models
	.getModels("openai")
	.find((model) => model.api === "openai-responses");
const key = "sk-browser-test-key";
const response = (events) => {
	const bytes = new TextEncoder().encode(
		events
			.map(
				(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
	);
	return new Response(
		new ReadableStream({
			start(controller) {
				// Exercise incremental SSE parsing, including UTF-8 split across chunks.
				for (let i = 0; i < bytes.length; i++)
					controller.enqueue(bytes.slice(i, i + 1));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "text/event-stream" } },
	);
};
const completion = {
	type: "response.completed",
	response: { id: "resp_test", status: "completed", output: [] },
};
const textEvents = (text) => {
	const item = {
		type: "message",
		id: "msg_test",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, content: [] },
		},
		{
			type: "response.output_text.delta",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		completion,
	];
};
const toolEvents = (name, args, id = "1") => {
	const item = {
		type: "function_call",
		id: `fc_${id}`,
		call_id: `call_${id}`,
		name,
		arguments: JSON.stringify(args),
	};
	return [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			output_index: 0,
			delta: item.arguments,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		completion,
	];
};
async function connected(t) {
	await loginProvider("openai", key);
	const originalFetch = globalThis.fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await logoutProvider("openai");
	});
}
function request(url, options) {
	assert.equal(String(url), "https://api.openai.com/v1/responses");
	const headers = new Headers(options.headers);
	assert.equal(headers.get("authorization"), `Bearer ${key}`);
	assert.equal(headers.has("X-Bal-Bot-Session"), false);
	const input = JSON.parse(options.body);
	assert.equal(input.apiKey, undefined);
	return input;
}

test("Gemini and OpenRouter expose only curated latest models in selection order", async () => {
	const accounts = await getAccounts();
	const expected = {
		google: ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.5-flash-lite"],
		openrouter: [
			"openai/gpt-6.1-sol",
			"openai/gpt-6-astra",
			"openai/gpt-6-luna",
			"anthropic/claude-sonnet-5.5",
			"anthropic/claude-opus-5.5",
			"anthropic/claude-haiku-5.5",
			"google/gemini-4-argon",
			"google/gemini-3.8-flash",
			"google/gemini-3.5-flash-lite",
			"recursive/flint-v1.0:free",
			"minimax/minimax-m3.1-flash",
			"deepseek/deepseek-v4.1-flash-1017",
			"reflection/beam-1.0-501b-a23b",
			"inception/mercury-3",
			"meta/muse-spark-open",
			"nvidia/nemotron-3.5-super-vl:free",
			"mistralai/mistral-large-4-0",
		],
	};
	for (const [id, ids] of Object.entries(expected)) {
		assert.deepEqual(
			accounts
				.find((account) => account.id === id)
				.models.map((model) => model.id),
			ids,
		);
	}
});

test("browser PI login and logout update in-memory provider accounts without a backend", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await logoutProvider("openai");
	});
	globalThis.fetch = async () => {
		throw new Error("Credentials must not be sent to a backend");
	};
	assert.equal(
		(await getAccounts()).find((account) => account.id === "openai").connected,
		false,
	);
	await loginProvider("openai", key);
	const account = (await getAccounts()).find(
		(account) => account.id === "openai",
	);
	assert.equal(account.connected, true);
	assert.ok(account.models.length > 0);
	assert.equal(JSON.stringify(await getAccounts()).includes(key), false);
	await logoutProvider("openai");
	assert.equal(
		(await getAccounts()).find((account) => account.id === "openai").connected,
		false,
	);
});

test("all four provider credentials are independent, trimmed, replaceable, and memory-only", async (t) => {
	const ids = ["openai", "anthropic", "google", "openrouter"];
	assert.deepEqual(
		providerOptions.map((provider) => provider.id),
		ids,
	);
	const originalFetch = globalThis.fetch;
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await Promise.all(ids.map(logoutProvider));
	});
	globalThis.fetch = async () => {
		throw new Error("Login must not make network requests");
	};
	for (const id of ids) {
		await loginProvider(id, `  secret-${id}  `);
		assert.equal((await models.getAuth(id)).auth.apiKey, `secret-${id}`);
		const account = (await getAccounts()).find((account) => account.id === id);
		assert.equal(account.connected, true);
		assert.ok(account.models.length > 0);
	}
	await loginProvider("google", "replacement-google");
	assert.equal(
		(await models.getAuth("google")).auth.apiKey,
		"replacement-google",
	);
	for (const id of ids) {
		assert.equal(
			JSON.stringify(await getAccounts()).includes(`secret-${id}`),
			false,
		);
		await logoutProvider(id);
		assert.equal(await models.getAuth(id), undefined);
		assert.equal(
			(await getAccounts()).find((account) => account.id === id).connected,
			false,
		);
		for (const other of ids.slice(ids.indexOf(id) + 1)) {
			assert.equal(
				(await models.getAuth(other)).auth.apiKey,
				other === "google" ? "replacement-google" : `secret-${other}`,
			);
		}
		await logoutProvider(id); // Forgetting an already absent key is safe.
	}
});

test("empty keys and unknown providers are rejected without altering existing credentials", async (t) => {
	t.after(async () => {
		await Promise.all(providerOptions.map(({ id }) => logoutProvider(id)));
	});
	for (const { id } of providerOptions) {
		await loginProvider(id, `retained-${id}`);
		for (const empty of ["", "   ", "\t\n"]) {
			await assert.rejects(loginProvider(id, empty), /Enter an API key/);
			assert.equal((await models.getAuth(id)).auth.apiKey, `retained-${id}`);
		}
	}
	for (const id of ["", "unknown", "OpenAI", "__proto__"]) {
		await assert.rejects(loginProvider(id, "secret-not-in-error"), {
			message: "Unknown provider",
		});
		await assert.rejects(logoutProvider(id), { message: "Unknown provider" });
	}
});

test("new module instances do not restore credentials from storage or host environment", async (t) => {
	const previous = process.env.OPENAI_API_KEY;
	t.after(async () => {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
		await logoutProvider("openai");
	});
	process.env.OPENAI_API_KEY = "host-key-must-not-be-used";
	await loginProvider("openai", key);
	const fresh = await import(
		`../../src/components/bal-bot/providers.ts?auth-isolation=${Date.now()}`
	);
	assert.deepEqual(
		(await fresh.getAccounts()).map((account) => account.connected),
		[false, false, false, false],
	);
	assert.equal(await fresh.models.getAuth("openai"), undefined);
	assert.equal((await models.getAuth("openai")).auth.apiKey, key);
});

test("provider errors never expose raw response bodies or credentials in stream events", async (t) => {
	await connected(t);
	for (const failure of ["http", "network"]) {
		globalThis.fetch = async () => {
			const detail = `Sensitive provider detail ${key}`;
			if (failure === "network") throw new Error(detail);
			return new Response(JSON.stringify({ error: { message: detail } }), {
				status: 401,
			});
		};
		const events = [];
		for await (const event of streamBrowser(model, { messages: [] }))
			events.push(event);
		const error = events.at(-1);
		assert.equal(error.type, "error");
		assert.equal(error.error.stopReason, "error");
		assert.match(error.error.errorMessage, /Check your API key/);
		assert.equal(JSON.stringify(events).includes(key), false);
		assert.equal(
			JSON.stringify(events).includes("Sensitive provider detail"),
			false,
		);
	}
});

test("browser PI executes streamed file tools and sends results directly to the provider", async (t) => {
	await connected(t);
	const requests = [];
	globalThis.fetch = async (url, options) => {
		requests.push(request(url, options));
		return response(
			requests.length === 1
				? toolEvents("write_file", {
						path: "generated.bal",
						content: "// hello from PI",
					})
				: textEvents("Created your file. ✓"),
		);
	};
	const workspace = new BrowserWorkspace({ getItem: () => null, setItem() {} });
	const agent = createWorkspaceAgent(
		workspace,
		model,
		streamBrowser,
		testAgentScope,
	);
	await agent.prompt("Create generated.bal");
	assert.equal(workspace.read("generated.bal"), "// hello from PI");
	assert.equal(requests.length, 2);
	assert.ok(
		requests[1].input.some(
			(item) =>
				item.type === "function_call_output" && item.call_id === "call_1",
		),
	);
	assert.equal(
		agent.state.messages.at(-1).content[0].text,
		"Created your file. ✓",
	);
});

test("direct provider streaming forwards text and settles premature EOF as an error", async (t) => {
	await connected(t);
	globalThis.fetch = async (url, options) => {
		request(url, options);
		return response(textEvents("Hello ✓"));
	};
	const events = [];
	for await (const event of streamBrowser(model, { messages: [] }))
		events.push(event);
	assert.ok(
		events.some(
			(event) => event.type === "text_delta" && event.delta === "Hello ✓",
		),
	);
	assert.equal(events.at(-1).type, "done");
	globalThis.fetch = async () => response([]);
	const failed = await streamBrowser(model, { messages: [] }).result();
	assert.equal(failed.stopReason, "error");
	assert.match(failed.errorMessage, /without|before|terminal/i);
});

test("stopping a browser agent aborts the direct provider request and settles the turn", async (t) => {
	await connected(t);
	let began;
	const started = new Promise((resolve) => {
		began = resolve;
	});
	let requestSignal;
	globalThis.fetch = async (url, options) =>
		new Promise((_, reject) => {
			request(url, options);
			requestSignal = options.signal;
			began();
			options.signal.addEventListener(
				"abort",
				() => reject(options.signal.reason),
				{ once: true },
			);
		});
	const workspace = new BrowserWorkspace({ getItem: () => null, setItem() {} });
	const agent = createWorkspaceAgent(
		workspace,
		model,
		streamBrowser,
		testAgentScope,
	);
	const pending = agent.prompt("Wait");
	await started;
	agent.abort();
	await pending;
	assert.equal(requestSignal.aborted, true);
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.messages.at(-1).stopReason, "aborted");
});

test("agent repairs source after diagnostics and rechecks the retained workspace", async (t) => {
	await connected(t);
	const calls = [
		["write_file", { path: "main.bal", content: 'int x = "bad";' }],
		["get_diagnostics", {}],
		["edit_file", { path: "main.bal", oldText: '"bad"', newText: "1" }],
		["get_diagnostics", {}],
	];
	let step = 0;
	globalThis.fetch = async (url, options) => {
		const input = request(url, options);
		if (step === 2) {
			const diagnostic = input.input.find(
				(item) =>
					item.type === "function_call_output" && item.call_id === "call_2",
			);
			assert.equal(
				JSON.parse(diagnostic.output).diagnostics[0].severity,
				"error",
			);
		}
		const call = calls[step++];
		return response(
			call
				? toolEvents(call[0], call[1], String(step))
				: textEvents("Checked the repaired source."),
		);
	};
	const workspace = new BrowserWorkspace(
		{ getItem: () => null, setItem() {} },
		{
			streamFn: streamBrowser,
			compiler: {
				analyze,
				async check(files) {
					return {
						diagnostics: files["main.bal"].includes("bad")
							? [{ severity: "error", message: "type error", file: "main.bal" }]
							: [],
					};
				},
			},
		},
	);
	const [service] = await workspace.getServices();
	const agent = await service.getAgent();
	agent.state.model = model;
	await agent.prompt("Repair and check main.bal");
	assert.equal(workspace.read("main.bal"), "int x = 1;");
	const checks = agent.state.messages.filter(
		(message) =>
			message.role === "toolResult" && message.toolName === "get_diagnostics",
	);
	assert.equal(checks.length, 2);
	assert.deepEqual(JSON.parse(checks[1].content[0].text), {
		diagnostics: [],
		stale: false,
	});
	assert.equal(await service.getAgent(), agent);
});
