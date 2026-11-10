import { beforeEach, expect, mock, test } from "bun:test";

import { createFs } from "./test-fs";

let releaseReady: () => void = () => {};
let failReady: (reason: unknown) => void = () => {};
let ready: Promise<void>;
let getDiagnostics = mock(async (..._args: unknown[]) => [{ message: "boom" }]);

// Keep the real exports: mock.module leaks into other test files in this process.
const realClientModule = await import("../src/workers/ballerina-worker-client");
mock.module("@/workers/ballerina-worker-client", () => ({
	...realClientModule,
	getBallerinaWorkerClient: () => ({
		whenReady: () => ready,
		getDiagnostics: (...args: unknown[]) => getDiagnostics(...args),
	}),
}));
mock.module("@/stores/file-tree-store", () => ({
	useFileTreeStore: {
		getState: () => ({
			ready: true,
			saveFile: async () => {},
			// No Ballerina.toml, so the real project-target lookup returns the uri.
			// Don't mock project-target: the mock would leak into its own suites.
			fs: () => createFs(new Map()),
		}),
	},
}));
mock.module("@/lib/fs/snapshot", () => ({
	SnapshotFS: { from: async () => ({}) },
}));

const { BallerinaLS } = await import("../src/lib/ballerina-ls");

const uri = "file:///tmp/main.bal";

function notify(ls: InstanceType<typeof BallerinaLS>, method: string) {
	ls.send(
		JSON.stringify({
			jsonrpc: "2.0",
			method,
			params: { textDocument: { uri } },
		}),
	);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	getDiagnostics = mock(async (..._args: unknown[]) => [{ message: "boom" }]);
	ready = new Promise<void>((resolve, reject) => {
		releaseReady = resolve;
		failReady = reject;
	});
	ready.catch(() => undefined);
});

test("diagnostics are published only after the wasm is ready", async () => {
	const ls = new BallerinaLS();
	const published: string[] = [];
	ls.subscribe((m) => published.push(m));

	notify(ls, "textDocument/didOpen");
	await flush();
	expect(published).toHaveLength(0);
	expect(getDiagnostics).not.toHaveBeenCalled();

	releaseReady();
	await flush();
	expect(published).toHaveLength(1);
	expect(JSON.parse(published[0] as string).params.diagnostics).toEqual([
		{ message: "boom" },
	]);
});

test("only the latest change is processed once ready", async () => {
	const ls = new BallerinaLS();
	const published: string[] = [];
	ls.subscribe((m) => published.push(m));

	notify(ls, "textDocument/didOpen");
	notify(ls, "textDocument/didChange");
	notify(ls, "textDocument/didChange");
	releaseReady();
	await flush();

	expect(getDiagnostics).toHaveBeenCalledTimes(1);
	expect(published).toHaveLength(1);
});

test("nothing is published when loading fails", async () => {
	const ls = new BallerinaLS();
	const published: string[] = [];
	ls.subscribe((m) => published.push(m));

	notify(ls, "textDocument/didOpen");
	failReady(new Error("load failed"));
	await flush();

	expect(getDiagnostics).not.toHaveBeenCalled();
	expect(published).toHaveLength(0);
});

test("a superseded in-flight request does not overwrite newer diagnostics", async () => {
	const ls = new BallerinaLS();
	const published: string[] = [];
	ls.subscribe((m) => published.push(m));
	releaseReady();

	let finishFirst: (d: unknown[]) => void = () => {};
	getDiagnostics = mock(
		(..._args: unknown[]) =>
			new Promise<unknown[]>((resolve) => {
				finishFirst = resolve;
			}),
	) as typeof getDiagnostics;
	notify(ls, "textDocument/didOpen");
	await flush();

	getDiagnostics = mock(async (..._args: unknown[]) => [{ message: "new" }]);
	notify(ls, "textDocument/didChange");
	await flush();

	finishFirst([{ message: "stale" }]);
	await flush();

	expect(published).toHaveLength(1);
	expect(JSON.parse(published[0] as string).params.diagnostics).toEqual([
		{ message: "new" },
	]);
});

test("a superseded failing request publishes no empty diagnostics", async () => {
	const ls = new BallerinaLS();
	const published: string[] = [];
	ls.subscribe((m) => published.push(m));
	releaseReady();

	let failFirst: (reason: unknown) => void = () => {};
	getDiagnostics = mock(
		(..._args: unknown[]) =>
			new Promise<unknown[]>((_resolve, reject) => {
				failFirst = reject;
			}),
	) as typeof getDiagnostics;
	notify(ls, "textDocument/didOpen");
	await flush();

	getDiagnostics = mock(async (..._args: unknown[]) => [{ message: "new" }]);
	notify(ls, "textDocument/didChange");
	await flush();

	failFirst(new Error("boom"));
	await flush();

	expect(published).toHaveLength(1);
	expect(JSON.parse(published[0] as string).params.diagnostics).toEqual([
		{ message: "new" },
	]);
});
