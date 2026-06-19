import "@/wasm_exec";

import * as Comlink from "comlink";

import type {
	BallerinaWorkerAPI,
	HttpRequestSpec,
	HttpResponse,
	RunOutputCallback,
	RunResult,
} from "@/workers/ballerina-worker-api";
import type { SnapshotFS } from "@/lib/fs/snapshot";

export interface GoRuntime {
	importObject: WebAssembly.Imports;
	run(instance: WebAssembly.Instance): Promise<void>;
}

declare const self: typeof globalThis & {
	Go: new () => GoRuntime;
	run: (
		fs: SnapshotFS,
		path: string,
		onOutput: RunOutputCallback,
	) => Promise<RunResult>;
	getDiagnostics: (
		fs: SnapshotFS,
		path: string,
	) => Promise<Array<Record<string, unknown>>>;
	dispatchHttp: (req: HttpRequestSpec) => Promise<HttpResponse>;
	stopService: () => Promise<void>;
};

async function fetchWithProgress(
	url: string,
	onProgress: (pct: number) => void,
): Promise<Response> {
	const res = await fetch(url);
	if (!res.body) return res;

	const total = Number(res.headers.get("content-length") ?? 0);
	const reader = res.body.getReader();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let loaded = 0;
			if (total <= 0) onProgress(0);

			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					if (total <= 0) onProgress(100);
					controller.close();
					break;
				}

				if (value) {
					loaded += value.byteLength;
					if (total > 0) onProgress(Math.round((loaded / total) * 100));
					controller.enqueue(value);
				}
			}
		},
	});

	return new Response(stream, { headers: res.headers });
}

let initPromise: Promise<void> | null = null;

const api: BallerinaWorkerAPI = {
	init: (
		wasmUrl: string,
		onProgress: (progress: number) => void,
	): Promise<void> => {
		if (initPromise) return initPromise;

		initPromise = (async () => {
			const go = new self.Go();
			const { instance } = await WebAssembly.instantiateStreaming(
				fetchWithProgress(wasmUrl, onProgress),
				go.importObject,
			);
			void go.run(instance);
			const deadline = Date.now() + 10_000;
			while (typeof self.run !== "function") {
				if (Date.now() > deadline) {
					throw new Error("Ballerina runtime init timed out");
				}
				await new Promise((r) => setTimeout(r, 10));
			}
		})().catch((error) => {
			initPromise = null;
			throw error;
		});

		return initPromise;
	},
	run: async (
		snapshot: SnapshotFS,
		path: string,
		onOutput: RunOutputCallback,
	): Promise<RunResult> => {
		if (typeof self.run !== "function") {
			onOutput({
				stream: "stderr",
				text: "Ballerina runtime is not initialized",
			});
			return { service: false };
		}
		return self.run(snapshot, path, onOutput);
	},
	getDiagnostics: (
		snapshot: SnapshotFS,
		path: string,
	): Promise<Array<Record<string, unknown>>> => {
		if (typeof self.getDiagnostics !== "function") return Promise.resolve([]);
		return Promise.resolve(self.getDiagnostics(snapshot, path) ?? []);
	},
	dispatchHttp: (req: HttpRequestSpec): Promise<HttpResponse> => {
		if (typeof self.dispatchHttp !== "function") {
			return Promise.reject(new Error("Ballerina runtime is not initialized"));
		}
		return self.dispatchHttp(req);
	},
	stopService: (): Promise<void> => {
		if (typeof self.stopService !== "function") return Promise.resolve();
		return self.stopService();
	},
};

Comlink.expose(api);
