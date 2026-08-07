import type { FS } from "@/lib/fs/core/fs.interface";
import type {
	HttpDispatchRequest,
	HttpDispatchResponse,
	RunEventCallback,
} from "@/workers/ballerina-worker-api";

declare global {
	export interface Window {
		Go: any;
		run(proxy: FS, path: string, onEvent: RunEventCallback): Promise<void>;
		getDiagnostics: (
			proxy: FS,
			path: string,
		) => Promise<Array<Record<string, any>> | null>;
		dispatchHttpRequest: (
			request: HttpDispatchRequest,
		) => Promise<HttpDispatchResponse>;
	}
}
