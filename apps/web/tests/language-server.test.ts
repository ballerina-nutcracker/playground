import { describe, expect, mock, test } from "bun:test";

import { BallerinaLS } from "../src/lib/ballerina-ls";
import { languageServerFiles } from "../src/lib/language-server-files";
import {
	browserPathFromLanguageServerUri,
	languageServerPath,
	languageServerUri,
} from "../src/lib/language-server-uri";

import type { LanguageServerFileSource } from "../src/lib/ballerina-ls";
import type { LanguageServerFile } from "../src/workers/language-server-worker-api";
import type { LanguageServerConnection } from "../src/workers/language-server-worker-client";

const uri = languageServerUri("/local/demo/main.bal");
const otherUri = languageServerUri("/local/demo/other.bal");
const saved = languageServerFiles(
	[],
	[
		{
			kind: "dir",
			name: "demo",
			children: [
				{ kind: "file", name: "Ballerina.toml", content: "[package]" },
				{ kind: "file", name: "main.bal", content: "saved text" },
			],
		},
	],
);

function message(method: string, params: unknown = {}, id?: number) {
	return JSON.stringify({
		jsonrpc: "2.0",
		method,
		params,
		...(id === undefined ? {} : { id }),
	});
}

class TestFiles implements LanguageServerFileSource {
	entries = saved;
	listeners = new Set<() => void>();
	ready = async () => {};
	snapshot = () => this.entries;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	change(entries: LanguageServerFile[]) {
		this.entries = entries;
		for (const listener of this.listeners) listener();
	}
}

function setup() {
	const events: (
		| { type: "files"; entries: LanguageServerFile[] }
		| { type: "send"; value: string }
	)[] = [];
	let receive: (value: string) => void = () => {};
	const client: LanguageServerConnection = {
		init: mock(async (handler) => {
			receive = handler;
		}),
		send: mock(async (value) => {
			events.push({ type: "send", value });
		}),
		updateFiles: mock(async (entries) => {
			events.push({ type: "files", entries });
		}),
		dispose: mock(() => {}),
	};
	const files = new TestFiles();
	const transport = new BallerinaLS(client, files);
	const received: string[] = [];
	transport.subscribe((value) => {
		received.push(value);
	});
	return {
		transport,
		client,
		files,
		events,
		received,
		receive: (value: string) => receive(value),
	};
}

async function initialize(fixture: ReturnType<typeof setup>) {
	fixture.transport.send(message("initialize", {}, 1));
	fixture.transport.send(message("initialized"));
	await fixture.transport.whenIdle();
}

describe("language server URI mapping", () => {
	test("maps absolute and relative browser paths into one PAL workspace", () => {
		expect(languageServerUri("examples/main.bal")).toBe(
			"file:///workspace/examples/main.bal",
		);
		expect(languageServerPath("/tmp/examples/main.bal")).toBe(
			"/workspace/tmp/examples/main.bal",
		);
		expect(languageServerUri("/local/demo/./sub/../main.bal")).toBe(uri);
		expect(languageServerUri("/")).toBe("file:///workspace");
	});

	test("round-trips Unicode and URI-reserved characters without changing PAL paths", () => {
		const path = "/local/日本語/a b#%?😀.bal";
		const mapped = languageServerUri(path);
		expect(mapped).toContain("a%20b%23%25%3F%F0%9F%98%80.bal");
		expect(browserPathFromLanguageServerUri(mapped)).toBe(path);
		expect(languageServerPath(path)).toBe(`/workspace${path}`);
	});

	test("rejects traversal and non-workspace URIs", () => {
		expect(() => languageServerPath("../../main.bal")).toThrow();
		for (const value of [
			"https://example.com/workspace/main.bal",
			"file://host/workspace/main.bal",
			"file:///workspace2/main.bal",
			"file:///workspace/../main.bal",
			"file:///workspace/main.bal#fragment",
		]) {
			expect(() => browserPathFromLanguageServerUri(value)).toThrow();
		}
	});
});

