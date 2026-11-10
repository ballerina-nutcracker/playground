import { SnapshotFS } from "@/lib/fs/snapshot";
import { getBallerinaProjectTarget } from "@/lib/fs/project-target";

import { useFileTreeStore } from "@/stores/file-tree-store";

import { getBallerinaWorkerClient } from "@/workers/ballerina-worker-client";

import type { Transport } from "@codemirror/lsp-client";

export class BallerinaLS implements Transport {
	private handlers: ((value: string) => void)[] = [];
	// Latest request generation per document, so stale requests that were
	// waiting for the wasm to load are dropped.
	private latest = new Map<string, number>();

	send(message: string): void {
		void (async () => {
			const request = JSON.parse(message);
			const result = await this._handleRequest(request.method, request.params);
			if (request.id === undefined || result === null) return;

			const response = {
				jsonrpc: "2.0",
				id: request.id,
				result,
			};
			this._publish(JSON.stringify(response));
		})();
	}

	// biome-ignore lint/suspicious/noExplicitAny: this is a generic handler for all requests, so we can't type params
	private async _handleRequest(method: string, params: any): Promise<any> {
		switch (method) {
			case "initialize":
				return {
					capabilities: {
						textDocumentSync: 1,
					},
				};
			case "textDocument/didOpen":
			case "textDocument/didChange": {
				if (!useFileTreeStore.getState().ready) return null;
				const uri: string = params.textDocument?.uri;
				if (!uri) return null;

				const generation = (this.latest.get(uri) ?? 0) + 1;
				this.latest.set(uri, generation);

				try {
					await getBallerinaWorkerClient().whenReady();
				} catch {
					return null;
				}
				if (this.latest.get(uri) !== generation) return null;

				try {
					await useFileTreeStore.getState().saveFile();
					const fs = useFileTreeStore.getState().fs();
					const targetPath = await getBallerinaProjectTarget(fs, uri);
					const snapshot = await SnapshotFS.from(fs, targetPath);
					const diagnostics = await getBallerinaWorkerClient().getDiagnostics(
						snapshot,
						targetPath,
					);
					// A newer edit arrived while computing; its result supersedes ours.
					if (this.latest.get(uri) !== generation) return null;

					this._publish(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "textDocument/publishDiagnostics",
							params: {
								uri,
								diagnostics: diagnostics ?? [],
							},
						}),
					);
				} catch {
					if (this.latest.get(uri) !== generation) return null;
					this._publish(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "textDocument/publishDiagnostics",
							params: {
								uri,
								diagnostics: [],
							},
						}),
					);
				}
				return null;
			}
		}
	}

	private _publish(d: string): void {
		this.handlers.forEach((h) => {
			h(d);
		});
	}

	subscribe(handler: (value: string) => void): void {
		this.handlers.push(handler);
	}

	unsubscribe(handler: (value: string) => void): void {
		this.handlers = this.handlers.filter((h) => h !== handler);
	}
}
