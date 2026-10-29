import * as Comlink from "comlink";

import type { FS } from "@/lib/fs/core/fs.interface";
import type { FSWatchCallback } from "@/lib/fs/fs-watch-registry";
import type { SnapshotFS } from "@/lib/fs/snapshot";

export interface WatchableFS extends FS {
	watch(
		path: string,
		recursive: boolean,
		callback: FSWatchCallback,
	): Promise<string>;
	unwatch(id: string): Promise<void>;
}

function forwardFS(fs: FS): FS {
	return {
		open: (path) => fs.open(path),
		stat: (path) => fs.stat(path),
		readDir: (path) => fs.readDir(path),
		writeFile: (path, content) => fs.writeFile(path, content),
		mkdirAll: (path) => fs.mkdirAll(path),
		remove: (path) => fs.remove(path),
		move: (from, to) => fs.move(from, to),
	};
}

export function exposeSnapshotFS(snapshot: SnapshotFS) {
	const callbacks = new Map<string, Comlink.Remote<FSWatchCallback>>();
	let disposed = false;
	const fs: WatchableFS = {
		...forwardFS(snapshot),
		async watch(path, recursive, callback) {
			const remote = callback as Comlink.Remote<FSWatchCallback>;
			try {
				if (disposed) throw new Error("Filesystem bridge is disposed");
				const id = await snapshot.watch(path, recursive, remote);
				if (disposed) {
					await snapshot.unwatch(id);
					throw new Error("Filesystem bridge is disposed");
				}
				callbacks.set(id, remote);
				return id;
			} catch (error) {
				remote[Comlink.releaseProxy]();
				throw error;
			}
		},
		async unwatch(id) {
			await snapshot.unwatch(id);
			callbacks.get(id)?.[Comlink.releaseProxy]();
			callbacks.delete(id);
		},
	};
	return {
		fs,
		dispose() {
			disposed = true;
			snapshot.dispose();
			for (const callback of callbacks.values())
				callback[Comlink.releaseProxy]();
			callbacks.clear();
		},
	};
}

export function connectWatchableFS(remote: WatchableFS) {
	const gates = new Map<string, { callback?: FSWatchCallback }>();
	const pending = new Set<{ callback?: FSWatchCallback }>();
	let disposed = false;
	const fs: WatchableFS = {
		...forwardFS(remote),
		async watch(path, recursive, callback) {
			if (disposed) throw new Error("Filesystem bridge is disposed");
			const gate: { callback?: FSWatchCallback } = { callback };
			pending.add(gate);
			try {
				const id = await remote.watch(
					path,
					recursive,
					Comlink.proxy((event) => gate.callback?.(event)),
				);
				if (disposed) {
					gate.callback = undefined;
					await remote.unwatch(id);
					throw new Error("Filesystem bridge is disposed");
				}
				gates.set(id, gate);
				return id;
			} catch (error) {
				gate.callback = undefined;
				throw error;
			} finally {
				pending.delete(gate);
			}
		},
		async unwatch(id) {
			const gate = gates.get(id);
			if (gate) gate.callback = undefined;
			gates.delete(id);
			await remote.unwatch(id);
		},
	};
	return {
		fs,
		async dispose() {
			disposed = true;
			const ids = [...gates.keys()];
			for (const gate of gates.values()) gate.callback = undefined;
			for (const gate of pending) gate.callback = undefined;
			gates.clear();
			pending.clear();
			await Promise.all(ids.map((id) => remote.unwatch(id)));
		},
	};
}