describe("saved project snapshots", () => {
	test("includes namespace, empty and module directories plus all saved project files", () => {
		const entries = languageServerFiles(
			[],
			[
				{
					kind: "dir",
					name: "demo",
					children: [
						{ kind: "file", name: "Ballerina.toml", content: "[package]" },
						{ kind: "dir", name: "empty", children: [] },
						{
							kind: "dir",
							name: "modules",
							children: [
								{
									kind: "dir",
									name: "math",
									children: [
										{ kind: "file", name: "lib.bal", content: "module" },
									],
								},
							],
						},
					],
				},
			],
		);
		expect(entries).toEqual([
			{ path: "/workspace", isDir: true },
			{ path: "/workspace/tmp", isDir: true },
			{ path: "/workspace/local", isDir: true },
			{ path: "/workspace/local/demo", isDir: true },
			{
				path: "/workspace/local/demo/Ballerina.toml",
				isDir: false,
				content: "[package]",
			},
			{ path: "/workspace/local/demo/empty", isDir: true },
			{ path: "/workspace/local/demo/modules", isDir: true },
			{ path: "/workspace/local/demo/modules/math", isDir: true },
			{
				path: "/workspace/local/demo/modules/math/lib.bal",
				isDir: false,
				content: "module",
			},
		]);
	});
});

