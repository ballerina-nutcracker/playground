import { TEMP_ROOT } from "@/lib/fs/fs-roots";
import {
	basename,
	dirname,
	join,
	pathSegments,
} from "@/lib/fs/core/path-utils";

import {
	cleanFSPath,
	FSWatchRegistry,
	isDescendant,
} from "@/lib/fs/fs-watch-registry";
import type { FSWatchCallback } from "@/lib/fs/fs-watch-registry";

import type {
	DirEntry,
	FS,
	OpenResult,
	StatResult,
} from "@/lib/fs/core/fs.interface";

type SnapshotFileNode = {
	readonly isDir: false;
	readonly content: string;
	readonly modTime: number;
	readonly size: number;
};

type SnapshotDirNode = {
	readonly isDir: true;
	readonly modTime: number;
	readonly entries: readonly DirEntry[];
};

type SnapshotNode = SnapshotFileNode | SnapshotDirNode;

export type SnapshotFSMutation =
	| { type: "writeFile"; path: string; content: string }
	| { type: "mkdirAll"; path: string }
	| { type: "remove"; path: string }
	| { type: "move"; oldPath: string; newPath: string };

export type SnapshotFSListener = (mutation: SnapshotFSMutation) => void;

export class SnapshotFS implements FS {
	private readonly listeners: Set<SnapshotFSListener> = new Set();
	private readonly watches = new FSWatchRegistry();

	private constructor(private readonly nodes: Map<string, SnapshotNode>) {}

	static async from(source: FS, rootPath: string): Promise<SnapshotFS> {
		rootPath = cleanFSPath(rootPath);
		const nodes = new Map<string, SnapshotNode>();
		await collectNodes(source, nodes, rootPath);
		await collectAncestorDirs(source, nodes, rootPath);
		await collectNodes(source, nodes, TEMP_ROOT);
		if (!nodes.has(TEMP_ROOT)) {
			nodes.set(TEMP_ROOT, {
				isDir: true,
				modTime: Date.now(),
				entries: [],
			});
		}
		return new SnapshotFS(nodes);
	}

	private notifyListeners(mutation: SnapshotFSMutation) {
		for (const listener of this.listeners) {
			listener(mutation);
		}
	}

