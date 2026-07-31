import type { SnapshotFS } from "@/lib/fs/snapshot";

export type RunOutputStream = "stdout" | "stderr";

export interface RunOutputEvent {
	type: "output";
	stream: RunOutputStream;
	text: string;
}

export interface RunListenersEvent {
	type: "listeners";
	hosts: string[];
}

export type RunEvent = RunOutputEvent | RunListenersEvent;

export type RunEventCallback = (event: RunEvent) => void;

export interface HttpDispatchRequest {
	method?: string;
	host: string;
	path?: string;
	query?: string;
	headers?: Record<string, string | string[]>;
	body?: string;
}

export interface HttpDispatchResponse {
	statusCode: number;
	headers: Record<string, string[]>;
	body: string;
}

export interface BallerinaWorkerAPI {
	init(wasmUrl: string, onProgress: (progress: number) => void): Promise<void>;
	run(
		snapshot: SnapshotFS,
		path: string,
		onEvent: RunEventCallback,
	): Promise<void>;
	sendStopSignal(): Promise<void>;
	dispatchHttpRequest(
		request: HttpDispatchRequest,
	): Promise<HttpDispatchResponse>;
	getDiagnostics(
		snapshot: SnapshotFS,
		path: string,
	): Promise<Array<Record<string, unknown>>>;
}
