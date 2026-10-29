import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { immer } from "zustand/middleware/immer";

import { LOCAL_ROOT } from "@/lib/fs/fs-roots";
import { ancestorDirPathsForFile, isUnder } from "@/lib/fs/core/path-utils";

import type { LayeredFS } from "@/lib/fs/layered-fs";
import type { FileNode } from "@/lib/fs/core/file-node.types";
import type { SnapshotFSMutation } from "@/lib/fs/snapshot";

const DEFAULT_MAIN_BAL = `import ballerina/io;

public function main() {
    io:println("Hello, World!");
}`;

const DEFAULT_BALLERINA_TOML = `[package]
org = "playground"
name = "{name}"
version = "0.1.0"`;

export type ActiveFile = {
	path: string;
	content: string;
	dirty: boolean;
};

export type FileOperationDialog = {
	type:
		| "new-file"
		| "new-folder"
		| "new-package"
		| "rename-file"
		| "rename-folder"
		| "delete-file"
		| "delete-folder"
		| "fork-file"
		| "fork-folder";
	path: string;
	defaultName?: string;
} | null;

type FileTreeState = {
	tempTree: FileNode[];
	localTree: FileNode[];
	activeFile: ActiveFile | null;
	ready: boolean;

	fileOperationDialog: FileOperationDialog;

	expandedPaths: Set<string>;
};

type FileTreeActions = {
	init(fs: LayeredFS): Promise<void>;
	fs(): LayeredFS;

	openFile(path: string): Promise<void>;
	saveFile(): Promise<boolean>;
	createFile(path: string): Promise<boolean>;
	deleteFile(path: string): Promise<boolean>;
	renameFile(oldPath: string, newPath: string): Promise<boolean>;

	createDir(path: string): Promise<boolean>;
	deleteDir(path: string): Promise<boolean>;
	clearLocalspace(): void;

	updateFileContent(content: string): void;

	exists(path: string): Promise<boolean>;
	existsFile(path: string): Promise<boolean>;

	createNewFile(path: string): Promise<boolean>;
	createNewDir(path: string): Promise<boolean>;

	createNewPackage(path: string, name: string): Promise<boolean>;

	setFileOperationDialog(dialog: FileOperationDialog): void;

	toggleDir(path: string): void;
	expandDir(path: string): void;
	collapseDir(path: string): void;

	_syncTrees(): Promise<void>;

	applyMutation(mutation: SnapshotFSMutation): Promise<void>;

	loadSharedFiles(
		root: FileNode,
		openRelativePath?: string | null,
	): Promise<{ loaded: boolean; openPath: string | null }>;
};

