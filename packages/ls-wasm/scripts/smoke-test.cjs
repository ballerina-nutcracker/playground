const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

globalThis.crypto ??= webcrypto;
require("../dist/wasm_exec.js");

const timeout = setTimeout(() => {
	console.error("Language server WASM smoke test timed out");
	process.exit(1);
}, 60000);

async function main() {
	const ready = new Promise((resolve) => {
		globalThis.onLanguageServerReady = resolve;
	});
	const go = new Go();
	const bytes = fs.readFileSync(
		path.join(__dirname, "../dist/ballerina-ls.wasm"),
	);
	const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
	void go.run(instance);
	await ready;
	assert.equal(globalThis.languageServerReady, true);
	for (const name of [
		"startLanguageServer",
		"sendLanguageServerMessage",
		"updateLanguageServerFiles",
	]) {
		assert.equal(typeof globalThis[name], "function");
	}
	await assert.rejects(sendLanguageServerMessage("{}"), /must be called/);

	const messages = [];
	const waiters = [];
	function next(predicate) {
		const existing = messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => waiters.push({ predicate, resolve }));
	}
	await startLanguageServer((json) => {
		assert.ok(!json.startsWith("Content-Length"));
		const message = JSON.parse(json);
		messages.push(message);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(message)) {
				waiters[i].resolve(message);
				waiters.splice(i, 1);
			}
		}
	});
	await assert.rejects(
		startLanguageServer(() => {}),
		/already started/,
	);
	await assert.rejects(sendLanguageServerMessage("not json"), /JSON object/);
	await assert.rejects(
		updateLanguageServerFiles([{ path: "../escape", isDir: false }]),
		/parent traversal/,
	);

	const send = (message) =>
		sendLanguageServerMessage(JSON.stringify({ jsonrpc: "2.0", ...message }));
	await updateLanguageServerFiles([
		{
			path: "Ballerina.toml",
			isDir: false,
			content:
				'[package]\norg = "browser"\nname = "smoke"\nversion = "0.1.0"\n',
		},
		{ path: "main.bal", isDir: false, content: "function main() {}\n" },
		{ path: "other.bal", isDir: false, content: "function other() {}\n" },
		{ path: "modules", isDir: true },
	]);
	await send({
		id: 1,
		method: "initialize",
		params: {
			rootUri: "file:///workspace",
			capabilities: {
				textDocument: {
					publishDiagnostics: { versionSupport: true },
					signatureHelp: {
						signatureInformation: {
							parameterInformation: { labelOffsetSupport: true },
						},
					},
				},
			},
		},
	});
	const initialized = await next((m) => m.id === 1);
	assert.ok(initialized.result.capabilities.completionProvider);
	assert.ok(initialized.result.capabilities.signatureHelpProvider);
	assert.equal(initialized.result.capabilities.textDocumentSync.change, 2);
	await send({ method: "initialized", params: {} });
	const mainURI = "file:///workspace/main.bal";
	const otherURI = "file:///workspace/other.bal";
	const badMain =
		'function main() {\n string emoji = "🐘"; int count = "wrong";\n}\n';
	for (const [uri, text] of [
		[mainURI, badMain],
		[otherURI, 'function other() { int count = "wrong"; }\n'],
	]) {
		await send({
			method: "textDocument/didOpen",
			params: {
				textDocument: { uri, languageId: "ballerina", version: 1, text },
			},
		});
	}
	// Upstream's deterministic test-only drain, not part of the browser API.
	await send({ method: "$pal/flush" });
	for (const uri of [mainURI, otherURI]) {
		const diagnostics = await next(
			(m) =>
				m.method === "textDocument/publishDiagnostics" &&
				m.params.uri === uri &&
				m.params.diagnostics.length > 0,
		);
		assert.equal(diagnostics.params.version, 1);
		if (uri === mainURI) {
			const error = diagnostics.params.diagnostics.find((d) =>
				d.message.includes("'count'"),
			);
			assert.ok(error, JSON.stringify(diagnostics));
			assert.equal(error.range.start.line, 1);
			assert.equal(
				error.range.start.character,
				badMain.split("\n")[1].indexOf("int count"),
			);
		}
	}

	// The filesystem still contains the original empty function: completions
	// must use this unsaved text supplied through the real LSP lifecycle.
	const unsaved =
		"function main() {\n int browserUnique = 1;\n browserUnique = browserUnique + 1;\n}\n";
	await send({
		method: "textDocument/didChange",
		params: {
			textDocument: { uri: mainURI, version: 2 },
			contentChanges: [{ text: unsaved }],
		},
	});
	await send({ method: "$pal/flush" });
	await send({
		id: 2,
		method: "textDocument/completion",
		params: {
			textDocument: { uri: mainURI },
			position: { line: 2, character: 4 },
		},
	});
	const cleared = await next(
		(m) =>
			m.method === "textDocument/publishDiagnostics" &&
			m.params.uri === mainURI &&
			m.params.version === 2,
	);
	assert.equal(cleared.params.diagnostics.length, 0, JSON.stringify(cleared));
	const completion = await next((m) => m.id === 2);
	assert.ok(!completion.error, JSON.stringify(completion));
	const items = Array.isArray(completion.result)
		? completion.result
		: completion.result.items;
	assert.ok(
		items.some((item) => item.label === "browserUnique"),
		JSON.stringify(items),
	);

	// A UTF-16 ranged edit after an astral character must rename the exact
	// identifier, not byte-index into the string literal.
	const unicodeLine = ' string emoji = "🐘"; int browserUnique = 1;';
	await send({
		method: "textDocument/didChange",
		params: {
			textDocument: { uri: mainURI, version: 3 },
			contentChanges: [
				{
					text: `function main() {\n${unicodeLine}\n browserUnique = browserUnique + 1;\n}\n`,
				},
			],
		},
	});
	const start = unicodeLine.indexOf("browserUnique");
	await send({
		method: "textDocument/didChange",
		params: {
			textDocument: { uri: mainURI, version: 4 },
			contentChanges: [
				{
					range: {
						start: { line: 1, character: start },
						end: { line: 1, character: start + 13 },
					},
					text: "browserRenamed",
				},
				{
					range: {
						start: { line: 2, character: 1 },
						end: { line: 2, character: 14 },
					},
					text: "browserRenamed",
				},
				{
					range: {
						start: { line: 2, character: 18 },
						end: { line: 2, character: 31 },
					},
					text: "browserRenamed",
				},
			],
		},
	});
	await send({
		id: 4,
		method: "textDocument/completion",
		params: {
			textDocument: { uri: mainURI },
			position: { line: 2, character: 4 },
		},
	});
	const renamed = await next((m) => m.id === 4);
	const renamedItems = Array.isArray(renamed.result)
		? renamed.result
		: renamed.result.items;
	assert.ok(
		renamedItems.some((item) => item.label === "browserRenamed"),
		JSON.stringify(renamed),
	);
	assert.ok(
		!renamedItems.some((item) => item.label === "browserUnique"),
		JSON.stringify(renamed),
	);

	// Rapid revisions carry unique diagnostic labels, making old diagnostics
	// paired with a newer version observable at the shipped JS boundary.
	for (let version = 5; version <= 20; version++) {
		await send({
			method: "textDocument/didChange",
			params: {
				textDocument: { uri: mainURI, version },
				contentChanges: [
					{
						text:
							version % 2 === 0
								? "function main() {}\n"
								: `function main() { int unusedVersion${version} = 1; }\n`,
					},
				],
			},
		});
	}
	await next(
		(m) =>
			m.method === "textDocument/publishDiagnostics" &&
			m.params.uri === mainURI &&
			m.params.version === 20,
	);
	for (const message of messages) {
		if (
			message.method !== "textDocument/publishDiagnostics" ||
			message.params.uri !== mainURI ||
			message.params.version < 5
		)
			continue;
		const { version, diagnostics } = message.params;
		if (version % 2 === 0)
			assert.equal(diagnostics.length, 0, JSON.stringify(message));
		else
			assert.ok(
				diagnostics.every((d) => d.message.includes(`unusedVersion${version}`)),
				JSON.stringify(message),
			);
	}
	await send({
		method: "textDocument/didClose",
		params: { textDocument: { uri: mainURI } },
	});
	const clear = await next(
		(m) =>
			m.method === "textDocument/publishDiagnostics" &&
			m.params.uri === mainURI &&
			m.params.version === undefined &&
			m.params.diagnostics.length === 0,
	);
	const clearIndex = messages.indexOf(clear);
	await send({
		method: "textDocument/didChange",
		params: {
			textDocument: { uri: otherURI, version: 2 },
			contentChanges: [{ text: "function other() {}\n" }],
		},
	});
	await next(
		(m) =>
			m.method === "textDocument/publishDiagnostics" &&
			m.params.uri === otherURI &&
			m.params.version === 2,
	);
	// Signature help uses unsaved text (the saved file is still the empty
	// function) and UTF-16 offsets into the label.
	const callText =
		'function add(int a, string b) {}\nfunction other() {\n string s = "🐘"; add(1, "x");\n}\n';
	await send({
		method: "textDocument/didChange",
		params: {
			textDocument: { uri: otherURI, version: 3 },
			contentChanges: [{ text: callText }],
		},
	});
	await send({
		id: 100,
		method: "textDocument/signatureHelp",
		params: {
			textDocument: { uri: otherURI },
			position: {
				line: 2,
				character: callText.split("\n")[2].indexOf('"x"'),
			},
		},
	});
	const signature = await next((m) => m.id === 100);
	assert.ok(!signature.error, JSON.stringify(signature));
	assert.ok(signature.result, JSON.stringify(signature));
	const help = signature.result.signatures[0];
	assert.equal(help.label, "add(int a, string b)");
	assert.equal(signature.result.activeParameter, 1, JSON.stringify(signature));
	assert.deepEqual(
		help.parameters.map((p) => p.label),
		[
			[4, 9],
			[11, 19],
		],
	);

	await send({ method: "$pal/flush" });
	await send({ id: 3, method: "shutdown", params: null });
	await next((m) => m.id === 3);
	assert.ok(
		!messages
			.slice(clearIndex + 1)
			.some(
				(m) =>
					m.method === "textDocument/publishDiagnostics" &&
					m.params.uri === mainURI,
			),
		"closed document republished after clear",
	);
	await send({ method: "exit" });
	clearTimeout(timeout);
	console.log(
		"WASM LS smoke passed: registration, initialize, multi-file/versioned diagnostics, Unicode edits, unsaved completion, signature help, rapid revisions, close clear, shutdown",
	);
	process.exit(0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
