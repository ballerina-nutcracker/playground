import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { expect } from "@playwright/test";

import type { Locator } from "@playwright/test";

function getExampleOutputPath(manifestPath: string) {
	const examplePath = relative("/tmp/examples", dirname(manifestPath));
	return join(
		process.cwd(),
		"e2e",
		"fixtures",
		"examples",
		`${examplePath}.txt`,
	);
}

function normalizeExampleOutput(output: string) {
	return output.trimEnd().replace(/^time=\S+/gm, "time=<timestamp>");
}

async function loadExampleOutput(manifestPath: string) {
	return (await readFile(getExampleOutputPath(manifestPath), "utf8")).trimEnd();
}

export async function assertOrUpdateExampleOutput(
	outputPane: Locator,
	manifestPath: string,
) {
	if (process.env.UPDATE_EXAMPLE_OUTPUTS === "1") {
		const output = normalizeExampleOutput(await outputPane.innerText());
		const outputPath = getExampleOutputPath(manifestPath);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${output}\n`);
		return;
	}

	const expectedOutput = await loadExampleOutput(manifestPath);
	await expect
		.poll(async () => normalizeExampleOutput(await outputPane.innerText()), {
			timeout: 10_000,
		})
		.toBe(expectedOutput);
}