export const useFileTreeStore = create<FileTreeState & FileTreeActions>()(
	immer((set, get) => {
		let fs: LayeredFS | null = null;

		const _fs = (): LayeredFS => {
			if (!fs) throw new Error("[FileTreeStore] FS not initialised");
			return fs;
		};

		return {
			tempTree: [],
			localTree: [],
			activeFile: null,
			ready: false,
			fileOperationDialog: null,
			expandedPaths: new Set<string>(),

			async init(instance) {
				if (fs) return;
				fs = instance;
				const tempTree = await fs.tempTree();
				const localTree = await fs.localTree();
				set((s) => {
					if (!fs) return;
					s.tempTree = tempTree;
					s.localTree = localTree;
					s.ready = true;
				});
			},

			fs() {
				return _fs();
			},

			async openFile(path) {
				const file = await _fs().open(path);
				if (!file) return;
				const dirs = ancestorDirPathsForFile(path);
				set((s) => {
					s.activeFile = {
						path,
						content: file.content,
						dirty: false,
					};
					for (const d of dirs) s.expandedPaths.add(d);
				});
			},

			async saveFile() {
				const { activeFile } = get();
				if (!activeFile?.dirty) return false;
				const result = await _fs().writeFile(
					activeFile.path,
					activeFile.content,
				);
				if (!result) return false;
				set((s) => {
					if (s.activeFile) s.activeFile.dirty = false;
				});
				await get()._syncTrees();
				return true;
			},

			async createFile(path) {
				const result = await _fs().writeFile(path, "");
				if (!result) return false;
				await get()._syncTrees();
				return true;
			},

			async deleteFile(path) {
				const result = await _fs().remove(path);
				if (!result) return false;
				set((s) => {
					if (s.activeFile?.path === path) s.activeFile = null;
				});
				await get()._syncTrees();
				return true;
			},

			async renameFile(oldPath, newPath) {
				const result = await _fs().move(oldPath, newPath);
				if (!result) return false;
				set((s) => {
					if (!s.activeFile) return;
					const currentPath = s.activeFile.path;
					let moved = false;
					if (currentPath === oldPath) {
						s.activeFile.path = newPath;
						moved = true;
					} else if (currentPath.startsWith(`${oldPath}/`)) {
						const suffix = currentPath.slice(oldPath.length);
						s.activeFile.path = newPath + suffix;
						moved = true;
					}
					if (moved) {
						for (const d of ancestorDirPathsForFile(s.activeFile.path)) {
							s.expandedPaths.add(d);
						}
					}
				});
				await get()._syncTrees();
				return true;
			},

			async createDir(path) {
				const result = await _fs().mkdirAll(path);
				if (!result) return false;
				await get()._syncTrees();
				return true;
			},

			async deleteDir(path) {
				const result = await _fs().remove(path);
				if (!result) return false;
				set((s) => {
					const activePath = s.activeFile?.path;
					if (activePath === path || activePath?.startsWith(`${path}/`)) {
						s.activeFile = null;
					}
				});
				await get()._syncTrees();
				return true;
			},

			clearLocalspace() {
				_fs().clearLocalspace();
				set((s) => {
					s.localTree = [];
					s.expandedPaths = new Set(
						[...s.expandedPaths].filter((path) => !isUnder(path, LOCAL_ROOT)),
					);
					if (s.activeFile && isUnder(s.activeFile.path, LOCAL_ROOT)) {
						s.activeFile = null;
					}
				});
			},

			updateFileContent(content) {
				set((s) => {
					if (s.activeFile) {
						s.activeFile.content = content;
						s.activeFile.dirty = true;
					}
				});
			},

			async exists(path) {
				try {
					return !!(await _fs().stat(path));
				} catch {
					return false;
				}
			},

			async existsFile(path) {
				try {
					const info = await _fs().stat(path);
					return !!info && !info.isDir;
				} catch {
					return false;
				}
			},

			async createNewFile(path) {
				const result = await _fs().writeFile(path, "");
				if (!result) return false;
				await get()._syncTrees();
				await get().openFile(path);
				return true;
			},

			async createNewDir(path) {
				const result = await _fs().mkdirAll(path);
				if (!result) return false;
				await get()._syncTrees();
				return true;
			},

			async createNewPackage(path, name) {
				const dirPath = `${path}/${name}`;
				const dirResult = await _fs().mkdirAll(dirPath);
				if (!dirResult) return false;
				const tomlPath = `${dirPath}/Ballerina.toml`;
				const balPath = `${dirPath}/main.bal`;
				const [tomlResult, balResult] = await Promise.all([
					_fs().writeFile(
						tomlPath,
						DEFAULT_BALLERINA_TOML.replace("{name}", name),
					),
					_fs().writeFile(balPath, DEFAULT_MAIN_BAL),
				]);
				if (!tomlResult || !balResult) {
					await _fs().remove(dirPath);
					await get()._syncTrees();
					return false;
				}
				await get()._syncTrees();
				await get().openFile(balPath);
				return true;
			},

			setFileOperationDialog(dialog) {
				set((s) => {
					s.fileOperationDialog = dialog;
				});
			},

			toggleDir(path) {
				set((s) => {
					if (s.expandedPaths.has(path)) {
						s.expandedPaths.delete(path);
					} else {
						s.expandedPaths.add(path);
					}
				});
			},

			expandDir(path) {
				set((s) => {
					s.expandedPaths.add(path);
				});
			},

			collapseDir(path) {
				set((s) => {
					s.expandedPaths.delete(path);
				});
			},

			async _syncTrees() {
				const fs = _fs();
				const tempTree = await fs.tempTree();
				const localTree = await fs.localTree();
				set((s) => {
					s.tempTree = tempTree;
					s.localTree = localTree;
				});
			},

			async applyMutation(mutation: SnapshotFSMutation) {
				const fs = _fs();
				switch (mutation.type) {
					case "writeFile": {
						const result = await fs.writeFile(mutation.path, mutation.content);
						if (!result) {
							throw new Error(`writeFile failed: ${mutation.path}`);
						}
						const dirs = ancestorDirPathsForFile(mutation.path);
						set((s) => {
							for (const d of dirs) s.expandedPaths.add(d);
							if (s.activeFile?.path === mutation.path && !s.activeFile.dirty) {
								s.activeFile.content = mutation.content;
							}
						});
						break;
					}
					case "mkdirAll": {
						const result = await fs.mkdirAll(mutation.path);
						if (!result) {
							throw new Error(`mkdirAll failed: ${mutation.path}`);
						}
						set((s) => {
							s.expandedPaths.add(mutation.path);
							for (const path of ancestorDirPathsForFile(mutation.path)) {
								s.expandedPaths.add(path);
							}
						});
						break;
					}
					case "remove": {
						const result = await fs.remove(mutation.path);
						if (!result) {
							throw new Error(`remove failed: ${mutation.path}`);
						}
						set((s) => {
							if (
								s.activeFile &&
								(s.activeFile.path === mutation.path ||
									s.activeFile.path.startsWith(`${mutation.path}/`))
							) {
								s.activeFile = null;
							}
						});
						break;
					}
					case "move": {
						const result = await fs.move(mutation.oldPath, mutation.newPath);
						if (!result) {
							throw new Error(`move failed: ${mutation.oldPath}`);
						}
						set((s) => {
							if (
								s.activeFile &&
								(s.activeFile.path === mutation.oldPath ||
									s.activeFile.path.startsWith(`${mutation.oldPath}/`))
							) {
								s.activeFile.path = `${mutation.newPath}${s.activeFile.path.slice(mutation.oldPath.length)}`;
							}
						});
						break;
					}
				}
				await get()._syncTrees();
			},

			async loadSharedFiles(
				root: FileNode,
				openRelativePath?: string | null,
			): Promise<{ loaded: boolean; openPath: string | null }> {
				try {
					const openPath = await _fs().graftSharedTree(root, openRelativePath);
					const tempTree = await _fs().tempTree();
					const localTree = await _fs().localTree();
					set((s) => {
						s.tempTree = tempTree;
						s.localTree = localTree;
					});
					return { loaded: true, openPath };
				} catch {
					return { loaded: false, openPath: null };
				}
			},
		};
	}),
);

