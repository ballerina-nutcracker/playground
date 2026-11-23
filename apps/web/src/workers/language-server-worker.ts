import * as Comlink from "comlink";

import type {
	LanguageServerWorkerAPI,
	LanguageServerFile,
} from "./language-server-worker-api";

interface GoRuntime {
	importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
}

declare const self: typeof globalThis & {
	Go: new () => GoRuntime;
	languageServerReady?: boolean;
	startLanguageServer: (onMessage: (message: string) => void) => Promise<void>;
	sendLanguageServerMessage: (message: string) => Promise<void>;
	updateLanguageServerFiles: (entries: LanguageServerFile[]) => Promise<void>;
};

let initPromise: Promise<void> | null = null;
let runtimeError: Error | null = null;

const api: LanguageServerWorkerAPI = {
	init(wasmUrl, runtimeUrl, onMessage) {
		initPromise ??= (async () => {
			// Import the shim built with THIS artifact's Go toolchain, not the runner's.
			await import(/* @vite-ignore */ runtimeUrl);
			const go = new self.Go();
			const response = await fetch(wasmUrl);
			if (!response.ok)
				throw new Error(`Language server WASM: ${response.status}`);
			const { instance } = await WebAssembly.instantiate(
				await response.arrayBuffer(),
				go.importObject,
			);
			void go.run(instance).then(
				() => {
					runtimeError = new Error("Language server runtime exited");
				},
				(error: unknown) => {
					runtimeError =
						error instanceof Error ? error : new Error(String(error));
				},
			);
			const deadline = Date.now() + 10_000;
			while (!self.languageServerReady) {
				if (runtimeError) throw runtimeError;
				if (Date.now() > deadline)
					throw new Error("Language server runtime init timed out");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await self.startLanguageServer((message) => {
				void onMessage(message);
			});
		})();
		return initPromise;
	},
	async send(message) {
		if (!initPromise) throw new Error("Language server is not initialized");
		await initPromise;
		if (runtimeError) throw runtimeError;
		// Go owns UTF-8 Content-Length framing; this boundary carries raw JSON.
		await self.sendLanguageServerMessage(message);
	},
	async updateFiles(entries) {
		if (!initPromise) throw new Error("Language server is not initialized");
		await initPromise;
		if (runtimeError) throw runtimeError;
		await self.updateLanguageServerFiles(entries);
	},
};

Comlink.expose(api);
