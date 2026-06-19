import type { FS } from "@/lib/fs/core/fs.interface";
import type {
	HttpRequestSpec,
	HttpResponse,
	RunOutputCallback,
	RunResult,
} from "@/workers/ballerina-worker-api";

declare global {
	export interface Window {
		Go: any;
		run(
			proxy: FS,
			path: string,
			onOutput: RunOutputCallback,
		): Promise<RunResult>;
		getDiagnostics: (
			proxy: FS,
			path: string,
		) => Promise<Array<Record<string, any>> | null>;
		dispatchHttp: (req: HttpRequestSpec) => Promise<HttpResponse>;
		stopService: () => Promise<void>;
	}
}
