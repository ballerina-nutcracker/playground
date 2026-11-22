import { describe, expect, test } from "bun:test";

import { SnapshotFS, type SnapshotFSMutation } from "../src/lib/fs/snapshot";
import { createFs } from "./test-fs";

async function createSnapshot() {
	const source = createFs(new Map([["/tmp/proj/main.bal", "// main"]]));
	const snapshot = await SnapshotFS.from(source, "/tmp/proj");
	const mutations: SnapshotFSMutation[] = [];
	snapshot.onMutation((mutation) => mutations.push(mutation));
	return { snapshot, mutations };
}

describe("SnapshotFS.writeFile", () => {
	test("emits the stored modTime when none is given", async () => {
		const { snapshot, mutations } = await createSnapshot();

		expect(await snapshot.writeFile("/tmp/proj/a.txt", "x")).toBe(true);

		const stat = await snapshot.stat("/tmp/proj/a.txt");
		expect(mutations).toEqual([
			{
				type: "writeFile",
				path: "/tmp/proj/a.txt",
				content: "x",
				modTime: stat?.modTime as number,
			},
		]);
	});

	test("emits the explicit modTime when one is given", async () => {
		const { snapshot, mutations } = await createSnapshot();

		expect(await snapshot.writeFile("/tmp/proj/a.txt", "x", 1234)).toBe(true);

		expect((await snapshot.stat("/tmp/proj/a.txt"))?.modTime).toBe(1234);
		expect(mutations).toEqual([
			{
				type: "writeFile",
				path: "/tmp/proj/a.txt",
				content: "x",
				modTime: 1234,
			},
		]);
	});
});

describe("SnapshotFS.move", () => {
	test("rejects moving the root", async () => {
		const { snapshot, mutations } = await createSnapshot();

		expect(await snapshot.move("/", "/tmp/moved")).toBe(false);

		expect(await snapshot.stat("/")).not.toBeNull();
		expect(await snapshot.stat("/tmp/moved")).toBeNull();
		expect(await snapshot.open("/tmp/proj/main.bal")).not.toBeNull();
		expect(mutations).toEqual([]);
	});

	test("treats moving the root onto itself as a no-op", async () => {
		const { snapshot, mutations } = await createSnapshot();

		expect(await snapshot.move("/", "/")).toBe(true);
		expect(mutations).toEqual([]);
	});

	test("moves a directory with its descendants", async () => {
		const { snapshot, mutations } = await createSnapshot();

		expect(await snapshot.move("/tmp/proj", "/tmp/moved")).toBe(true);

		expect(await snapshot.stat("/tmp/proj")).toBeNull();
		expect((await snapshot.open("/tmp/moved/main.bal"))?.content).toBe(
			"// main",
		);
		expect(mutations).toEqual([
			{ type: "move", oldPath: "/tmp/proj", newPath: "/tmp/moved" },
		]);
	});
});
