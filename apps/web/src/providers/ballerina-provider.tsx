import * as React from "react";

import { subscribeFileMutations } from "@/lib/fs/mutations";
import { SnapshotFS } from "@/lib/fs/snapshot";

import { useFS } from "@/providers/fs-provider";
import { useFileTreeStore } from "@/stores/file-tree-store";

import { getBallerinaWorkerClient } from "@/workers/ballerina-worker-client";

import type { BallerinaWorkerClient } from "@/workers/ballerina-worker-client";
import type {
	HttpDispatchRequest,
	HttpDispatchResponse,
	RunEventCallback,
} from "@/workers/ballerina-worker-api";
import type { SnapshotFSMutation } from "@/lib/fs/snapshot";

interface BallerinaContextValue {
	isReady: boolean;
	progress: number;
	error: Error | null;
	run(path: string, onEvent: RunEventCallback): Promise<void>;
	sendStopSignal(): Promise<void>;
	dispatchHttpRequest(
		request: HttpDispatchRequest,
	): Promise<HttpDispatchResponse>;
}

const BallerinaContext = React.createContext<BallerinaContextValue | null>(
	null,
);

function requireClient(
	client: BallerinaWorkerClient | null,
): BallerinaWorkerClient {
	if (!client) throw new Error("Ballerina runtime is not initialized");
	return client;
}

async function applyExternalMutation(
	snapshot: SnapshotFS,
	mutation: SnapshotFSMutation,
): Promise<void> {
	switch (mutation.type) {
		case "writeFile":
			await snapshot.writeFile(mutation.path, mutation.content);
			break;
		case "mkdirAll":
			await snapshot.mkdirAll(mutation.path);
			break;
		case "remove":
			await snapshot.remove(mutation.path);
			break;
		case "move":
			await snapshot.move(mutation.oldPath, mutation.newPath);
			break;
	}
}

export function BallerinaProvider({ children }: React.PropsWithChildren) {
	const fs = useFS();
	const clientRef = React.useRef<BallerinaWorkerClient | null>(null);

	const [isReady, setIsReady] = React.useState(false);
	const [progress, setProgress] = React.useState(0);
	const [error, setError] = React.useState<Error | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		const client = getBallerinaWorkerClient();
		clientRef.current = client;

		client
			.init((p) => {
				if (!cancelled) setProgress(p);
			})
			.then(() => {
				if (cancelled) return;
				setError(null);
				setIsReady(true);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setIsReady(false);
				setError(
					cause instanceof Error
						? cause
						: new Error("Failed to initialize Ballerina runtime"),
				);
			});

		return () => {
			cancelled = true;
			if (clientRef.current === client) clientRef.current = null;
		};
	}, []);

	const run = React.useCallback(
		async (path: string, onEvent: RunEventCallback): Promise<void> => {
			const snapshot = await SnapshotFS.from(fs, path);
			let mutationSync = Promise.resolve();
			let applyingWorkspaceMutation = false;
			const enqueueMutation = (apply: () => Promise<void>) => {
				mutationSync = mutationSync.catch(() => undefined).then(apply);
			};
			const unsubscribeRuntime = snapshot.onMutation((mutation) => {
				if (applyingWorkspaceMutation) return;
				enqueueMutation(async () => {
					try {
						await useFileTreeStore.getState().applyMutation(mutation);
					} catch (error) {
						onEvent({
							type: "output",
							stream: "stderr",
							text: `Failed to sync file system mutation: ${String(error)}\n`,
						});
					}
				});
			});
			const unsubscribeWorkspace = subscribeFileMutations((mutation) => {
				enqueueMutation(async () => {
					applyingWorkspaceMutation = true;
					try {
						await applyExternalMutation(snapshot, mutation);
					} finally {
						applyingWorkspaceMutation = false;
					}
				});
			});

			try {
				await requireClient(clientRef.current).run(snapshot, path, onEvent);
			} finally {
				unsubscribeWorkspace();
				unsubscribeRuntime();
				await mutationSync;
			}
		},
		[fs],
	);

	const sendStopSignal = React.useCallback(async (): Promise<void> => {
		await requireClient(clientRef.current).sendStopSignal();
	}, []);

	const dispatchHttpRequest = React.useCallback(
		async (request: HttpDispatchRequest): Promise<HttpDispatchResponse> => {
			return requireClient(clientRef.current).dispatchHttpRequest(request);
		},
		[],
	);

	const value = React.useMemo<BallerinaContextValue>(
		() => ({
			isReady,
			progress,
			error,
			run,
			sendStopSignal,
			dispatchHttpRequest,
		}),
		[isReady, progress, error, run, sendStopSignal, dispatchHttpRequest],
	);

	return (
		<BallerinaContext.Provider value={value}>
			{children}
		</BallerinaContext.Provider>
	);
}

export function useBallerina(): BallerinaContextValue {
	const context = React.useContext(BallerinaContext);
	if (!context)
		throw new Error("useBallerina must be used within a BallerinaProvider");
	return context;
}
