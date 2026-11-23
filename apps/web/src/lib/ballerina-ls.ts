import { languageServerFiles } from "@/lib/language-server-files";
import {
	languageServerUri,
	LANGUAGE_SERVER_ROOT,
} from "@/lib/language-server-uri";
import { useFileTreeStore } from "@/stores/file-tree-store";
import { LanguageServerWorkerClient } from "@/workers/language-server-worker-client";

import type { Transport } from "@codemirror/lsp-client";
import type { LanguageServerConnection } from "@/workers/language-server-worker-client";
import type { LanguageServerFile } from "@/workers/language-server-worker-api";

export interface LanguageServerFileSource {
	ready(): Promise<void>;
	snapshot(): LanguageServerFile[];
	subscribe(onSavedFilesChanged: () => void): () => void;
}

const savedFiles: LanguageServerFileSource = {
	ready: () => {
		if (useFileTreeStore.getState().ready) return Promise.resolve();
		return new Promise((resolve) => {
			const unsubscribe = useFileTreeStore.subscribe((state) => {
				if (state.ready) {
					unsubscribe();
					resolve();
				}
			});
		});
	},
	snapshot: () => {
		const { tempTree, localTree } = useFileTreeStore.getState();
		return languageServerFiles(tempTree, localTree);
	},
	subscribe: (onChange) =>
		useFileTreeStore.subscribe((state, previous) => {
			if (
				state.ready &&
				(state.tempTree !== previous.tempTree ||
					state.localTree !== previous.localTree)
			) {
				onChange();
			}
		}),
};

interface Message {
	id?: string | number;
	method?: string;
	params?: {
		textDocument?: { uri: string; version?: number };
		uri?: string;
		version?: number;
	};
}

/** Ordered, unframed JSON-RPC transport; capabilities come from the Go server. */
export class BallerinaLS implements Transport {
	private handlers = new Set<(value: string) => void>();
	private queue: Promise<void> = Promise.resolve();
	private versions = new Map<string, number>();
	private files: Map<string, LanguageServerFile> | null = null;
	private initialized = false;
	private started = false;
	private disposed = false;
	private unsubscribeFiles: () => void;

	constructor(
		private client: LanguageServerConnection = new LanguageServerWorkerClient(),
		private source: LanguageServerFileSource = savedFiles,
	) {
		this.unsubscribeFiles = source.subscribe(() => {
			if (this.started) this.enqueue(() => this.syncFiles());
		});
	}

	/** Load the WASM runtime and saved files before any LSP request is timed. */
	async start(): Promise<void> {
		await this.client.init(this.receive);
		await this.source.ready();
	}

	send(message: string): void {
		if (this.disposed) return;
		const request: Message = JSON.parse(message);
		const document = request.params?.textDocument;
		if (
			(request.method === "textDocument/didOpen" ||
				request.method === "textDocument/didChange") &&
			document &&
			typeof document.version === "number"
		) {
			// Track immediately, not when the async send completes, so older
			// diagnostics arriving while a newer edit is queued cannot flash.
			this.versions.set(document.uri, document.version);
		}
		this.started = true;
		this.enqueue(async () => {
			await this.client.init(this.receive);
			await this.source.ready();
			if (this.disposed) return;
			if (
				!this.files ||
				request.method === "initialized" ||
				request.method === "textDocument/didOpen"
			) {
				await this.syncFiles();
			}
			await this.client.send(message);
			if (request.method === "initialized") this.initialized = true;
		}, request.id);
	}

	private enqueue(task: () => Promise<void>, id?: string | number): void {
		this.queue = this.queue
			.then(() => (this.disposed ? undefined : task()))
			.catch((error: unknown) => {
				console.error("Language server transport failed", error);
				if (!this.disposed && id !== undefined) {
					this.publish(
						JSON.stringify({
							jsonrpc: "2.0",
							id,
							error: { code: -32603, message: String(error) },
						}),
					);
				}
			});
	}

	private async syncFiles(): Promise<void> {
		// Read at execution time: queued saves must never roll back a newer
		// snapshot copied while the WASM runtime was still starting.
		await this.source.ready();
		if (this.disposed) return;
		const entries = this.source.snapshot();
		const next = new Map(entries.map((entry) => [entry.path, entry]));
		const changes: { uri: string; type: number }[] = [];
		for (const [path, entry] of next) {
			const previous = this.files?.get(path);
			if (
				!previous ||
				previous.isDir !== entry.isDir ||
				previous.content !== entry.content
			) {
				changes.push({
					uri: languageServerUri(path.slice(LANGUAGE_SERVER_ROOT.length)),
					type: previous ? 2 : 1,
				});
			}
		}
		for (const path of this.files?.keys() ?? []) {
			if (!next.has(path))
				changes.push({
					uri: languageServerUri(path.slice(LANGUAGE_SERVER_ROOT.length)),
					type: 3,
				});
		}
		if (this.files && !changes.length) return;
		await this.client.updateFiles(entries);
		this.files = next;
		if (this.initialized && changes.length) {
			await this.client.send(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "workspace/didChangeWatchedFiles",
					params: { changes },
				}),
			);
		}
	}

	private receive = (message: string): void => {
		const notification: Message = JSON.parse(message);
		if (notification.method === "textDocument/publishDiagnostics") {
			const { uri, version } = notification.params ?? {};
			const current = uri ? this.versions.get(uri) : undefined;
			if (
				typeof version === "number" &&
				current !== undefined &&
				version !== current
			)
				return;
		}
		// Preserve each URI, version, range, severity, and diagnostic payload.
		this.publish(message);
	};

	private publish(message: string): void {
		if (!this.disposed) for (const handler of this.handlers) handler(message);
	}

	subscribe(handler: (value: string) => void): void {
		this.handlers.add(handler);
	}

	unsubscribe(handler: (value: string) => void): void {
		this.handlers.delete(handler);
	}

	/** Wait for queued sends and filesystem updates (not server responses). */
	whenIdle(): Promise<void> {
		return this.queue;
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeFiles();
		this.handlers.clear();
		this.client.dispose();
	}
}
