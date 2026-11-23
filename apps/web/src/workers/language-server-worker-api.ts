export interface LanguageServerFile {
	/** Absolute, decoded PAL path under /workspace. */
	path: string;
	content?: string;
	isDir: boolean;
}

export interface LanguageServerWorkerAPI {
	init(
		wasmUrl: string,
		runtimeUrl: string,
		onMessage: (message: string) => void,
	): Promise<void>;
	send(message: string): Promise<void>;
	updateFiles(entries: LanguageServerFile[]): Promise<void>;
}
