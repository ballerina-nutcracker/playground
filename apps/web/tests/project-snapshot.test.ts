import { describe, expect, test } from "bun:test";

import { createFs } from "./test-fs";

const { readBallerinaProjectFiles } = await import(
	"../src/lib/fs/project-target.ts?snapshot"
);

const project = (extra: Record<string, string> = {}) =>
	createFs(
		new Map(
			Object.entries({
				"/p/Ballerina.toml": "[package]",
				"/p/main.bal": "main",
				"/p/README.md": "# hi",
				"/p/modules/util/util.bal": "util",
				"/p/image.png": "binary",
				"/p/notes.txt": "text",
				"/p/.git/config.toml": "ignored",
				"/p/target/out.bal": "ignored",
				"/p/modules/.hidden/x.bal": "ignored",
				"/other/main.bal": "other project",
				...extra,
			}),
		),
	);

describe("readBallerinaProjectFiles", () => {
	test("returns project-relative .bal/.toml/.md files only", async () => {
		expect(await readBallerinaProjectFiles(project(), "/p")).toEqual({
			"Ballerina.toml": "[package]",
			"main.bal": "main",
			"README.md": "# hi",
			"modules/util/util.bal": "util",
		});
	});

	test("tolerates a trailing slash on the project directory", async () => {
		const files = await readBallerinaProjectFiles(project(), "/p/");
		expect(Object.keys(files)).toContain("main.bal");
	});

	test("throws naming the directory when readDir returns null", async () => {
		await expect(
			readBallerinaProjectFiles(project(), "/missing"),
		).rejects.toThrow("/missing");
	});

	test("throws naming the file when open returns null", async () => {
		const fs = project();
		const open = fs.open;
		fs.open = async (path: string) =>
			path === "/p/main.bal" ? null : open(path);
		await expect(readBallerinaProjectFiles(fs, "/p")).rejects.toThrow(
			"/p/main.bal",
		);
	});

	test("throws naming a nested directory that cannot be read", async () => {
		const fs = project();
		const readDir = fs.readDir;
		fs.readDir = async (path: string) =>
			path === "/p/modules/util" ? null : readDir(path);
		await expect(readBallerinaProjectFiles(fs, "/p")).rejects.toThrow(
			"/p/modules/util",
		);
	});

	test("rejects an invalid path naming it", async () => {
		const fs = project({ "/p/bad\u0001name.bal": "x" });
		await expect(readBallerinaProjectFiles(fs, "/p")).rejects.toThrow(
			"bad\u0001name.bal",
		);
	});

	test("rejects invalid UTF-8 naming the file", async () => {
		const fs = project({ "/p/broken.bal": "a\uD800b" });
		await expect(readBallerinaProjectFiles(fs, "/p")).rejects.toThrow(
			"broken.bal",
		);
	});

	test("rejects a file used as a directory naming the path", async () => {
		const fs = project();
		const readDir = fs.readDir;
		fs.readDir = async (path: string) =>
			path === "/p"
				? [
						{ name: "a.bal", isDir: false },
						{ name: "a.bal", isDir: true },
					]
				: path === "/p/a.bal"
					? [{ name: "b.bal", isDir: false }]
					: readDir(path);
		const open = fs.open;
		fs.open = async (path: string) =>
			path === "/p/a.bal" || path === "/p/a.bal/b.bal"
				? { content: "x", size: 1, modTime: 0, isDir: false }
				: open(path);
		await expect(readBallerinaProjectFiles(fs, "/p")).rejects.toThrow(
			"a.bal/b.bal",
		);
	});
});
