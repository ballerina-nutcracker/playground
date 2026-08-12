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

// Examples that talk to live services, or print timestamps, produce values we
// cannot pin down: which packages rank highest, their versions and their
// download counts all change upstream, and log timestamps change every run.
// Those fixtures use these placeholders instead of literal values, and
// everything around them still has to match exactly.
const outputPlaceholders: Record<string, string> = {
	"<number>": "\\d+",
	"<package>": "[\\w.]+\\/[\\w.]+:\\d+\\.\\d+\\.\\d+[\\w.+-]*",
	"<timestamp>": "\\S+",
};

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Timestamps differ on every run, so a freshly written fixture must store the
// <timestamp> placeholder rather than today's literal value.
function canonicalizeExampleOutput(output: string) {
	return output.replace(/^time=\S+/gm, "time=<timestamp>");
}

function toExampleOutputPattern(expectedOutput: string) {
	const placeholder = /<number>|<package>|<timestamp>/g;
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
		const output = (await outputPane.innerText()).trimEnd();

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
		await writeFile(outputPath, `${canonicalizeExampleOutput(output)}\n`);
		return;
	}

	const expectedOutput = await loadExampleOutput(manifestPath);
	await expect
		.poll(async () => (await outputPane.innerText()).trimEnd(), {
			timeout: 10_000,
		})
		.toMatch(toExampleOutputPattern(expectedOutput));
}
