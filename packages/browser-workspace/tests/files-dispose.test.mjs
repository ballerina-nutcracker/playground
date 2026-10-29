import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserWorkspace, initialFiles } from "../src/workspace.ts";
import { analyze } from "./fixtures.mjs";

const storage = () => ({ getItem: () => null, setItem() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const streamFn = () => {
	throw new Error("not expected");
};

test("injected files replace the default project and reach the compiler", async () => {
	const files = {
		"Ballerina.toml": '[package]\nname = "demo"\n',
		"main.bal": "public function main() {}\n",
		"modules/util/util.bal": "public function f() {}\n",
	};
	const seen = [];
	const workspace = new BrowserWorkspace(storage(), {
		streamFn,
		compiler: {
			analyze: async (input) => {
				seen.push(input);
				return analyze();
			},
			check: async () => ({ diagnostics: [] }),
		},
	});
	assert.ok(workspace.list().includes("main.bal"));
	const injected = new BrowserWorkspace(storage(), {
		streamFn,
		files,
		compiler: {
			analyze: async (input) => {
				seen.push(input);
				return analyze();
			},
		},
	});
	assert.deepEqual(injected.list(), Object.keys(files).sort());
	assert.equal(injected.read("main.bal"), files["main.bal"]);
	await injected.getScopes();
	assert.deepEqual(seen.at(-1), files);
	files["main.bal"] = "mutated";
	assert.equal(injected.read("main.bal"), "public function main() {}\n");
});

test("without files the workspace starts with Hello World", () => {
	const workspace = new BrowserWorkspace(storage(), { streamFn });
	assert.deepEqual(workspace.list(), Object.keys(initialFiles).sort());
	assert.match(workspace.read("main.bal"), /Hello, World!/);
});

test("compiler rejection of injected files settles analysis without throwing", async () => {
	const files = { "Ballerina.toml": "", "nested/Ballerina.toml": "" };
	const invalid = new BrowserWorkspace(storage(), {
		streamFn,
		files,
		compiler: {
			analyze: async () => ({
				kind: "invalid",
				diagnostics: [{ severity: "error", message: "nested manifest" }],
			}),
		},
	});
	assert.deepEqual(await invalid.getScopes(), []);
	const state = invalid.analysisSnapshot();
	assert.equal(state.kind, "invalid");
	assert.equal(state.diagnostics[0].message, "nested manifest");
	const failed = new BrowserWorkspace(storage(), {
		streamFn,
		files,
		compiler: {
			analyze: async () => {
				throw new Error("workspace layout unsupported");
			},
		},
	});
	assert.deepEqual(await failed.getScopes(), []);
	assert.equal(failed.analysisSnapshot().kind, "failed");
	assert.match(failed.analysisSnapshot().message, /workspace layout/);
});

test("dispose aborts analysis and agents, silences listeners and is idempotent", async () => {
	const requests = [];
	let checks = 0;
	const workspace = new BrowserWorkspace(storage(), {
		streamFn,
		compiler: {
			analyze: (files, signal) =>
				new Promise((resolve) => requests.push({ files, signal, resolve })),
			check: async () => {
				checks++;
				return { diagnostics: [] };
			},
		},
	});
	const discovery = workspace.getScopes();
	await tick();
	requests[0].resolve(await analyze());
	const [service] = await discovery;
	const agent = await service.getAgent();
	let aborts = 0;
	agent.abort = () => aborts++;
	workspace.write("main.bal", `${workspace.read("main.bal")}\n`);
	assert.equal(requests.length, 2);
	let notified = 0;
	workspace.subscribe(() => notified++);
	workspace.subscribeAnalysis(() => notified++);
	workspace.subscribeStorage(() => notified++);

	workspace.dispose();
	assert.ok(requests[1].signal.aborted);
	assert.equal(aborts, 1);
	const state = workspace.analysisSnapshot();

	requests[1].resolve(await analyze());
	await tick();
	assert.equal(workspace.analysisSnapshot(), state);
	workspace.write("main.bal", "public function main() {}");
	await tick();
	assert.equal(requests.length, 2, "no analysis worker after dispose");
	await assert.rejects(workspace.getDiagnostics(), /disposed/);
	assert.equal(checks, 0);
	assert.equal(notified, 0);

	workspace.dispose();
	assert.equal(aborts, 1);
});

test("dispose before the first scheduled analysis starts no worker", async () => {
	let calls = 0;
	const workspace = new BrowserWorkspace(storage(), {
		streamFn,
		compiler: {
			analyze: async () => {
				calls++;
				return analyze();
			},
		},
	});
	workspace.dispose();
	await tick();
	assert.equal(calls, 0);
});
