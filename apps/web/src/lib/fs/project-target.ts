import { dirname, ext, isRootPath, join } from "@/lib/fs/core/path-utils";

import type { FS } from "@/lib/fs/core/fs.interface";

export async function getBallerinaProjectTarget(
	fs: FS,
	path: string,
): Promise<string> {
	let currentDir = dirname(path);
	const hasRootPrefix = path.startsWith("/");

	while (!isRootPath(currentDir)) {
		const dirPath =
			hasRootPrefix && !currentDir.startsWith("/")
				? `/${currentDir}`
				: currentDir;
		const tomlPath = join(dirPath, "Ballerina.toml");
		if (await fs.stat(tomlPath)) return dirPath;
		currentDir = dirname(currentDir);
	}

	return path;
}

const SNAPSHOT_EXTENSIONS = new Set(["bal", "toml", "md"]);
const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function relativeTo(root: string, path: string): string {
	const base = root.replace(/\/+$/, "");
	if (!path.startsWith(`${base}/`)) {
		throw new Error(`${path}: not inside project directory ${root}`);
	}
	return path.slice(base.length + 1);
}

// Mirrors the checks bal-bot's workspace runs on its files, but names the
// offending path. Kept local so the Run path never imports bal-bot code.
function validateSnapshot(files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		if (
			!path ||
			path.startsWith("/") ||
			/^[A-Za-z]:/.test(path) ||
			path.includes("\\") ||
			path.split("/").some((part) => !part || part === "." || part === "..") ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors bal-bot's path validation
			/[\x00-\x1f]/.test(path)
		) {
			throw new Error(`${path}: invalid workspace file path`);
		}
		if (LONE_SURROGATE.test(content)) {
			throw new Error(`${path}: file contents must be valid UTF-8 text`);
		}
		const parts = path.split("/").slice(0, -1);
		for (let i = 0; i < parts.length; i++) {
			const dir = parts.slice(0, i + 1).join("/");
			if (Object.hasOwn(files, dir)) {
				throw new Error(
					`${path}: conflicts with file ${dir} used as a directory`,
				);
			}
		}
	}
}

/**
 * Reads the `.bal`/`.toml`/`.md` files under `projectDir` into a map keyed by
 * project-relative path. Dot-directories and `target/` are skipped. Throws an
 * Error naming the path of anything unreadable or invalid.
 */
export async function readBallerinaProjectFiles(
	fs: FS,
	projectDir: string,
): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const root = projectDir.replace(/\/+$/, "") || projectDir;

	async function walk(dir: string): Promise<void> {
		const entries = await fs.readDir(dir);
		if (!entries) throw new Error(`${dir}: could not read directory`);
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDir) {
				if (entry.name.startsWith(".") || entry.name === "target") continue;
				await walk(path);
			} else if (SNAPSHOT_EXTENSIONS.has(ext(path))) {
				const file = await fs.open(path);
				if (!file) throw new Error(`${path}: could not read file`);
				files[relativeTo(root, path)] = file.content;
			}
		}
	}

	await walk(root);
	validateSnapshot(files);
	return files;
}

export type ProjectFileChange =
	| { kind: "write"; path: string; content: string }
	| { kind: "delete"; path: string };

/**
 * Lists the writes and deletes that turn the project-relative snapshot `prev`
 * into `next`, as absolute paths under `projectDir`. Deletes come first so a
 * file replaced by a directory of the same name can be written.
 */
export function diffProjectFiles(
	projectDir: string,
	prev: Record<string, string>,
	next: Record<string, string>,
): ProjectFileChange[] {
	const changes: ProjectFileChange[] = [];
	for (const path of Object.keys(prev)) {
		if (!Object.hasOwn(next, path))
			changes.push({ kind: "delete", path: join(projectDir, path) });
	}
	for (const [path, content] of Object.entries(next)) {
		if (prev[path] !== content)
			changes.push({ kind: "write", path: join(projectDir, path), content });
	}
	return changes;
}
