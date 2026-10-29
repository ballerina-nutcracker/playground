import { beforeAll, expect, test } from "bun:test";

import { createFs } from "./test-fs";
import { SnapshotFS } from "../src/lib/fs/snapshot";
import "../src/wasm_exec";

import type { RunEvent } from "../src/workers/ballerina-worker-api";

interface TestCase {
	name: string;
	files: () => Promise<Map<string, string>>;
	entryPoint: string;
	expectedStdout?: string;
	expectedStderr?: string;
}

async function load(path: string) {
	return await Bun.file(new URL(path, import.meta.url)).text();
}

async function runBallerina(
	files: Map<string, string>,
	entryPoint: string,
): Promise<{ stdout: string; stderr: string }> {
	const fs = await SnapshotFS.from(createFs(files), "/");
	const output = { stdout: "", stderr: "" };
	const onEvent = (event: RunEvent) => {
		if (event.type === "output") output[event.stream] += event.text;
	};

	try {
		await globalThis.run(fs, entryPoint, onEvent);
		return output;
	} finally {
		fs.dispose();
	}
}

beforeAll(async () => {
	const go = new globalThis.Go();
	const { instance } = await WebAssembly.instantiateStreaming(
		fetch(new URL("../public/ballerina.wasm", import.meta.url).href),
		go.importObject,
	);
	go.run(instance);
});

const testCases: TestCase[] = [
	{
		name: "hello world",
		files: async () =>
			new Map([["/tmp/main.bal", await load("./fixtures/hello-world.bal")]]),
		entryPoint: "/tmp/main.bal",
		expectedStdout: "Hello, World!\n",
	},

	{
		name: "hello world (package)",
		files: async () =>
			new Map([
				[
					"/tmp/hello-world/main.bal",
					await load("./fixtures/hello-world/main.bal"),
				],
				[
					"/tmp/hello-world/Ballerina.toml",
					await load("./fixtures/hello-world/Ballerina.toml"),
				],
			]),
		entryPoint: "/tmp/hello-world",
		expectedStdout: "Hello, World!\n",
	},
	{
		name: "file read/write",
		files: async () =>
			new Map([
				["/tmp/main.bal", await load("./fixtures/file-read-write.bal")],
			]),
		entryPoint: "/tmp/main.bal",
		expectedStdout:
			"true\ntrue\ntrue\ntrue\n<book><title>Clean Code</title></book>\ntrue\n",
	},
	{
		name: "file stream read/write",
		files: async () =>
			new Map([
				["/tmp/main.bal", await load("./fixtures/file-stream-read-write.bal")],
				["/tmp/nested/lines.txt", "stale\n"],
				["/tmp/nested/blocks.bin", "ZZ"],
				["/tmp/input-lines.txt", "Alpha\nBeta\n"],
				["/tmp/append-lines.txt", "Gamma\n"],
				["/tmp/input-blocks.bin", "AB"],
				["/tmp/append-blocks.bin", "CD"],
			]),
		entryPoint: "/tmp/main.bal",
		expectedStdout: "true\ntrue\n",
	},
	{
		name: "file API",
		files: async () =>
			new Map([["/tmp/main.bal", await load("./fixtures/file-api.bal")]]),
		entryPoint: "/tmp/main.bal",
		expectedStdout:
			"true\n2\ntrue\ntrue\ntrue\ncopied content\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\nfalse\nfalse\ntrue\ntrue\nfalse\n",
	},
	{
		name: "file API defaults temporary files to the working directory",
		files: async () =>
			new Map([
				[
					"/local/project/main.bal",
					await load("./fixtures/file-temp-default.bal"),
				],
			]),
		entryPoint: "/local/project/main.bal",
		expectedStdout: "true\ntrue\n",
	},
	{
		name: "os env",
		files: async () =>
			new Map([["/tmp/main.bal", await load("./fixtures/os-env.bal")]]),
		entryPoint: "/tmp/main.bal",
		expectedStdout: "true\ntrue\ntrue\ntrue\ntrue\n",
	},
	{
		name: "unsupported UDP networking",
		files: async () =>
			new Map([
				["/tmp/main.bal", await load("./fixtures/udp-unsupported.bal")],
			]),
		entryPoint: "/tmp/main.bal",
		expectedStderr:
			"error: Can't connect to remote host: Network sockets are not supported in Playground\n",
	},
];

test("directory listener handles reentrant writes, self-stop, and a fresh run", async () => {
	const source = await load("../../../e2e/fixtures/directory-listener.bal");
	const runtime = globalThis as typeof globalThis & {
		sendStopSignal(): boolean;
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const fs = await SnapshotFS.from(
			createFs(new Map([["/tmp/main.bal", source]])),
			"/",
		);
		let stdout = "";
		let stderr = "";
		const ready = Promise.withResolvers<void>();
		const run = globalThis.run(fs, "/tmp/main.bal", (event: RunEvent) => {
			if (event.type !== "output") return;
			if (event.stream === "stdout") stdout += event.text;
			else stderr += event.text;
			if (stdout.includes("watch stopped\n")) ready.resolve();
		});
		try {
			await Promise.race([
				ready.promise,
				run.then(() => {
					throw new Error(`Run exited before watch events: ${stderr}`);
				}),
			]);
			expect(stdout).toBe(
				"create:item.txt\nmodify:item.txt\ndelete:item.txt\ncreate:renamed.txt\nwatch stopped\n",
			);
			expect(stderr).toBe("");
		} finally {
			runtime.sendStopSignal();
			await run;
			fs.dispose();
		}
	}
}, 20_000);

for (const tc of testCases) {
	test(tc.name, async () => {
		const files = await tc.files();
		const result = await runBallerina(files, tc.entryPoint);
		expect(result.stdout).toBe(tc.expectedStdout ?? "");
		expect(result.stderr).toBe(tc.expectedStderr ?? "");
	});
}
