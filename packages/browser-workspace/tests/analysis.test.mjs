import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserWorkspace } from "../src/workspace.ts";
import { analyze, emptyGraph } from "./fixtures.mjs";
const storage = () => ({ getItem: () => null, setItem() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("revision publication ignores obsolete completions, retains agents and aborts removed anchors on storage failure", async () => {
	const requests = [],
		store = storage();
	const workspace = new BrowserWorkspace(store, {
		streamFn() {
			throw Error("not expected");
		},
		compiler: {
			analyze: (files, signal) =>
				new Promise((resolve, reject) =>
					requests.push({ files, signal, resolve, reject }),
				),
			check: async () => ({ diagnostics: [] }),
		},
	});
	const discovery = workspace.getScopes();
	await tick();
	requests[0].resolve(await analyze());
	const [service] = await discovery;
	const agent = await service.getAgent();
	let aborts = 0;
	agent.abort = () => aborts++;
	const original = workspace.read("main.bal");
	workspace.write("main.bal", `${original}\n`);
	const revision = workspace.analysisSnapshot().revision;
	assert.equal(workspace.analysisSnapshot().kind, "pending");
	workspace.write("main.bal", original);
	assert.ok(workspace.analysisSnapshot().revision > revision);
	assert.ok(requests[1].signal.aborted);
	requests[2].resolve(await analyze());
	await tick();
	const current = workspace.analysisSnapshot();
	requests[1].resolve({
		kind: "invalid",
		diagnostics: [{ severity: "error", message: "obsolete" }],
	});
	await tick();
	assert.equal(workspace.analysisSnapshot(), current);
	assert.equal((await workspace.getScopes())[0], service);
	assert.equal(await service.getAgent(), agent);
	workspace.write("main.bal", "public function main() {}");
	requests[3].resolve({
		kind: "valid",
		diagnostics: [],
		program: { scopes: [], sources: {}, functions: {} },
	});
	await tick();
	assert.deepEqual(await workspace.getScopes(), []);
	store.setItem = () => {
		throw Error("Quota exceeded");
	};
	assert.throws(() => workspace.write("main.bal", "not saved"), /Quota/);
	assert.equal(aborts, 1);
});
test("initial invalid and failed analysis settle discovery without invented anchors; aborted flow rejects", async () => {
	for (const result of [
		{
			kind: "invalid",
			diagnostics: [{ severity: "error", message: "invalid" }],
		},
		Error("runtime unavailable"),
	]) {
		const workspace = new BrowserWorkspace(storage(), {
			streamFn() {},
			compiler: {
				analyze: async () => {
					if (result instanceof Error) throw result;
					return result;
				},
			},
		});
		assert.deepEqual(await workspace.getScopes(), []);
		assert.equal(
			workspace.analysisSnapshot().kind,
			result instanceof Error ? "failed" : "invalid",
		);
	}
	const workspace = new BrowserWorkspace(storage(), {
		streamFn() {},
		compiler: { analyze },
	});
	const [service] = await workspace.getScopes();
	await assert.rejects(service.getFlowUI(AbortSignal.abort()), {
		name: "AbortError",
	});
});
test("a declaration removed by a valid model gets a new agent if recreated with the same signature", async () => {
	let next = await analyze();
	const store = storage();
	const workspace = new BrowserWorkspace(store, {
		streamFn() {},
		compiler: { analyze: async () => next },
	});
	const [old] = await workspace.getScopes();
	const oldAgent = await old.getAgent();
	let aborts = 0;
	oldAgent.abort = () => aborts++;
	next = {
		kind: "valid",
		diagnostics: [],
		program: { scopes: [], sources: {}, functions: {} },
	};
	workspace.write("main.bal", "public function main() {}");
	await tick();
	assert.deepEqual(await workspace.getScopes(), []);
	next = await analyze();
	workspace.write("main.bal", "service / on new http:Listener(8080) {}");
	await tick();
	const [created] = await workspace.getScopes();
	assert.notEqual(created, old);
	assert.notEqual(await created.getAgent(), oldAgent);
	store.setItem = () => {
		throw Error("Quota exceeded");
	};
	assert.throws(() => workspace.write("main.bal", "not saved"), /Quota/);
	assert.equal(aborts, 1);
});
test("storage failure aborts retained service, endpoint and Automation agents", async () => {
	const base = await analyze(),
		service = base.program.scopes[0],
		source = service.source;
	service.endpoints = [
		{
			id: "endpoint",
			kind: "resource",
			title: "get /",
			source,
			text: "",
			functionId: "resource",
		},
	];
	base.program.scopes.push({
		id: "automation",
		kind: "automation",
		title: "Automation",
		moduleId: "other",
		source,
		text: "",
		functionId: "main",
	});
	base.program.functions = {
		resource: emptyGraph(
			{ id: "resource", source, text: "" },
			service.moduleId,
		),
		main: emptyGraph({ id: "main", source, text: "" }, "other"),
	};
	for (const located of [
		...base.program.scopes,
		...service.endpoints,
		...Object.values(base.program.functions),
	])
		base.program.sources[located.id] = located;
	const store = storage(),
		workspace = new BrowserWorkspace(store, {
			streamFn() {},
			compiler: { analyze: async () => base },
		}),
		scopes = await workspace.getScopes();
	const anchors = [...scopes, ...scopes[0].getEndpoints()];
	assert.equal(anchors.length, 3);
	const aborted = [];
	for (const anchor of anchors) {
		const agent = await anchor.getAgent();
		agent.abort = () => aborted.push(anchor.id);
	}
	store.setItem = () => {
		throw Error("Quota exceeded");
	};
	assert.throws(() => workspace.write("main.bal", "not saved"), /Quota/);
	assert.deepEqual(new Set(aborted), new Set(anchors.map((a) => a.id)));
});
