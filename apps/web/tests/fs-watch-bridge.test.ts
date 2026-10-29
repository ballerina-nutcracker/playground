import { expect, test } from "bun:test";
import * as Comlink from "comlink";

import { SnapshotFS } from "../src/lib/fs/snapshot";
import {
	connectWatchableFS,
	exposeSnapshotFS,
} from "../src/workers/fs-watch-bridge";
import { createFs } from "./test-fs";

import type {
	FSWatchCallback,
	FSWatchEvent,
} from "../src/lib/fs/fs-watch-registry";
import type { WatchableFS } from "../src/workers/fs-watch-bridge";

test("watch callbacks cross Comlink and can call back into the filesystem", async () => {
	const snapshot = await SnapshotFS.from(
		createFs(new Map([["/work/main.bal", ""]])),
		"/",
	);
	const exposed = exposeSnapshotFS(snapshot);
	const { port1, port2 } = new MessageChannel();
	Comlink.expose(exposed.fs, port1);
	const remote = Comlink.wrap<WatchableFS>(port2);
	const connected = connectWatchableFS(remote);
	const events: FSWatchEvent[] = [];
	const ready = Promise.withResolvers<void>();
	try {
		const id = await connected.fs.watch("/work", true, async (event) => {
			events.push(event);
			if ("path" in event && event.path === "/work/first") {
				await connected.fs.writeFile("/work/second", "from callback");
			} else {
				ready.resolve();
			}
		});
		await connected.fs.writeFile("/work/first", "");
		await ready.promise;
		await connected.fs.unwatch(id);
		await connected.fs.unwatch(id);
		await connected.fs.writeFile("/work/ignored", "");
		expect(events).toEqual([
			{ path: "/work/first", op: "create" },
			{ path: "/work/second", op: "create" },
		]);
		expect((await snapshot.open("/work/second"))?.content).toBe(
			"from callback",
		);
		const error = await connected.fs
			.watch("/missing", false, () => {})
			.then(
				() => null,
				(error: Error) => error,
			);
		expect(error?.message).toContain("does not exist");
	} finally {
		await connected.dispose();
		exposed.dispose();
		remote[Comlink.releaseProxy]();
	}
});

test("concurrent unsubscribe waits for in-flight delivery before releasing callbacks", async () => {
	const snapshot = await SnapshotFS.from(
		createFs(new Map([["/work/main.bal", ""]])),
		"/",
	);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const id = await snapshot.watch("/work", false, async () => {
		started.resolve();
		await release.promise;
	});
	try {
		await snapshot.writeFile("/work/first", "");
		await started.promise;
		let closed = false;
		const first = snapshot.unwatch(id);
		const second = snapshot.unwatch(id).then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await Promise.all([first, second]);
		expect(closed).toBe(true);
	} finally {
		release.resolve();
		snapshot.dispose();
	}
});

test("worker forwarding gate ignores late events even when unsubscribe fails", async () => {
	let callback: FSWatchCallback = () => {};
	const remote: WatchableFS = {
		...createFs(new Map()),
		async watch(_path, _recursive, handler) {
			callback = handler;
			return "1";
		},
		async unwatch() {
			throw new Error("transport failed");
		},
	};
	const connected = connectWatchableFS(remote);
	let count = 0;
	const id = await connected.fs.watch("/", true, () => {
		count++;
	});
	await callback({ path: "/first", op: "create" });
	await expect(connected.fs.unwatch(id)).rejects.toThrow("transport failed");
	await callback({ path: "/late", op: "create" });
	expect(count).toBe(1);
	await connected.dispose();
});

test("disposal disables callbacks during pending registration and cleans up its eventual ID", async () => {
	let callback: FSWatchCallback = () => {};
	const registration = Promise.withResolvers<string>();
	const removed: string[] = [];
	const remote: WatchableFS = {
		...createFs(new Map()),
		watch(_path, _recursive, handler) {
			callback = handler;
			return registration.promise;
		},
		async unwatch(id) {
			removed.push(id);
		},
	};
	const connected = connectWatchableFS(remote);
	let invoked = false;
	const watch = connected.fs.watch("/", true, () => {
		invoked = true;
	});
	await connected.dispose();
	await callback({ path: "/late", op: "create" });
	registration.resolve("late-registration");
	await expect(watch).rejects.toThrow("disposed");
	expect(invoked).toBe(false);
	expect(removed).toEqual(["late-registration"]);
});
