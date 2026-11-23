import { LOCAL_ROOT, TEMP_ROOT } from "@/lib/fs/fs-roots";
import {
	LANGUAGE_SERVER_ROOT,
	languageServerPath,
} from "./language-server-uri";

import type { FileNode } from "@/lib/fs/core/file-node.types";
import type { LanguageServerFile } from "@/workers/language-server-worker-api";

/** Only saved trees belong in PAL. Active editor text travels via LSP. */
export function languageServerFiles(
	tempTree: FileNode[],
	localTree: FileNode[],
): LanguageServerFile[] {
	const entries: LanguageServerFile[] = [
		{ path: LANGUAGE_SERVER_ROOT, isDir: true },
	];
	function visit(nodes: FileNode[], parent: string) {
		for (const node of nodes) {
			const path = `${parent}/${node.name}`;
			if (node.kind === "dir") {
				entries.push({ path: languageServerPath(path), isDir: true });
				visit(node.children, path);
			} else {
				entries.push({
					path: languageServerPath(path),
					isDir: false,
					content: node.content,
				});
			}
		}
	}
	for (const [root, tree] of [
		[TEMP_ROOT, tempTree],
		[LOCAL_ROOT, localTree],
	] as const) {
		entries.push({ path: languageServerPath(root), isDir: true });
		visit(tree, root);
	}
	return entries;
}
