import { expect, test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

test("shows files written by a running program in the sidebar", async ({
	page,
}) => {
	const playground = new PlaygroundPage(page);
	const writerCode = await loadFixture("write-file.bal");
	const packageName = `e2e_runtime_files_${Date.now()}`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.replaceEditorContent(writerCode);
	await playground.runAndExpectOutput("file written");

	await expect(page.getByText("generated", { exact: true })).toBeVisible();
	await expect(
		page.getByText("runtime-file.txt", { exact: true }),
	).toBeVisible();
});

test("round-trips binary file contents", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	const code = await loadFixture("binary-file.bal");
	const packageName = `e2e_binary_file_${Date.now()}`;

	await playground.open();
	await playground.createPackage(packageName);
	await playground.replaceEditorContent(code);
	// The output pane pretty-prints JSON, so the byte array spans lines.
	await playground.runAndExpectOutput(
		JSON.stringify([0xff, 0xfe, 0x00, 0x80], null, 2),
	);
});
