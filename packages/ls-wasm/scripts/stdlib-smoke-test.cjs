const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
globalThis.crypto ??= webcrypto;
require("../dist/wasm_exec.js");
const timeout = setTimeout(() => {
	console.error("WASM stdlib smoke timed out");
	process.exit(1);
}, 90000);

async function main() {
	const ready = new Promise((resolve) => {
		globalThis.onLanguageServerReady = resolve;
	});
	const go = new Go();
	const { instance } = await WebAssembly.instantiate(
		fs.readFileSync(path.join(__dirname, "../dist/ballerina-ls.wasm")),
		go.importObject,
	);
	void go.run(instance);
	await ready;
	const messages = [];
	const waiters = [];
	await startLanguageServer((json) => {
		const message = JSON.parse(json);
		messages.push(message);
		for (let i = waiters.length - 1; i >= 0; i--) {
			if (waiters[i].predicate(message)) {
				waiters[i].resolve(message);
				waiters.splice(i, 1);
			}
		}
	});
	const next = (predicate) =>
		messages.find(predicate)
			? Promise.resolve(messages.find(predicate))
			: new Promise((resolve) => waiters.push({ predicate, resolve }));
	const send = (message) =>
		sendLanguageServerMessage(JSON.stringify({ jsonrpc: "2.0", ...message }));
	await send({
		id: 1,
		method: "initialize",
		params: {
			capabilities: {
				textDocument: { publishDiagnostics: { versionSupport: true } },
			},
		},
	});
	await next((m) => m.id === 1);
	await send({ method: "initialized", params: {} });
	const hello =
		'import ballerina/io;\n\npublic function main() {\n    io:println("Hello, World!");\n}\n';
	const http =
		'import ballerina/http;\n\nservice / on new http:Listener(9090) {\n    resource function get hello() returns string {\n        return "Hello";\n    }\n}\n';
	await updateLanguageServerFiles([
		{ path: "standalone/main.bal", isDir: false, content: hello },
		{ path: "package/main.bal", isDir: false, content: hello },
		{
			path: "package/Ballerina.toml",
			isDir: false,
			content:
				'[package]\norg = "browser"\nname = "stdio"\nversion = "0.1.0"\n',
		},
		{ path: "listener/main.bal", isDir: false, content: http },
	]);
	for (const [name, source] of [
		["standalone", hello],
		["package", hello],
		["listener", http],
	]) {
		const uri = `file:///workspace/${name}/main.bal`;
		await send({
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri,
					languageId: "ballerina",
					version: 1,
					text: source,
				},
			},
		});
		const initial = await next(
			(m) =>
				m.method === "textDocument/publishDiagnostics" &&
				m.params.uri === uri &&
				m.params.version === 1,
		);
		assert.equal(initial.params.diagnostics.length, 0, JSON.stringify(initial));
		if (name === "listener") continue;
		const broken = hello.replace('"Hello, World!"', "missingStdlibArgument");
		await send({
			method: "textDocument/didChange",
			params: {
				textDocument: { uri, version: 2 },
				contentChanges: [{ text: broken }],
			},
		});
		const errors = await next(
			(m) =>
				m.method === "textDocument/publishDiagnostics" &&
				m.params.uri === uri &&
				m.params.version === 2,
		);
		assert.ok(
			errors.params.diagnostics.some((d) =>
				d.message.includes("missingStdlibArgument"),
			),
			JSON.stringify(errors),
		);
		assert.ok(
			!errors.params.diagnostics.some((d) => /unknown import/i.test(d.message)),
			JSON.stringify(errors),
		);
		await send({
			method: "textDocument/didChange",
			params: {
				textDocument: { uri, version: 3 },
				contentChanges: [{ text: hello }],
			},
		});
		const corrected = await next(
			(m) =>
				m.method === "textDocument/publishDiagnostics" &&
				m.params.uri === uri &&
				m.params.version === 3,
		);
		assert.equal(
			corrected.params.diagnostics.length,
			0,
			JSON.stringify(corrected),
		);
	}
	await send({ id: 99, method: "shutdown", params: null });
	await next((m) => m.id === 99);
	await send({ method: "exit" });
	clearTimeout(timeout);
	console.log(
		"WASM stdlib smoke passed: standalone/package io, real undefined argument, correction, http listener",
	);
	process.exit(0);
}
main().catch((error) => {
	console.error(error);
	process.exit(1);
});
