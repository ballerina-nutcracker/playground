import "@/wasm_exec";

import * as React from "react";

import { SnapshotFS } from "@/lib/fs/snapshot";

import { useFS } from "@/providers/fs-provider";

import { getBallerinaWorkerClient } from "@/workers/ballerina-worker-client";

import type { BallerinaWorkerClient } from "@/workers/ballerina-worker-client";
import type {
	HttpRequestSpec,
	HttpResponse,
	RunOutputCallback,
	RunResult,
} from "@/workers/ballerina-worker-api";

export function useBallerina() {
	const fs = useFS();

	const clientRef = React.useRef<BallerinaWorkerClient | null>(null);

	const [isReady, setIsReady] = React.useState(false);
	const [progress, setProgress] = React.useState(0);

	React.useEffect(() => {
		const client = getBallerinaWorkerClient();
		clientRef.current = client;

		client
			.init((p) => setProgress(p))
			.then(() => setIsReady(true))
			.catch(() => setIsReady(false));
	}, []);

	const run = React.useCallback(
		async (path: string, onOutput: RunOutputCallback): Promise<RunResult> => {
			if (!clientRef.current) {
				onOutput({
					stream: "stderr",
					text: "Ballerina runtime is not initialized",
				});
				return { service: false };
			}
			if (!fs) {
				onOutput({
					stream: "stderr",
					text: "Virtual file system is not available",
				});
				return { service: false };
			}

			const snapshot = await SnapshotFS.from(fs, path);
			return clientRef.current.run(snapshot, path, onOutput);
		},
		[fs],
	);

	const dispatchHttp = React.useCallback(
		(req: HttpRequestSpec): Promise<HttpResponse> => {
			if (!clientRef.current) {
				return Promise.reject(new Error("Ballerina runtime is not ready"));
			}
			return clientRef.current.dispatchHttp(req);
		},
		[],
	);

	const stopService = React.useCallback((): Promise<void> => {
		if (!clientRef.current) return Promise.resolve();
		return clientRef.current.stopService();
	}, []);

	return { isReady, progress, run, dispatchHttp, stopService };
}
