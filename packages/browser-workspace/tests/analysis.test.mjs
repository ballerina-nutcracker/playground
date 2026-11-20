import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserWorkspace } from "../src/workspace.ts";
import { analyze } from "./fixtures.mjs";
const storage = () => ({ getItem: () => null, setItem() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("revision publication ignores obsolete completions, retains the chat and aborts it on storage failure", async () => {
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
	const agent = await workspace.getAgent();
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
	assert.equal(await workspace.getAgent(), agent);
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
