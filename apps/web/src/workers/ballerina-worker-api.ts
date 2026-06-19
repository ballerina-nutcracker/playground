import type { SnapshotFS } from "@/lib/fs/snapshot";

export type RunOutputStream = "stdout" | "stderr";

export interface RunOutput {
	stream: RunOutputStream;
	text: string;
}

export type RunOutputCallback = (output: RunOutput) => void;

// RunResult describes how a program ended. A service program keeps running after
// run() resolves (service=true) and exposes the addresses its listeners are bound
// to; a plain main program has already finished (service=false).
export interface RunResult {
	service: boolean;
	addrs?: string[];
}

// HttpRequestSpec is a request injected into a running service. host/port select
// which listener receives it; the remaining fields shape the request.
export interface HttpRequestSpec {
	method: string;
	host: string;
	port: number;
	path: string;
	query?: string;
	headers?: Record<string, string | string[]>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string[]>;
	body: string;
}

export interface BallerinaWorkerAPI {
	init(wasmUrl: string, onProgress: (progress: number) => void): Promise<void>;
	run(
		snapshot: SnapshotFS,
		path: string,
		onOutput: RunOutputCallback,
	): Promise<RunResult>;
	getDiagnostics(
		snapshot: SnapshotFS,
		path: string,
	): Promise<Array<Record<string, unknown>>>;
	dispatchHttp(req: HttpRequestSpec): Promise<HttpResponse>;
	stopService(): Promise<void>;
}