describe("ordered language server transport", () => {
	test("copies the saved snapshot before initialize/didOpen and forwards server capabilities unchanged", async () => {
		const fixture = setup();
		const { transport, events } = fixture;
		transport.send(message("initialize", {}, 1));
		transport.send(message("initialized"));
		transport.send(
			message("textDocument/didOpen", {
				textDocument: { uri, version: 1, text: "UNSAVED 😀" },
			}),
		);
		await transport.whenIdle();
		expect(events[0]).toEqual({ type: "files", entries: saved });
		expect(
			events
				.slice(1)
				.map((event) =>
					event.type === "send" ? JSON.parse(event.value).method : "files",
				),
		).toEqual(["initialize", "initialized", "textDocument/didOpen"]);
		const response = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: {
				capabilities: {
					textDocumentSync: 2,
					completionProvider: { triggerCharacters: [":"] },
					signatureHelpProvider: { triggerCharacters: ["(", ","] },
				},
			},
		});
		fixture.receive(response);
		expect(fixture.received).toEqual([response]);
		transport.dispose();
	});

	test("preserves request/cancellation order while WASM starts", async () => {
		const fixture = setup();
		let ready = () => {};
		const gate = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const init = fixture.client.init;
		fixture.client.init = async (handler) => {
			await gate;
			await init(handler);
		};
		const messages = [
			message("initialize", {}, 1),
			message("initialized"),
			message("textDocument/completion", { textDocument: { uri } }, 2),
			message("$/cancelRequest", { id: 2 }),
		];
		for (const value of messages) fixture.transport.send(value);
		await Promise.resolve();
		expect(fixture.events).toEqual([]);
		ready();
		await fixture.transport.whenIdle();
		expect(
			fixture.events.flatMap((event) =>
				event.type === "send" ? [event.value] : [],
			),
		).toEqual(messages);
		fixture.transport.dispose();
	});

	test("forwards completion positions, context and server items without adaptation", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.events.length = 0;
		const request = message(
			"textDocument/completion",
			{
				textDocument: { uri },
				position: { line: 4, character: 31 },
				context: { triggerKind: 2, triggerCharacter: "V" },
			},
			2,
		);
		fixture.transport.send(request);
		await fixture.transport.whenIdle();
		expect(fixture.events).toEqual([{ type: "send", value: request }]);
		const response = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			result: {
				isIncomplete: false,
				items: [
					{
						label: "unsavedValue",
						kind: 6,
						detail: "int",
						textEdit: {
							range: {
								start: { line: 4, character: 23 },
								end: { line: 4, character: 31 },
							},
							newText: "unsavedValue",
						},
					},
				],
			},
		});
		fixture.receive(response);
		expect(fixture.received).toEqual([response]);
		const empty = JSON.stringify({ jsonrpc: "2.0", id: 3, result: [] });
		fixture.transport.send(message("textDocument/completion", {}, 3));
		await fixture.transport.whenIdle();
		fixture.receive(empty);
		expect(fixture.received).toEqual([response, empty]);
		fixture.transport.dispose();
	});

	test("forwards signature help requests and responses without adaptation", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.events.length = 0;
		const request = message(
			"textDocument/signatureHelp",
			{
				textDocument: { uri },
				position: { line: 4, character: 18 },
				context: { triggerKind: 2, triggerCharacter: "(", isRetrigger: false },
			},
			2,
		);
		fixture.transport.send(request);
		await fixture.transport.whenIdle();
		expect(fixture.events).toEqual([{ type: "send", value: request }]);
		const response = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			result: {
				signatures: [
					{
						label: "add(int a, string 😀)",
						parameters: [{ label: [4, 9] }, { label: [11, 19] }],
					},
				],
				activeSignature: 0,
				activeParameter: 1,
			},
		});
		fixture.receive(response);
		const none = JSON.stringify({ jsonrpc: "2.0", id: 3, result: null });
		fixture.transport.send(message("textDocument/signatureHelp", {}, 3));
		await fixture.transport.whenIdle();
		fixture.receive(none);
		expect(fixture.received).toEqual([response, none]);
		fixture.transport.dispose();
	});

	test("didChange does not save unsaved buffers or notify file watchers", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.events.length = 0;
		const change = message("textDocument/didChange", {
			textDocument: { uri, version: 2 },
			contentChanges: [{ text: "unsaved é 😀" }],
		});
		fixture.transport.send(change);
		await fixture.transport.whenIdle();
		expect(fixture.events).toEqual([{ type: "send", value: change }]);
		expect(fixture.files.snapshot()).toBe(saved);
		fixture.transport.dispose();
	});

	test("atomically updates files before watched creation/change/deletion notifications", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.events.length = 0;
		const next = saved
			.filter((file) => !file.path.endsWith("Ballerina.toml"))
			.map((file) =>
				file.path.endsWith("main.bal")
					? { ...file, content: "new saved" }
					: file,
			);
		next.push({
			path: "/workspace/local/demo/other.bal",
			isDir: false,
			content: "new file",
		});
		fixture.files.change(next);
		await fixture.transport.whenIdle();
		expect(fixture.events[0]).toEqual({ type: "files", entries: next });
		const notification = fixture.events[1];
		expect(notification?.type).toBe("send");
		if (notification?.type !== "send")
			throw new Error("Missing watcher notification");
		expect(JSON.parse(notification.value)).toEqual({
			jsonrpc: "2.0",
			method: "workspace/didChangeWatchedFiles",
			params: {
				changes: [
					{ uri, type: 2 },
					{ uri: otherUri, type: 1 },
					{ uri: languageServerUri("/local/demo/Ballerina.toml"), type: 3 },
				],
			},
		});
		fixture.events.length = 0;
		fixture.files.change([...next]);
		await fixture.transport.whenIdle();
		expect(fixture.events).toEqual([]);
		fixture.transport.dispose();
	});

	test("waits for an asynchronous filesystem replacement before notifying the server", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.events.length = 0;
		let finish = () => {};
		const replaced = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const update = fixture.client.updateFiles;
		fixture.client.updateFiles = async (entries) => {
			await replaced;
			await update(entries);
		};
		fixture.files.change(
			saved.map((file) =>
				file.path.endsWith("main.bal")
					? { ...file, content: "new saved" }
					: file,
			),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(fixture.events).toEqual([]);
		finish();
		await fixture.transport.whenIdle();
		expect(fixture.events.map((event) => event.type)).toEqual([
			"files",
			"send",
		]);
		fixture.transport.dispose();
	});

	test("coalesces queued saved snapshots to the latest rather than rolling files back during startup", async () => {
		const fixture = setup();
		let ready = () => {};
		fixture.files.ready = () =>
			new Promise<void>((resolve) => {
				ready = resolve;
			});
		fixture.transport.send(message("initialize", {}, 1));
		await Promise.resolve();
		await Promise.resolve();
		fixture.files.change(
			saved.map((file) =>
				file.path.endsWith("main.bal") ? { ...file, content: "first" } : file,
			),
		);
		const latest = saved.map((file) =>
			file.path.endsWith("main.bal") ? { ...file, content: "latest" } : file,
		);
		fixture.files.change(latest);
		fixture.files.ready = async () => {};
		ready();
		await fixture.transport.whenIdle();
		expect(fixture.events.filter((event) => event.type === "files")).toEqual([
			{ type: "files", entries: latest },
		]);
		fixture.transport.dispose();
	});

	test("filters stale versions immediately but preserves per-file and unversioned diagnostics", async () => {
		const fixture = setup();
		await initialize(fixture);
		fixture.transport.send(
			message("textDocument/didOpen", { textDocument: { uri, version: 1 } }),
		);
		fixture.transport.send(
			message("textDocument/didChange", { textDocument: { uri, version: 3 } }),
		);
		const diagnostics = [
			{
				range: {
					start: { line: 0, character: 2 },
					end: { line: 0, character: 4 },
				},
				severity: 1,
				message: "é 😀",
				data: { original: true },
			},
		];
		fixture.receive(
			message("textDocument/publishDiagnostics", {
				uri,
				version: 1,
				diagnostics,
			}),
		);
		const fresh = message("textDocument/publishDiagnostics", {
			uri,
			version: 3,
			diagnostics,
		});
		const other = message("textDocument/publishDiagnostics", {
			uri: otherUri,
			version: 1,
			diagnostics,
		});
		const unversioned = message("textDocument/publishDiagnostics", {
			uri,
			diagnostics,
		});
		for (const notification of [fresh, other, unversioned])
			fixture.receive(notification);
		expect(fixture.received).toEqual([fresh, other, unversioned]);
		await fixture.transport.whenIdle();
		fixture.transport.dispose();
	});

	test("reports a rejected send as JSON-RPC error and continues with subsequent requests", async () => {
		const fixture = setup();
		await initialize(fixture);
		const errorLog = mock(() => {});
		const original = console.error;
		console.error = errorLog;
		try {
			let fail = true;
			fixture.client.send = async (value) => {
				if (fail) {
					fail = false;
					throw new Error("send failed");
				}
				fixture.events.push({ type: "send", value });
			};
			fixture.transport.send(message("textDocument/completion", {}, 2));
			const next = message("textDocument/completion", {}, 3);
			fixture.transport.send(next);
			await fixture.transport.whenIdle();
			expect(JSON.parse(fixture.received[0])).toMatchObject({
				jsonrpc: "2.0",
				id: 2,
				error: { code: -32603 },
			});
			expect(fixture.events.at(-1)).toEqual({ type: "send", value: next });
			expect(errorLog).toHaveBeenCalledTimes(1);
		} finally {
			console.error = original;
			fixture.transport.dispose();
		}
	});

	test("returns initialization failures without inventing server capabilities", async () => {
		const fixture = setup();
		fixture.client.init = async () => {
			throw new Error("WASM failed");
		};
		const original = console.error;
		console.error = mock(() => {});
		try {
			fixture.transport.send(message("initialize", {}, 1));
			await fixture.transport.whenIdle();
			expect(fixture.events).toEqual([]);
			expect(JSON.parse(fixture.received[0])).toEqual({
				jsonrpc: "2.0",
				id: 1,
				error: { code: -32603, message: "Error: WASM failed" },
			});
		} finally {
			console.error = original;
			fixture.transport.dispose();
		}
	});

	test("unsubscribes consumers and disposes the worker without queued work or late publications", async () => {
		const fixture = setup();
		await initialize(fixture);
		const handler = mock(() => {});
		fixture.transport.subscribe(handler);
		fixture.transport.unsubscribe(handler);
		fixture.receive(message("window/logMessage", { message: "test" }));
		expect(handler).not.toHaveBeenCalled();
		fixture.events.length = 0;
		fixture.received.length = 0;
		fixture.transport.send(message("textDocument/completion", {}, 2));
		fixture.transport.dispose();
		fixture.files.change([]);
		fixture.receive(
			message("textDocument/publishDiagnostics", { uri, diagnostics: [] }),
		);
		fixture.transport.send(message("textDocument/completion", {}, 3));
		await fixture.transport.whenIdle();
		expect(fixture.events).toEqual([]);
		expect(fixture.received).toEqual([]);
		expect(fixture.files.listeners.size).toBe(0);
		expect(fixture.client.dispose).toHaveBeenCalledTimes(1);
	});
});
