import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserWorkspace } from "../src/workspace.ts";
import { createWorkspaceAgent } from "../src/agent.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const storage = () => {
	const data = new Map();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => data.set(key, value),
	};
};
const source = {
	file: "main.bal",
	range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
};
/** A valid analysis of `service /notes` with one resource named `name`. */
function program(name) {
	const serviceId = "m/service/main.bal//notes/1";
	const endpoint = {
		id: `${serviceId}/resource/get/${name}`,
		kind: "resource",
		title: `get ${name}`,
		functionId: `${serviceId}/resource/get/${name}`,
		source,
		text: name,
	};
	const service = {
		id: serviceId,
		kind: "service",
		title: "/notes",
		moduleId: "m",
		serviceType: "http",
		endpoints: [endpoint],
		definitions: [],
		source,
		text: `service ${name}`,
	};
	return {
		kind: "valid",
		diagnostics: [],
		program: {
			scopes: [service],
			sources: { [service.id]: service, [endpoint.id]: endpoint },
			functions: {},
		},
	};
}
function workspaceWith(analysis, store = storage()) {
	let next = analysis;
	const workspace = new BrowserWorkspace(store, {
		streamFn() {
			throw new Error("No model request expected");
		},
		compiler: { analyze: async () => next },
	});
	return { workspace, store, setAnalysis: (value) => (next = value) };
}

test("the workspace owns one chat that survives renaming a resource and its service", async () => {
	const { workspace, setAnalysis } = workspaceWith(program("first"));
	await workspace.getScopes();
	const [agent, sameAgent] = await Promise.all([
		workspace.getAgent(),
		workspace.getAgent(),
	]);
	assert.equal(agent, sameAgent);
	agent.state.messages = [
		{ role: "user", content: "Add caching", timestamp: 0 },
	];
	setAnalysis(program("one"));
	workspace.write("main.bal", "renamed");
	await tick();
	const [service] = await workspace.getScopes();
	assert.equal(service.getEndpoints()[0].title, "get one");
	const after = await workspace.getAgent();
	assert.equal(after, agent);
	assert.equal(after.state.messages[0].content, "Add caching");
});

test("the workspace chat survives a model with no scopes", async () => {
	const { workspace, setAnalysis } = workspaceWith(program("first"));
	await workspace.getScopes();
	const agent = await workspace.getAgent();
	setAnalysis({
		kind: "valid",
		diagnostics: [],
		program: { scopes: [], sources: {}, functions: {} },
	});
	workspace.write("main.bal", "public function main() {}");
	await tick();
	assert.deepEqual(await workspace.getScopes(), []);
	assert.equal(await workspace.getAgent(), agent);
});

test("newChat aborts the current chat and starts an empty one", async () => {
	const { workspace } = workspaceWith(program("first"));
	const old = await workspace.getAgent();
	old.state.messages = [{ role: "user", content: "old", timestamp: 0 }];
	let aborts = 0;
	old.abort = () => aborts++;
	const fresh = await workspace.newChat();
	assert.equal(aborts, 1);
	assert.notEqual(fresh, old);
	assert.equal(await workspace.getAgent(), fresh);
	assert.equal(fresh.state.messages.filter((m) => m.role === "user").length, 0);
});

test("storage failure and dispose abort the workspace chat", async () => {
	const { workspace, store } = workspaceWith(program("first"));
	const agent = await workspace.getAgent();
	let aborts = 0;
	agent.abort = () => aborts++;
	store.setItem = () => {
		throw Error("Quota exceeded");
	};
	assert.throws(() => workspace.write("main.bal", "not saved"), /Quota/);
	assert.equal(aborts, 1);
	workspace.dispose();
	assert.equal(aborts, 2);
});

test("the workspace chat requires a model stream transport", async () => {
	const workspace = new BrowserWorkspace(storage());
	await assert.rejects(workspace.getAgent(), /model stream transport/);
});

test("the agent's system prompt names no fixed scope", () => {
	const agent = createWorkspaceAgent(
		new BrowserWorkspace(storage()),
		undefined,
		() => {
			throw new Error("No request expected");
		},
	);
	assert.doesNotMatch(agent.state.systemPrompt, /initial focus/);
	assert.match(agent.state.systemPrompt, /source-references/);
});
