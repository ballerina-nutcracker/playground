import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { LocalStorageFS } from "../src/lib/fs/local-storage-fs";

const KEY = "bfs-test";
const store = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	},
});

afterAll(() => {
	if (original) Object.defineProperty(globalThis, "localStorage", original);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

beforeEach(() => store.clear());

const encode = (text: string) => new TextEncoder().encode(text);
const stored = () => JSON.parse(store.get(KEY) ?? "null");

describe("LocalStorageFS", () => {
	test("keeps binary content across a reload", async () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
		await new LocalStorageFS(KEY).writeFile("/local/b.bin", bytes);

		const file = await new LocalStorageFS(KEY).open("/local/b.bin");
		expect(file?.content).toEqual(bytes);
		expect(file?.size).toBe(4);
	});

	test("stores text as a string and other bytes as base64", async () => {
		const fs = new LocalStorageFS(KEY);
		await fs.writeFile("/local/a.bal", encode("héllo"));
		await fs.writeFile("/local/b.bin", new Uint8Array([0xff]));

		const files = stored().children.local.children;
		expect(files["a.bal"].content).toBe("héllo");
		expect(files["a.bal"].base64).toBeUndefined();
		expect(files["b.bin"].content).toBeUndefined();
		expect(files["b.bin"].base64).toBe("/w==");
	});

	test("keeps a leading BOM", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		await new LocalStorageFS(KEY).writeFile("/local/bom.txt", bytes);

		const file = await new LocalStorageFS(KEY).open("/local/bom.txt");
		expect(file?.content).toEqual(bytes);
	});

	test("loads storage written before files held bytes", async () => {
		store.set(
			KEY,
			JSON.stringify({
				isDir: true,
				children: {
					local: {
						isDir: true,
						children: {
							"main.bal": { isDir: false, content: "héllo", modTime: 1 },
						},
					},
				},
			}),
		);

		const file = await new LocalStorageFS(KEY).open("/local/main.bal");
		expect(file?.content).toEqual(encode("héllo"));
		expect(file?.size).toBe(6);
		expect(file?.modTime).toBe(1);
	});

	test("open returns a copy of the stored content", async () => {
		const fs = new LocalStorageFS(KEY);
		await fs.writeFile("/local/a.txt", encode("abc"));

		const first = await fs.open("/local/a.txt");
		first?.content.fill(0);

		expect((await fs.open("/local/a.txt"))?.content).toEqual(encode("abc"));
	});
});
