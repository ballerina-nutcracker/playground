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

// Examples that talk to live services print values we cannot pin down: which
// packages rank highest, their versions and their download counts all change
// upstream. Those fixtures use these placeholders instead of literal values,
// and everything around them still has to match exactly.
const outputPlaceholders: Record<string, string> = {
	"<number>": "\\d+",
	"<package>": "[\\w.]+\\/[\\w.]+:\\d+\\.\\d+\\.\\d+[\\w.+-]*",
};

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toExampleOutputPattern(expectedOutput: string) {
	const placeholder = /<number>|<package>/g;
	let pattern = "";
	let lastIndex = 0;

	for (const match of expectedOutput.matchAll(placeholder)) {
		pattern += escapeRegExp(expectedOutput.slice(lastIndex, match.index));
		pattern += outputPlaceholders[match[0]];
		lastIndex = match.index + match[0].length;
	}
	pattern += escapeRegExp(expectedOutput.slice(lastIndex));

	return new RegExp(`^${pattern}$`);
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

		// A fixture whose placeholders still cover the output is already correct,
		// so keep it rather than baking today's values back in.
		const existingOutput = await loadExampleOutput(manifestPath).catch(
			() => null,
		);
		if (
			existingOutput !== null &&
			toExampleOutputPattern(existingOutput).test(output)
		) {
			return;
		}

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
		.toMatch(toExampleOutputPattern(expectedOutput));
}
