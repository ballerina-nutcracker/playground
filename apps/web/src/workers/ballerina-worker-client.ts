import * as Comlink from "comlink";

import type {
	BallerinaWorkerAPI,
	HttpDispatchRequest,
	HttpDispatchResponse,
	RunEventCallback,
} from "@/workers/ballerina-worker-api";
import type { SnapshotFS } from "@/lib/fs/snapshot";

interface Deferred {
	promise: Promise<void>;
	settled: boolean;
	resolve(): void;
	reject(reason: unknown): void;
}

function createDeferred(): Deferred {
	const deferred = { settled: false } as Deferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = () => {
			deferred.settled = true;
			resolve();
		};
		deferred.reject = (reason) => {
			deferred.settled = true;
			reject(reason);
		};
	});
	// Callers handle rejection via whenReady(); avoid unhandled-rejection noise.
	deferred.promise.catch(() => undefined);
	return deferred;
}

export class BallerinaWorkerClient {
	private worker: Worker | null = null;
	private api: Comlink.Remote<BallerinaWorkerAPI> | null = null;

	private initPromise: Promise<void> | null = null;
	private onProgress: ((progress: number) => void) | null = null;

	private ready = createDeferred();

	/** Resolves once the wasm is initialized; rejects if initialization fails. */
	whenReady(): Promise<void> {
		return this.ready.promise;
	}

	async init(onProgress: (progress: number) => void): Promise<void> {
		this.onProgress = onProgress;
		if (this.initPromise) return this.initPromise;
		if (this.ready.settled) this.ready = createDeferred();

		try {
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
				.then(() => this.ready.resolve())
				.catch((err) => {
					this.ready.reject(err);
					this.dispose();
					throw err;
				});
		} catch (err) {
			this.ready.reject(err);
			this.dispose();
			throw err;
		}

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
