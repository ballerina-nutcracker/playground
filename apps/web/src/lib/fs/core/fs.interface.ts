export type OpenResult = {
	content: Uint8Array;
	size: number;
	modTime: number;
	isDir: boolean;
};

export type StatResult = {
	name: string;
	size: number;
	modTime: number;
	isDir: boolean;
};

export type DirEntry = {
	name: string;
	isDir: boolean;
};

export interface FS {
	open(path: string): Promise<OpenResult | null>;
	stat(path: string): Promise<StatResult | null>;
	readDir(path: string): Promise<DirEntry[] | null>;
	/** `modTime` (epoch ms) defaults to now. */
	writeFile(
		path: string,
		content: Uint8Array,
		modTime?: number,
	): Promise<boolean>;
	remove(path: string): Promise<boolean>;
	move(oldPath: string, newPath: string): Promise<boolean>;
	mkdirAll(path: string): Promise<boolean>;
}