	onMutation(listener: SnapshotFSListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async watch(
		path: string,
		recursive: boolean,
		callback: FSWatchCallback,
	): Promise<string> {
		path = cleanFSPath(path);
		const node = this.nodes.get(path);
		if (!node) throw new Error(`Watch directory does not exist: ${path}`);
		if (!node.isDir) throw new Error(`Watch path is not a directory: ${path}`);
		return this.watches.watch(path, recursive, callback);
	}

	unwatch(id: string): Promise<void> {
		return this.watches.unwatch(id);
	}

	dispose(): void {
		this.watches.dispose();
		this.listeners.clear();
	}

	private getDirectoryEntries(path: string): DirEntry[] {
		const entries: DirEntry[] = [];
		for (const [candidate, node] of this.nodes) {
			if (candidate === path || dirname(candidate) !== path) continue;
			entries.push({ name: basename(candidate), isDir: node.isDir });
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	}

	async open(path: string): Promise<OpenResult | null> {
		path = cleanFSPath(path);
		const node = this.nodes.get(path);
		if (!node || node.isDir) return null;
		return {
			content: node.content,
			size: node.size,
			modTime: node.modTime,
			isDir: false,
		};
	}

	async stat(path: string): Promise<StatResult | null> {
		path = cleanFSPath(path);
		const node = this.nodes.get(path);
		if (!node) return null;
		return {
			name: basename(path),
			size: node.isDir ? 0 : node.size,
			modTime: node.modTime,
			isDir: node.isDir,
		};
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		path = cleanFSPath(path);
		const node = this.nodes.get(path);
		if (!node?.isDir) return null;
		return this.getDirectoryEntries(path);
	}

	async writeFile(path: string, content: string): Promise<boolean> {
		path = cleanFSPath(path);
		const parentPath = dirname(path);
		const parent = this.nodes.get(parentPath);
		if (parentPath && parentPath !== "." && !parent?.isDir) {
			return false;
		}

		const existing = this.nodes.get(path);
		if (existing?.isDir) return false;

		this.nodes.set(path, {
			isDir: false,
			content,
			modTime: Date.now(),
			size: new TextEncoder().encode(content).byteLength,
		});
		this.watches.publish({ path, op: existing ? "modify" : "create" });
		this.notifyListeners({ type: "writeFile", path, content });
		return true;
	}

	async mkdirAll(path: string): Promise<boolean> {
		path = cleanFSPath(path);
		if (!path || path === "." || path === "/") return true;

		const leading = path.startsWith("/") ? "/" : "";
		let current = leading || ".";
		const created: string[] = [];

		for (const segment of pathSegments(path)) {
			current =
				current === "/" || current === "."
					? `${leading}${segment}`
					: join(current, segment);

			const existing = this.nodes.get(current);
			if (existing && !existing.isDir) {
				for (const createdPath of created) {
					this.nodes.delete(createdPath);
				}
				return false;
			}
			if (!existing) {
				this.nodes.set(current, {
					isDir: true,
					modTime: Date.now(),
					entries: [],
				});
				created.push(current);
			}
		}
		for (const createdPath of created) {
			this.watches.publish({ path: createdPath, op: "create" });
		}
		this.notifyListeners({ type: "mkdirAll", path });
		return true;
	}

	private subtree(path: string): string[] {
		return [...this.nodes.keys()]
			.filter(
				(candidate) => candidate === path || isDescendant(candidate, path),
			)
			.sort(
				(a, b) =>
					a.split("/").length - b.split("/").length || a.localeCompare(b),
			);
	}

	async remove(path: string): Promise<boolean> {
		path = cleanFSPath(path);
		if (path === "/" || path === "." || !this.nodes.has(path)) return false;
		const removed = this.subtree(path).reverse();
		for (const candidate of removed) this.nodes.delete(candidate);
		for (const candidate of removed) {
			this.watches.publish({ path: candidate, op: "delete" });
		}
		this.notifyListeners({ type: "remove", path });
		return true;
	}

	async move(oldPath: string, newPath: string): Promise<boolean> {
		oldPath = cleanFSPath(oldPath);
		newPath = cleanFSPath(newPath);
		if (!this.nodes.has(oldPath)) return false;
		if (oldPath === newPath) return true;
		if (
			oldPath === "/" ||
			oldPath === "." ||
			isDescendant(newPath, oldPath) ||
			this.nodes.has(newPath) ||
			!this.nodes.get(dirname(newPath))?.isDir
		)
			return false;

		const moved = this.subtree(oldPath);
		for (const candidate of moved) {
			const node = this.nodes.get(candidate);
			if (node) this.nodes.set(newPath + candidate.slice(oldPath.length), node);
			this.nodes.delete(candidate);
		}
		for (const candidate of [...moved].reverse()) {
			this.watches.publish({ path: candidate, op: "delete" });
		}
		for (const candidate of moved) {
			this.watches.publish({
				path: newPath + candidate.slice(oldPath.length),
				op: "create",
			});
		}
		this.notifyListeners({ type: "move", oldPath, newPath });
		return true;
	}
}

async function collectNodes(
	source: FS,
	nodes: Map<string, SnapshotNode>,
	path: string,
): Promise<void> {
	const info = await source.stat(path);
	if (!info) return;

	if (!info.isDir) {
		await collectFileNode(source, nodes, path);
	} else {
		await collectDirNode(source, nodes, path, info.modTime);
	}
}

async function collectFileNode(
	source: FS,
	nodes: Map<string, SnapshotNode>,
	path: string,
): Promise<void> {
	const file = await source.open(path);
	if (!file) return;
	nodes.set(path, {
		isDir: false,
		content: file.content,
		modTime: file.modTime,
		size: file.size,
	});
}

async function collectDirNode(
	source: FS,
	nodes: Map<string, SnapshotNode>,
	path: string,
	modTime: number,
): Promise<void> {
	const rawEntries = (await source.readDir(path)) ?? [];
	const entries = rawEntries
		.map(({ name, isDir }) => ({ name, isDir }))
		.sort((a, b) => a.name.localeCompare(b.name));

	nodes.set(path, { isDir: true, modTime, entries });

	for (const entry of entries) {
		await collectNodes(source, nodes, join(path, entry.name));
	}
}

async function collectAncestorDirs(
	source: FS,
	nodes: Map<string, SnapshotNode>,
	path: string,
): Promise<void> {
	let current = dirname(path);
	while (current && current !== ".") {
		if (!nodes.has(current)) {
			const info = await source.stat(current);
			if (!info?.isDir) return;
			nodes.set(current, {
				isDir: true,
				modTime: info.modTime,
				entries: [],
			});
		}
		if (current === "/") return;
		current = dirname(current);
	}
}
