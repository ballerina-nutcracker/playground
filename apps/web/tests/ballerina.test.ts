import { beforeAll, expect, test } from "bun:test";

import { createFs } from "./test-fs";
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
	const fs = createFs(files);
	const output = { stdout: "", stderr: "" };
	const onEvent = (event: RunEvent) => {
		if (event.type === "output") output[event.stream] += event.text;
	};

	await globalThis.run(fs, entryPoint, onEvent);
	return output;
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
		name: "os env",
		files: async () =>
			new Map([["/tmp/main.bal", await load("./fixtures/os-env.bal")]]),
		entryPoint: "/tmp/main.bal",
		expectedStdout: "true\ntrue\ntrue\ntrue\ntrue\n",
	},
];

for (const tc of testCases) {
	test(tc.name, async () => {
		const files = await tc.files();
		const result = await runBallerina(files, tc.entryPoint);
		expect(result.stdout).toBe(tc.expectedStdout ?? "");
		expect(result.stderr).toBe(tc.expectedStderr ?? "");
	});
}