export const useTempTree = () => useFileTreeStore((s) => s.tempTree);
export const useLocalTree = () => useFileTreeStore((s) => s.localTree);

export const useActiveFile = () => useFileTreeStore((s) => s.activeFile);
export const useActiveFilePath = () =>
	useFileTreeStore((s) => s.activeFile?.path ?? null);

export const useFileOperationDialog = () =>
	useFileTreeStore((s) => s.fileOperationDialog);

export const useExpandedPaths = () => useFileTreeStore((s) => s.expandedPaths);

export const useFileTreeActions = () =>
	useFileTreeStore(
		useShallow((s) => ({
			openFile: s.openFile,
			saveFile: s.saveFile,
			createFile: s.createFile,
			deleteFile: s.deleteFile,
			renameFile: s.renameFile,
			createDir: s.createDir,
			deleteDir: s.deleteDir,
			clearLocalspace: s.clearLocalspace,
			updateFileContent: s.updateFileContent,
			exists: s.exists,
			existsFile: s.existsFile,
			createNewFile: s.createNewFile,
			createNewDir: s.createNewDir,
			createNewPackage: s.createNewPackage,
			setFileOperationDialog: s.setFileOperationDialog,
			toggleDir: s.toggleDir,
			expandDir: s.expandDir,
			collapseDir: s.collapseDir,
			loadSharedFiles: s.loadSharedFiles,
		})),
	);
