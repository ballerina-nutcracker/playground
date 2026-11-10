import { expect, test } from "bun:test";

import { cleanFSPath, FSWatchRegistry } from "../src/lib/fs/fs-watch-registry";
import { SnapshotFS } from "../src/lib/fs/snapshot";
import { createFs } from "./test-fs";

import type { FSWatchEvent } from "../src/lib/fs/fs-watch-registry";

async function snapshot() {
	return SnapshotFS.from(
		createFs(
			new Map([
				["/work/main.bal", ""],
				["/work/nested/existing.txt", "original"],
				["/workspace/other.txt", ""],
			]),
		),
		"/",
	);
}

function recorder() {
	const events: FSWatchEvent[] = [];
	let wake: (() => void) | undefined;
	return {
		events,
		callback(event: FSWatchEvent) {
			events.push(event);
			wake?.();
		},
		async waitFor(count: number) {
			while (events.length < count) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

test("snapshot watch reports successful mutations in order, including same-content writes", async () => {
	const fs = await snapshot();
	const log = recorder();
	const id = await fs.watch("/work", false, log.callback);
	try {
		expect(await fs.writeFile("/work/item.txt", "hello")).toBe(true);
		expect(await fs.writeFile("/work/item.txt", "hello")).toBe(true);
		expect(await fs.remove("/work/item.txt")).toBe(true);
		await log.waitFor(3);
		expect(log.events).toEqual([
			{ path: "/work/item.txt", op: "create" },
			{ path: "/work/item.txt", op: "modify" },
			{ path: "/work/item.txt", op: "delete" },
		]);
	} finally {
		await fs.unwatch(id);
		fs.dispose();
	}
});

test("recursive matching includes new directories, excludes sibling prefixes, and handles root", async () => {
	const fs = await snapshot();
	const recursive = recorder();
	const direct = recorder();
	const root = recorder();
	await fs.watch("/work/./nested/../", true, recursive.callback);
	await fs.watch("/work", false, direct.callback);
	await fs.watch("/", true, root.callback);
	try {
		await fs.mkdirAll("/work/new/deep");
		await fs.writeFile("/work/new/deep/file.txt", "");
		await fs.writeFile("/workspace/other.txt", "changed");
		await fs.writeFile("/work/done", "");
		await Promise.all([
			recursive.waitFor(4),
			direct.waitFor(2),
			root.waitFor(5),
		]);
		expect(recursive.events).toEqual([
			{ path: "/work/new", op: "create" },
			{ path: "/work/new/deep", op: "create" },
			{ path: "/work/new/deep/file.txt", op: "create" },
			{ path: "/work/done", op: "create" },
		]);
		expect(direct.events).toEqual([recursive.events[0], recursive.events[3]]);
		expect(root.events).toContainEqual({
			path: "/workspace/other.txt",
			op: "modify",
		});
	} finally {
		fs.dispose();
	}
});

test("failed operations and no-ops emit nothing and leave the snapshot intact", async () => {
	const fs = await snapshot();
	const log = recorder();
	await fs.watch("/work", true, log.callback);
	try {
		expect(await fs.writeFile("/work/missing/file", "")).toBe(false);
		expect(await fs.writeFile("/work/nested", "")).toBe(false);
		expect(await fs.mkdirAll("/work/main.bal/child")).toBe(false);
		expect(await fs.mkdirAll("/work/nested")).toBe(true);
		expect(await fs.remove("/work/missing")).toBe(false);
		expect(await fs.remove("/")).toBe(false);
		expect(await fs.move("/work/nested", "/work/nested/child")).toBe(false);
		expect(await fs.move("/work/nested", "/work/main.bal")).toBe(false);
		expect(await fs.move("/work/nested", "/missing/new")).toBe(false);
		expect(await fs.move("/work/nested", "/work/nested")).toBe(true);
		expect((await fs.open("/work/nested/existing.txt"))?.content).toBe(
			"original",
		);
		await fs.writeFile("/work/done", "");
		await log.waitFor(1);
		expect(log.events).toEqual([{ path: "/work/done", op: "create" }]);
	} finally {
		fs.dispose();
	}
});

test("subtree moves and deletion commit atomically with deterministic events", async () => {
	const fs = await snapshot();
	const log = recorder();
	await fs.watch("/work", true, log.callback);
	try {
		expect(await fs.move("/work/nested", "/work/renamed")).toBe(true);
		expect(await fs.stat("/work/nested")).toBeNull();
		expect((await fs.open("/work/renamed/existing.txt"))?.content).toBe(
			"original",
		);
		expect(await fs.remove("/work/renamed")).toBe(true);
		await log.waitFor(6);
		expect(log.events).toEqual([
			{ path: "/work/nested/existing.txt", op: "delete" },
			{ path: "/work/nested", op: "delete" },
			{ path: "/work/renamed", op: "create" },
			{ path: "/work/renamed/existing.txt", op: "create" },
			{ path: "/work/renamed/existing.txt", op: "delete" },
			{ path: "/work/renamed", op: "delete" },
		]);
	} finally {
		fs.dispose();
	}
});

test("registration validates directories and disposal prevents reuse", async () => {
	const fs = await snapshot();
	await expect(fs.watch("/missing", false, () => {})).rejects.toThrow(
		"does not exist",
	);
	await expect(fs.watch("/work/main.bal", false, () => {})).rejects.toThrow(
		"not a directory",
	);
	fs.dispose();
	await expect(fs.watch("/work", false, () => {})).rejects.toThrow("disposed");
});

test("unwatch is idempotent, discards pending events, and isolates other subscriptions", async () => {
	const fs = await snapshot();
	const stopped = recorder();
	const live = recorder();
	const id = await fs.watch("/work", false, stopped.callback);
	await fs.watch("/work", false, live.callback);
	try {
		const write = fs.writeFile("/work/first", "");
		const close = fs.unwatch(id);
		await Promise.all([write, close, fs.unwatch(id)]);
		await fs.writeFile("/work/second", "");
		await live.waitFor(2);
		expect(stopped.events).toEqual([]);
	} finally {
		fs.dispose();
	}
});

test("watch callbacks can write without blocking the mutation or other listeners", async () => {
	const fs = await snapshot();
	const log = recorder();
	await fs.watch("/work", false, async (event) => {
		if ("path" in event && event.path === "/work/first") {
			await fs.writeFile("/work/second", "from callback");
		}
	});
	await fs.watch("/work", false, log.callback);
	try {
		await fs.writeFile("/work/first", "");
		await log.waitFor(2);
		expect((await fs.open("/work/second"))?.content).toBe("from callback");
	} finally {
		fs.dispose();
	}
});

test("slow callbacks retain bulk mutations until they can be delivered", async () => {
	const registry = new FSWatchRegistry();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const log = recorder();
	registry.watch("/work", true, async (event) => {
		log.callback(event);
		if (log.events.length === 1) {
			started.resolve();
			await release.promise;
		}
	});
	try {
		registry.publish({ path: "/work/first", op: "create" });
		await started.promise;
		for (let i = 0; i < 300; i++) {
			registry.publish({ path: `/work/${i}`, op: "create" });
		}
		expect(log.events).toHaveLength(1);
		release.resolve();
		await log.waitFor(301);
		expect(log.events).toHaveLength(301);
	} finally {
		release.resolve();
		registry.dispose();
	}
});

test("removing the watched root reports its deletion and stops its subscription", async () => {
	const fs = await snapshot();
	const log = recorder();
	await fs.watch("/work/nested", true, log.callback);
	try {
		await fs.remove("/work/nested");
		await log.waitFor(2);
		await fs.mkdirAll("/work/nested");
		await fs.writeFile("/work/nested/ignored", "");
		expect(log.events).toEqual([
			{ path: "/work/nested/existing.txt", op: "delete" },
			{ path: "/work/nested", op: "delete" },
		]);
	} finally {
		fs.dispose();
	}
});

test("a callback can await its own unwatch", async () => {
	const fs = await snapshot();
	const unwatched = Promise.withResolvers<void>();
	let id = "";
	id = await fs.watch("/work", false, async () => {
		await fs.unwatch(id);
		unwatched.resolve();
	});
	try {
		await fs.writeFile("/work/file", "");
		await Promise.race([
			unwatched.promise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("unwatch timed out")), 100),
			),
		]);
	} finally {
		fs.dispose();
	}
});

test("callback rejection does not reject a committed write", async () => {
	const fs = await snapshot();
	const failed = Promise.withResolvers<void>();
	await fs.watch("/work", false, async () => {
		failed.resolve();
		throw new Error("consumer disconnected");
	});
	try {
		expect(await fs.writeFile("/work/saved", "value")).toBe(true);
		await failed.promise;
		expect((await fs.open("/work/saved"))?.content).toBe("value");
	} finally {
		fs.dispose();
	}
});

test("watch path normalization follows POSIX lexical rules", () => {
	expect(cleanFSPath("/work//a/.././b/")).toBe("/work/b");
	expect(cleanFSPath("/../../")).toBe("/");
	expect(cleanFSPath("a/../../b")).toBe("../b");
});
