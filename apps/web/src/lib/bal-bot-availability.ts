import { getBallerinaProjectTarget } from "@/lib/fs/project-target";

import type { FS } from "@/lib/fs/core/fs.interface";

export const NO_FILE_REASON = "No file open";
export const NO_PROJECT_REASON =
	"Not part of a Ballerina project (no Ballerina.toml)";

/**
 * Why bal-bot cannot open the project of `activePath`, or `null` when it can.
 * `getBallerinaProjectTarget` returns the path itself when no manifest is
 * found up the tree.
 */
export async function getBalBotDisabledReason(
	fs: FS,
	activePath: string | null | undefined,
): Promise<string | null> {
	if (!activePath) return NO_FILE_REASON;
	const projectDir = await getBallerinaProjectTarget(fs, activePath);
	return projectDir === activePath ? NO_PROJECT_REASON : null;
}

/**
 * Starts a check and reports its result unless the returned cancel function
 * ran first, so a slow check for an earlier path never overwrites a newer one.
 */
export function startBalBotCheck(
	fs: FS,
	activePath: string | null | undefined,
	onResult: (reason: string | null) => void,
): () => void {
	let cancelled = false;
	getBalBotDisabledReason(fs, activePath)
		.then((reason) => {
			if (!cancelled) onResult(reason);
		})
		.catch((cause) => {
			if (!cancelled)
				onResult(
					cause instanceof Error ? cause.message : "Could not check project",
				);
		});
	return () => {
		cancelled = true;
	};
}
