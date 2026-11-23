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
		this.worker = new Worker(
			new URL("./language-server-worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.api = Comlink.wrap<LanguageServerWorkerAPI>(this.worker);
		const base = new URL(import.meta.env.BASE_URL, self.location.origin);
		this.initPromise = this.api
			.init(
				new URL("ballerina-ls.wasm", base).href,
				new URL("ls-wasm_exec.js", base).href,
				Comlink.proxy(onMessage),
			)
			.catch((error) => {
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
