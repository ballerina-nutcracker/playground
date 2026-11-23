import { decodeText, encodeText } from "@/lib/fs/core/bytes";
import { basename, pathSegments } from "@/lib/fs/core/path-utils";

import type {
	DirEntry,
	FS,
	OpenResult,
	StatResult,
} from "@/lib/fs/core/fs.interface";
import type { FileNode } from "@/lib/fs/core/file-node.types";

export type FSNode = {
	isDir: boolean;
	content?: Uint8Array;
	modTime?: number;
	children?: Record<string, FSNode>;
};

export class AbstractFS implements FS {
	protected data: FSNode = { isDir: true, children: {} };

	async open(path: string): Promise<OpenResult | null> {
		const node = this._getNode(path, false);
		if (!node || node.isDir) return null;
		const content = node.content?.slice() ?? new Uint8Array();
		return {
			content,
			size: content.byteLength,
			modTime: node.modTime ?? 0,
			isDir: false,
		};
	}

	async stat(path: string): Promise<StatResult | null> {
		const node = this._getNode(path, false);
		if (!node) return null;
		return {
			name: basename(path),
			size: node.isDir ? 0 : (node.content?.byteLength ?? 0),
			modTime: node.modTime ?? 0,
			isDir: node.isDir,
		};
	}

	async readDir(path: string): Promise<DirEntry[] | null> {
		const node = this._getNode(path, false);
		if (!node?.isDir || !node.children) return null;
		return Object.entries(node.children).map(([name, child]) => ({
			name,
			isDir: child.isDir,
		}));
	}

	async writeFile(
		path: string,
		content: Uint8Array,
		modTime?: number,
	): Promise<boolean> {
		try {
			const { parent, name } = this._getParentAndName(path);
			if (!parent) return false;
			if (parent.children?.[name]?.isDir) return false;
			if (!parent.children) parent.children = {};
			parent.children[name] = {
				isDir: false,
				content: content.slice(),
				modTime: modTime ?? Date.now(),
			};
			this._onWrite();
			return true;
		} catch {
			return false;
		}
	}

	async remove(path: string): Promise<boolean> {
		const parts = pathSegments(path);
		if (parts.length === 0) return false;
		const name = parts[parts.length - 1];
		const parentPath = parts.slice(0, -1).join("/");
		const parentNode = parentPath
			? this._getNode(parentPath, false)
			: this.data;
		if (!parentNode?.children?.[name]) return false;
		delete parentNode.children[name];
		this._onWrite();
		return true;
	}

	async move(oldPath: string, newPath: string): Promise<boolean> {
		try {
			if (oldPath === newPath) return true;
			if (newPath.startsWith(`${oldPath}/`)) return false;

			const node = this._getNode(oldPath, false);
			if (!node) return false;
			const { parent: newParent, name: newName } =
				this._getParentAndName(newPath);
			const { parent: oldParent, name: oldName } =
				this._getParentAndName(oldPath);
			if (!newParent || !oldParent) return false;
			if (newParent.children?.[newName]?.isDir) return false;
			if (!newParent.children) newParent.children = {};
			newParent.children[newName] = node;
			delete oldParent.children?.[oldName];
			this._onWrite();
			return true;
		} catch {
			return false;
		}
	}

	async mkdirAll(path: string): Promise<boolean> {
		if (!path || path === "." || path === "/") return true;
		const parts = pathSegments(path);
		let node: FSNode = this.data;
		for (const part of parts) {
			if (!node.children) node.children = {};
			if (!node.children[part]) {
				node.children[part] = {
					isDir: true,
					children: {},
					modTime: Date.now(),
				};
			} else if (!node.children[part].isDir) {
				return false;
			}
			node = node.children[part];
		}
		this._onWrite();
		return true;
	}

	async transformToTree(path: string = ""): Promise<FileNode[]> {
		const entries = await this.readDir(path);
		if (!entries) return [];
		const result: FileNode[] = [];
		for (const entry of entries) {
			const fullPath = path ? `${path}/${entry.name}` : entry.name;
			if (entry.isDir) {
				result.push({
					kind: "dir",
					name: entry.name,
					children: await this.transformToTree(fullPath),
				});
			} else {
				const fileNode = this._getNode(fullPath);
				const isFile = fileNode && !fileNode.isDir;
				result.push({
					kind: "file",
					name: entry.name,
					content:
						isFile && fileNode.content ? decodeText(fileNode.content) : "",
				});
			}
		}
		return result.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	protected _getNode(path: string, autoCreateDirs = true): FSNode | null {
		if (!path || path === "." || path === "/") return this.data;
		const parts = pathSegments(path);
		let node: FSNode = this.data;
		for (const part of parts) {
			if (!node.isDir) return null;
			const children = node.children ?? {};
			if (!children[part]) {
				if (autoCreateDirs) {
					if (!node.children) node.children = {};
					node.children[part] = { isDir: true, children: {} };
				} else {
					return null;
				}
			}
			if (!node.children?.[part]) return null;
			node = node.children[part];
		}
		return node;
	}

	protected _getParentAndName(path: string): {
		parent: FSNode | null;
		name: string;
	} {
		const parts = pathSegments(path);
		if (parts.length === 0) return { parent: null, name: "/" };
		const name = parts[parts.length - 1];
		const parentPath = parts.slice(0, -1).join("/");
		const parent = parentPath ? this._getNode(parentPath) : this.data;
		return { parent: parent ?? null, name };
	}

	protected _seed(tree: FileNode[], prefix: string = ""): void {
		for (const node of tree) {
			const p = prefix ? `${prefix}/${node.name}` : node.name;
			if (node.kind === "dir") {
				void this.mkdirAll(p);
				this._seed(node.children, p);
			} else {
				void this.writeFile(p, encodeText(node.content));
			}
		}
	}

	protected _onWrite(): void {}
}
