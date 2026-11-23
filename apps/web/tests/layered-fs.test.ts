import { beforeEach, describe, expect, test } from "bun:test";

import { EphemeralFS } from "../src/lib/fs/ephemeral-fs";
import { LayeredFS } from "../src/lib/fs/layered-fs";
import { LocalStorageFS } from "../src/lib/fs/local-storage-fs";
import { SnapshotFS } from "../src/lib/fs/snapshot";

function installLocalStorage() {
	const store = new Map<string, string>();
	globalThis.localStorage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key) => store.get(key) ?? null,
		key: (index) => [...store.keys()][index] ?? null,
		removeItem: (key) => {
			store.delete(key);
		},
		setItem: (key, value) => {
			store.set(key, String(value));
		},
	};
}

function createLayeredFs() {
	return new LayeredFS(
		new EphemeralFS(),
		new LocalStorageFS("layered-fs-test"),
	);
}

describe("LayeredFS.move", () => {
	beforeEach(installLocalStorage);

	test("keeps a file's modTime when moving from /local to /tmp", async () => {
		const fs = createLayeredFs();
		await fs.mkdirAll("/local/proj");
		await fs.writeFile("/local/proj/a.txt", "x", 1234);

		expect(await fs.move("/local/proj/a.txt", "/tmp/a.txt")).toBe(true);

		const moved = await fs.open("/tmp/a.txt");
		expect(moved?.content).toBe("x");
		expect(moved?.modTime).toBe(1234);
		expect(await fs.stat("/local/proj/a.txt")).toBeNull();
	});

	test("keeps a file's modTime when moving from /tmp to /local", async () => {
		const fs = createLayeredFs();
		await fs.mkdirAll("/tmp");
		await fs.mkdirAll("/local");
		await fs.writeFile("/tmp/a.txt", "x", 1234);

		expect(await fs.move("/tmp/a.txt", "/local/a.txt")).toBe(true);

		const moved = await fs.open("/local/a.txt");
		expect(moved?.content).toBe("x");
		expect(moved?.modTime).toBe(1234);
		expect(await fs.stat("/tmp/a.txt")).toBeNull();
	});

	test("keeps nested file modTimes when moving a directory", async () => {
		const fs = createLayeredFs();
		await fs.mkdirAll("/local/proj/sub");
		await fs.mkdirAll("/tmp");
		await fs.writeFile("/local/proj/sub/b.txt", "y", 5678);

		expect(await fs.move("/local/proj", "/tmp/proj")).toBe(true);

		expect((await fs.stat("/tmp/proj/sub/b.txt"))?.modTime).toBe(5678);
		expect(await fs.stat("/local/proj")).toBeNull();
	});

	test("matches the modTime SnapshotFS reports after the same move", async () => {
		const fs = createLayeredFs();
		await fs.mkdirAll("/local/proj");
		await fs.mkdirAll("/tmp");
		await fs.writeFile("/local/proj/a.txt", "x", 1234);
		const snapshot = await SnapshotFS.from(fs, "/local/proj");

		expect(await snapshot.move("/local/proj/a.txt", "/tmp/a.txt")).toBe(true);
		expect(await fs.move("/local/proj/a.txt", "/tmp/a.txt")).toBe(true);

		expect((await fs.stat("/tmp/a.txt"))?.modTime).toBe(
			(await snapshot.stat("/tmp/a.txt"))?.modTime as number,
		);
	});
});
