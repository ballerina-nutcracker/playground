import { firstFilePathInSubtree } from "@/lib/fs/core/file-node-utils";
import {
	isRootPath,
	isSafeRelativePath,
	isUnder,
	join,
} from "@/lib/fs/core/path-utils";

import { LOCAL_ROOT, SHARED_ROOT, TEMP_ROOT } from "@/lib/fs/fs-roots";

import type { FS } from "@/lib/fs/core/fs.interface";
import type { EphemeralFS } from "@/lib/fs/ephemeral-fs";
import type { LocalStorageFS } from "@/lib/fs/local-storage-fs";
import type { FileNode } from "@/lib/fs/core/file-node.types";

export type Namespace = "temp" | "local";

export class LayeredFS implements FS {
	constructor(
		private readonly temp: EphemeralFS,
		private readonly local: LocalStorageFS,
	) {}

	async open(path: string) {
		return this._withTargetOrNull(path, (fs) => fs.open(path));
	}

	async stat(path: string) {
		if (isRootPath(path))
			return {
				name: "/",
				size: 0,
				modTime: 0,
				isDir: true,
			};
		return this._withTargetOrNull(path, (fs) => fs.stat(path));
	}

	async readDir(path: string) {
		if (isRootPath(path))
			return [
				{ name: TEMP_ROOT.slice(1), isDir: true },
				{ name: LOCAL_ROOT.slice(1), isDir: true },
			];
		return this._withTargetOrNull(path, (fs) => fs.readDir(path));
	}

	async writeFile(path: string, content: string, modTime?: number) {
		return this._withTargetOrFalse(path, (fs) =>
			fs.writeFile(path, content, modTime),
		);
	}

	async remove(path: string) {
		return this._withTargetOrFalse(path, (fs) => fs.remove(path));
	}

	async move(oldPath: string, newPath: string) {
		const oldTarget = this._target(oldPath);
		const newTarget = this._target(newPath);
		if (!oldTarget || !newTarget) return false;
		if (oldTarget === newTarget) return oldTarget.move(oldPath, newPath);
		return this._moveToTarget(oldTarget, newTarget, oldPath, newPath);
	}

	async mkdirAll(path: string) {
		return this._withTargetOrFalse(path, (fs) => fs.mkdirAll(path));
	}

	async tempTree() {
		return this.temp.transformToTree(TEMP_ROOT);
	}

	async localTree() {
		return this.local.transformToTree("/local");
	}

	clearLocalspace() {
		this.local.clear();
	}

	async graftSharedTree(
		root: FileNode,
		openRelativePath?: string | null,
	): Promise<string | null> {
		this.temp.insertSubtree(SHARED_ROOT, root);

		const trimmed = openRelativePath?.trim();
		if (trimmed && isSafeRelativePath(trimmed)) {
			const candidate = join(SHARED_ROOT, trimmed);
			const info = await this.stat(candidate);
			if (info && !info.isDir) return candidate;
		}

		return firstFilePathInSubtree(root, SHARED_ROOT);
	}

	private async _moveToTarget(
		oldTarget: FS,
		newTarget: FS,
		oldPath: string,
		newPath: string,
		createdPaths: string[] = [],
	): Promise<boolean> {
		const info = await oldTarget.stat(oldPath);
		if (!info) return false;

		if (info.isDir) {
			const exists = await newTarget.stat(newPath);
			if (exists && !exists.isDir) return false;
			if (!exists) {
				if (!(await newTarget.mkdirAll(newPath))) return false;
				createdPaths.push(newPath);
			}

			const entries = await oldTarget.readDir(oldPath);
			if (!entries) {
				await this._rollback(newTarget, createdPaths);
				return false;
			}

			let success = true;
			for (const entry of entries) {
				const src = join(oldPath, entry.name);
				const dst = join(newPath, entry.name);
				if (
					!(await this._moveToTarget(
						oldTarget,
						newTarget,
						src,
						dst,
						createdPaths,
					))
				) {
					success = false;
					break;
				}
			}

			if (!success) {
				await this._rollback(newTarget, createdPaths);
				return false;
			}
		} else {
			const file = await oldTarget.open(oldPath);
			if (!file) return false;

			const exists = await newTarget.stat(newPath);

			if (!(await newTarget.writeFile(newPath, file.content))) {
				await this._rollback(newTarget, createdPaths);
				return false;
			}
			if (!exists) createdPaths.push(newPath);
		}

		return oldTarget.remove(oldPath);
	}

	private async _rollback(target: FS, createdPaths: string[]): Promise<void> {
		for (const p of [...createdPaths].reverse()) {
			await target.remove(p).catch(() => {});
		}
	}

	private _namespace(path: string): Namespace | null {
		if (isUnder(path, TEMP_ROOT)) return "temp";
		if (isUnder(path, LOCAL_ROOT)) return "local";
		return null;
	}

	private _target(path: string): FS | null {
		const ns = this._namespace(path);
		if (ns === "temp") return this.temp;
		if (ns === "local") return this.local;
		return null;
	}

	private async _withTargetOrNull<T>(
		path: string,
		fn: (fs: FS) => Promise<T | null>,
	): Promise<T | null> {
		const target = this._target(path);
		if (!target) return null;
		return fn(target);
	}

	private async _withTargetOrFalse(
		path: string,
		fn: (fs: FS) => Promise<boolean>,
	): Promise<boolean> {
		const target = this._target(path);
		if (!target) return false;
		return await fn(target);
	}
}
