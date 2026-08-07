import * as Comlink from "comlink";

import type {
	BallerinaWorkerAPI,
	HttpDispatchRequest,
	HttpDispatchResponse,
	RunEventCallback,
} from "@/workers/ballerina-worker-api";
import type { SnapshotFS } from "@/lib/fs/snapshot";

export class BallerinaWorkerClient {
	private worker: Worker | null = null;
	private api: Comlink.Remote<BallerinaWorkerAPI> | null = null;

	private initPromise: Promise<void> | null = null;
	private onProgress: ((progress: number) => void) | null = null;

	async init(onProgress: (progress: number) => void): Promise<void> {
		this.onProgress = onProgress;
		if (this.initPromise) return this.initPromise;

		this.worker = new Worker(
			new URL("./ballerina-worker.ts", import.meta.url),
			{ type: "module" },
		);
		this.api = Comlink.wrap<BallerinaWorkerAPI>(this.worker);

		const wasmUrl = new URL(
			"ballerina.wasm",
			new URL(import.meta.env.BASE_URL, self.location.origin),
		).toString();

		this.initPromise = this.api
			.init(
				wasmUrl,
				Comlink.proxy((progress) => this.onProgress?.(progress)),
			)
			.catch((err) => {
				this.dispose();
				throw err;
			});

		return this.initPromise;
	}

	async run(
		snapshot: SnapshotFS,
		path: string,
		onEvent: RunEventCallback,
	): Promise<void> {
		if (!this.api) throw new Error("Ballerina runtime is not ready");
		return this.api.run(Comlink.proxy(snapshot), path, Comlink.proxy(onEvent));
	}

	async sendStopSignal(): Promise<void> {
		if (!this.api) throw new Error("Ballerina runtime is not ready");
		await this.api.sendStopSignal();
	}

	async dispatchHttpRequest(
		request: HttpDispatchRequest,
	): Promise<HttpDispatchResponse> {
		if (!this.api) throw new Error("Ballerina runtime is not ready");
		return this.api.dispatchHttpRequest(request);
	}

	async getDiagnostics(
		snapshot: SnapshotFS,
		path: string,
	): Promise<Array<Record<string, unknown>>> {
		if (!this.api) throw new Error("Ballerina runtime is not ready");
		return this.api.getDiagnostics(Comlink.proxy(snapshot), path);
	}

	dispose() {
		this.worker?.terminate();
		this.worker = null;
		this.api = null;
		this.initPromise = null;
		this.onProgress = null;
	}
}

let _client: BallerinaWorkerClient | null = null;

export function getBallerinaWorkerClient(): BallerinaWorkerClient {
	_client ??= new BallerinaWorkerClient();
	return _client;
}
