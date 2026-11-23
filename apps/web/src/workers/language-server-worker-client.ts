import * as Comlink from "comlink";

import type {
	LanguageServerWorkerAPI,
	LanguageServerFile,
} from "./language-server-worker-api";

export interface LanguageServerConnection {
	init(onMessage: (message: string) => void): Promise<void>;
	send(message: string): Promise<void>;
	updateFiles(entries: LanguageServerFile[]): Promise<void>;
	dispose(): void;
}

export class LanguageServerWorkerClient implements LanguageServerConnection {
	private worker: Worker | null = null;
	private api: Comlink.Remote<LanguageServerWorkerAPI> | null = null;
	private initPromise: Promise<void> | null = null;

	init(onMessage: (message: string) => void): Promise<void> {
		if (this.initPromise) return this.initPromise;
		const worker = new Worker(
			new URL("./language-server-worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.worker = worker;
		this.api = Comlink.wrap<LanguageServerWorkerAPI>(worker);
		// A script that fails to load never calls Comlink.expose(), so the init
		// call would wait forever; the worker reports that only as an error event.
		const loadFailed = new Promise<never>((_, reject) =>
			worker.addEventListener(
				"error",
				() => reject(new Error("Language server worker failed to load")),
				{ once: true },
			),
		);
		const base = new URL(import.meta.env.BASE_URL, self.location.origin);
		this.initPromise = Promise.race([
			this.api.init(
				new URL("ballerina-ls.wasm", base).href,
				new URL("ls-wasm_exec.js", base).href,
				Comlink.proxy(onMessage),
			),
			loadFailed,
		]).catch((error) => {
			this.dispose();
			throw error;
		});
		return this.initPromise;
	}

	async send(message: string): Promise<void> {
		if (!this.api) throw new Error("Language server is not ready");
		await this.api.send(message);
	}

	async updateFiles(entries: LanguageServerFile[]): Promise<void> {
		if (!this.api) throw new Error("Language server is not ready");
		await this.api.updateFiles(entries);
	}

	dispose(): void {
		this.worker?.terminate();
		this.worker = null;
		this.api = null;
		this.initPromise = null;
	}
}
